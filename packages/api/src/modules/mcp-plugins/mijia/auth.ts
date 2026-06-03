import { randomBytes } from "node:crypto"
import {
  CookieJar,
  MijiaTimeoutError,
  fetchWithCookies,
  fetchWithTimeout,
  parsePrefixedJson,
} from "./http.js"
import type {
  JsonObject,
  MijiaAuthState,
  MijiaQrLoginProgress,
  MijiaQrLoginStartResult,
} from "./types.js"

const MIJIA_APP_BASE_URL = "https://api.mijia.tech/app"
const MIJIA_QR_URL = "https://account.xiaomi.com/longPolling/loginUrl"
const MIJIA_SERVICE_LOGIN_URL = "https://account.xiaomi.com/pass/serviceLogin"
const DEFAULT_QR_TTL_MS = 10 * 60_000
// Xiaomi service tokens are long-lived; we treat a fresh login OR a successful
// refresh as good for 30 days and extend expireTime accordingly. The
// resolve-time refresh (ensureFreshPluginConnection) fires within 60s of this,
// so without extending it on refresh the connection would re-refresh on every
// resolve and eventually be marked expired.
const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1_000
const SERVICE_TOKEN_COOKIE_NAME = "serviceToken"
const YET_ANOTHER_SERVICE_TOKEN = "yetAnotherServiceToken"

function randomFromAlphabet(length: number, alphabet: string) {
  const bytes = randomBytes(length)
  let result = ""
  for (let index = 0; index < length; index += 1) {
    result += alphabet[bytes[index]! % alphabet.length]!
  }
  return result
}

export function normalizeMijiaLocale(value: unknown) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return "zh_CN"
  }

  const normalized = value.trim().replace("-", "_")
  const parts = normalized.split("_")
  if (parts.length !== 2) {
    return normalized.startsWith("en") ? "en_US" : "zh_CN"
  }
  return `${parts[0]!.toLowerCase()}_${parts[1]!.toUpperCase()}`
}

function countryCodeFromLocale(locale: string) {
  return locale.split("_")[1] || "CN"
}

function generatePassO() {
  return randomFromAlphabet(16, "0123456789abcdef")
}

function generateDeviceId() {
  return randomFromAlphabet(
    16,
    "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_-"
  )
}

function generateUserAgent(locale: string, passO: string) {
  const id1 = randomFromAlphabet(40, "0123456789ABCDEF")
  const id2 = randomFromAlphabet(32, "0123456789ABCDEF")
  const id3 = randomFromAlphabet(32, "0123456789ABCDEF")
  const id4 = randomFromAlphabet(40, "0123456789ABCDEF")
  const country = countryCodeFromLocale(locale)
  return `Android-15-11.0.701-Xiaomi-23046RP50C-OS2.0.212.0.VMYCNXM-${id1}-${country}-${id3}-${id2}-SmartHome-MI_APP_STORE-${id1}|${id4}|${passO}-64`
}

function buildTimezoneCookieValues() {
  const now = new Date()
  const offsetMinutes = -now.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? "+" : "-"
  const absoluteMinutes = Math.abs(offsetMinutes)
  const hours = String(Math.floor(absoluteMinutes / 60)).padStart(2, "0")
  const minutes = String(absoluteMinutes % 60).padStart(2, "0")

  const january = new Date(now.getFullYear(), 0, 1)
  const july = new Date(now.getFullYear(), 6, 1)
  const maxOffset = Math.max(
    january.getTimezoneOffset(),
    july.getTimezoneOffset()
  )
  const isDaylight = now.getTimezoneOffset() < maxOffset

  return {
    timezoneId:
      Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai",
    timezone: `GMT${sign}${hours}:${minutes}`,
    isDaylight,
    dstOffset: isDaylight ? 3_600_000 : 0,
  }
}

function buildServiceLoginUrl(locale: string) {
  const url = new URL(MIJIA_SERVICE_LOGIN_URL)
  url.searchParams.set("_json", "true")
  url.searchParams.set("sid", "mijia")
  url.searchParams.set("_locale", locale)
  return url
}

function buildServiceLoginHeaders(input: {
  locale: string
  userAgent: string
  deviceId: string
  passO: string
  passToken?: string
  userId?: string
  cUserId?: string
}) {
  const cookieParts = [
    `deviceId=${input.deviceId}`,
    `pass_o=${input.passO}`,
    `passToken=${input.passToken || ""}`,
    `userId=${input.userId || ""}`,
    `cUserId=${input.cUserId || ""}`,
    `uLocale=${input.locale}`,
  ]

  return {
    "User-Agent": input.userAgent,
    Connection: "keep-alive",
    "Accept-Encoding": "gzip",
    "Content-Type": "application/x-www-form-urlencoded",
    Cookie: `${cookieParts.join(";")};`,
  }
}

function buildApiCookieJar(state: MijiaAuthState) {
  const timezone = buildTimezoneCookieValues()
  return new CookieJar({
    cUserId: state.cUserId,
    [YET_ANOTHER_SERVICE_TOKEN]:
      state.yetAnotherServiceToken || state.serviceToken,
    [SERVICE_TOKEN_COOKIE_NAME]: state.serviceToken,
    timezone_id: timezone.timezoneId,
    timezone: timezone.timezone,
    is_daylight: timezone.isDaylight ? "1" : "0",
    dst_offset: String(timezone.dstOffset),
    channel: "MI_APP_STORE",
    countryCode: countryCodeFromLocale(state.locale),
    PassportDeviceId: state.deviceId,
    locale: state.locale,
  })
}

function requireStringField(
  object: JsonObject,
  key: string,
  errorMessage: string
) {
  const value = object[key]
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(errorMessage)
  }
  return value
}

function readStringField(object: JsonObject, key: string) {
  const value = object[key]
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined
}

function buildCookieLookup(jar: CookieJar): JsonObject {
  const keys = [
    "passToken",
    "userId",
    "cUserId",
    "psecurity",
    "nonce",
    "ssecurity",
  ]
  const lookup: JsonObject = {}
  for (const key of keys) {
    const value = jar.get(key)
    if (typeof value === "string" && value.trim().length > 0) {
      lookup[key] = value.trim()
    }
  }
  return lookup
}

function readAuthFieldFromSources(
  sources: JsonObject[],
  key: string,
  errorMessage: string,
  options?: { required?: boolean }
) {
  for (const source of sources) {
    const value = readStringField(source, key)
    if (value) {
      return value
    }
  }

  if (options?.required === false) {
    return undefined
  }

  throw new Error(errorMessage)
}

async function readServiceLoginData(
  locale: string,
  authState: Pick<
    MijiaAuthState,
    "userAgent" | "deviceId" | "passO" | "passToken" | "userId" | "cUserId"
  >
) {
  const response = await fetchWithTimeout(buildServiceLoginUrl(locale), {
    method: "GET",
    headers: buildServiceLoginHeaders({
      locale,
      userAgent: authState.userAgent,
      deviceId: authState.deviceId,
      passO: authState.passO,
      passToken: authState.passToken,
      userId: authState.userId,
      cUserId: authState.cUserId,
    }),
    timeoutMs: 5_000,
  })
  if (!response.ok) {
    throw new Error(`Mijia auth bootstrap failed with HTTP ${response.status}`)
  }
  return parsePrefixedJson(await response.text())
}

function parseLocationQuery(location: string) {
  const url = new URL(location)
  const query: Record<string, string> = {}
  for (const [key, value] of url.searchParams.entries()) {
    query[key] = value
  }
  return query
}

export async function startMijiaQrLoginSession(input: {
  locale?: unknown
}): Promise<MijiaQrLoginStartResult> {
  const locale = normalizeMijiaLocale(input.locale)
  const passO = generatePassO()
  const deviceId = generateDeviceId()
  const userAgent = generateUserAgent(locale, passO)

  const serviceData = await readServiceLoginData(locale, {
    userAgent,
    deviceId,
    passO,
  })
  const location = requireStringField(
    serviceData,
    "location",
    "Mijia auth bootstrap did not return a login location."
  )

  const loginQuery = parseLocationQuery(location)
  loginQuery.theme = ""
  loginQuery.bizDeviceType = ""
  loginQuery._hasLogo = "false"
  loginQuery._qrsize = "240"
  loginQuery._dc = String(Date.now())

  const loginUrl = new URL(MIJIA_QR_URL)
  for (const [key, value] of Object.entries(loginQuery)) {
    loginUrl.searchParams.set(key, value)
  }

  const loginResponse = await fetchWithTimeout(loginUrl, {
    method: "GET",
    headers: {
      "User-Agent": userAgent,
      "Accept-Encoding": "gzip",
      "Content-Type": "application/x-www-form-urlencoded",
      Connection: "keep-alive",
    },
    timeoutMs: 5_000,
  })

  if (!loginResponse.ok) {
    throw new Error(`Mijia QR request failed with HTTP ${loginResponse.status}`)
  }

  const loginData = parsePrefixedJson(await loginResponse.text())
  const qrUrl = requireStringField(
    loginData,
    "qr",
    "Mijia QR login did not return a QR image."
  )
  const scanUrl = requireStringField(
    loginData,
    "loginUrl",
    "Mijia QR login did not return a scan URL."
  )
  const lpUrl = requireStringField(
    loginData,
    "lp",
    "Mijia QR login did not return a polling URL."
  )

  const expiresAt = new Date(Date.now() + DEFAULT_QR_TTL_MS).toISOString()

  return {
    challengePayload: {
      kind: "qr_code",
      qrUrl,
      expiresAt,
      metadata: {
        scanUrl,
      },
    },
    transientPayload: {
      mijia: {
        locale,
        userAgent,
        deviceId,
        passO,
        lpUrl,
        scanUrl,
      },
    },
    expiresAt,
  }
}

function isTimeoutLikeError(error: unknown) {
  return (
    error instanceof MijiaTimeoutError ||
    (error instanceof Error && error.message.trim().toLowerCase() === "timeout")
  )
}

function classifyLoginFailure(message: string): MijiaQrLoginProgress {
  const lower = message.toLowerCase()
  if (lower.includes("expired")) {
    return {
      status: "expired",
      errorCode: "MIJIA_QR_EXPIRED",
      errorMessage: message,
    }
  }
  if (lower.includes("cancel") || lower.includes("reject")) {
    return {
      status: "failed",
      errorCode: "MIJIA_QR_REJECTED",
      errorMessage: message,
    }
  }
  return {
    status: "pending",
    phase: "pending_scan",
  }
}

export async function progressMijiaQrLoginSession(input: {
  transientPayload: JsonObject
  timeoutMs?: number
}): Promise<MijiaQrLoginProgress> {
  const payload = input.transientPayload
  const locale = normalizeMijiaLocale(payload.locale)
  const userAgent = requireStringField(
    payload,
    "userAgent",
    "Mijia auth session is missing a user agent."
  )
  const deviceId = requireStringField(
    payload,
    "deviceId",
    "Mijia auth session is missing a device ID."
  )
  const passO = requireStringField(
    payload,
    "passO",
    "Mijia auth session is missing pass_o."
  )
  const lpUrl = requireStringField(
    payload,
    "lpUrl",
    "Mijia auth session is missing its polling URL."
  )

  const jar = new CookieJar()
  let lpResponse: Response
  try {
    lpResponse = await fetchWithCookies(
      lpUrl,
      {
        method: "GET",
        headers: {
          "User-Agent": userAgent,
          "Accept-Encoding": "gzip",
          "Content-Type": "application/x-www-form-urlencoded",
          Connection: "keep-alive",
        },
        timeoutMs: input.timeoutMs ?? 1_200,
      },
      jar
    )
  } catch (error) {
    if (isTimeoutLikeError(error)) {
      return {
        status: "pending",
        phase: "pending_scan",
      }
    }
    throw error
  }

  if (!lpResponse.ok) {
    return classifyLoginFailure(
      `Mijia login polling failed with HTTP ${lpResponse.status}`
    )
  }

  const lpData = parsePrefixedJson(await lpResponse.text())
  if (typeof lpData.code === "number" && lpData.code !== 0) {
    return classifyLoginFailure(
      typeof lpData.desc === "string" && lpData.desc.trim().length > 0
        ? lpData.desc
        : `Mijia login returned code ${lpData.code}`
    )
  }

  const callbackUrl = requireStringField(
    lpData,
    "location",
    "Mijia login polling completed without a callback URL."
  )

  const callbackResponse = await fetchWithCookies(
    callbackUrl,
    {
      method: "GET",
      headers: {
        "User-Agent": userAgent,
        Connection: "keep-alive",
        "Accept-Encoding": "identity",
      },
      timeoutMs: 5_000,
    },
    jar
  )

  if (!callbackResponse.ok) {
    throw new Error(
      `Mijia auth callback failed with HTTP ${callbackResponse.status}`
    )
  }

  const serviceToken =
    jar.get(SERVICE_TOKEN_COOKIE_NAME) || jar.get(YET_ANOTHER_SERVICE_TOKEN)
  if (!serviceToken) {
    throw new Error("Mijia auth callback did not return a service token.")
  }

  const callbackQuery = parseLocationQuery(callbackUrl)
  const callbackResponseQuery =
    typeof callbackResponse.url === "string" && callbackResponse.url.length > 0
      ? parseLocationQuery(callbackResponse.url)
      : {}
  const authFieldSources = [
    lpData,
    callbackQuery,
    callbackResponseQuery,
    buildCookieLookup(jar),
  ]

  const authState: MijiaAuthState = {
    locale,
    deviceId,
    passO,
    userAgent,
    psecurity: readAuthFieldFromSources(
      authFieldSources,
      "psecurity",
      "Mijia login is missing psecurity.",
      { required: false }
    ),
    nonce: readAuthFieldFromSources(
      authFieldSources,
      "nonce",
      "Mijia login is missing nonce.",
      { required: false }
    ),
    ssecurity: readAuthFieldFromSources(
      authFieldSources,
      "ssecurity",
      "Mijia login is missing ssecurity."
    ),
    passToken: readAuthFieldFromSources(
      authFieldSources,
      "passToken",
      "Mijia login is missing passToken."
    ),
    userId: readAuthFieldFromSources(
      authFieldSources,
      "userId",
      "Mijia login is missing userId."
    ),
    cUserId: readAuthFieldFromSources(
      authFieldSources,
      "cUserId",
      "Mijia login is missing cUserId."
    ),
    serviceToken,
    yetAnotherServiceToken: jar.get(YET_ANOTHER_SERVICE_TOKEN) || serviceToken,
    expireTime: Date.now() + SESSION_LIFETIME_MS,
    saveTime: Date.now(),
  }

  return {
    status: "completed",
    authState,
  }
}

export async function refreshMijiaSessionTokens(authState: MijiaAuthState) {
  if (!authState.passToken || !authState.userId || !authState.cUserId) {
    throw new Error(
      "Mijia session cannot be refreshed without passToken, userId, and cUserId."
    )
  }

  const serviceData = await readServiceLoginData(authState.locale, authState)
  const location = serviceData.location
  if (
    typeof serviceData.code !== "number" ||
    serviceData.code !== 0 ||
    typeof location !== "string"
  ) {
    throw new Error(
      typeof serviceData.desc === "string" && serviceData.desc.trim().length > 0
        ? serviceData.desc
        : "Mijia token refresh requires a new login."
    )
  }

  const jar = buildApiCookieJar(authState)
  const callbackResponse = await fetchWithCookies(
    location,
    {
      method: "GET",
      headers: {
        "User-Agent": authState.userAgent,
        Connection: "keep-alive",
        "Accept-Encoding": "identity",
      },
      timeoutMs: 5_000,
    },
    jar
  )

  if (!callbackResponse.ok) {
    throw new Error(
      `Mijia token refresh failed with HTTP ${callbackResponse.status}`
    )
  }

  const refreshedToken =
    jar.get(SERVICE_TOKEN_COOKIE_NAME) || jar.get(YET_ANOTHER_SERVICE_TOKEN)
  if (!refreshedToken) {
    throw new Error("Mijia token refresh did not return a new service token.")
  }

  return {
    ...authState,
    serviceToken: refreshedToken,
    yetAnotherServiceToken:
      jar.get(YET_ANOTHER_SERVICE_TOKEN) || refreshedToken,
    ssecurity:
      typeof serviceData.ssecurity === "string" &&
      serviceData.ssecurity.trim().length > 0
        ? serviceData.ssecurity
        : authState.ssecurity,
    // Extend the lifetime on successful refresh; otherwise the stale expireTime
    // keeps the connection perpetually within the refresh window.
    expireTime: Date.now() + SESSION_LIFETIME_MS,
    saveTime: Date.now(),
  } satisfies MijiaAuthState
}

export function getMijiaAppBaseUrl() {
  return MIJIA_APP_BASE_URL
}

/**
 * Serialize the internal MijiaAuthState into the canonical auth dict that the
 * upstream mijiaAPI (and the mijia-mcp sidecar) expects.
 *
 * The internal state uses `userAgent`/`passO`; mijiaAPI's `available` check and
 * request signing hard-require `ua`/`pass_o` (plus userId/cUserId/serviceToken/
 * ssecurity). We map field names without mutating the stored state so that
 * refreshMijiaSessionTokens (which reads the internal shape) keeps working.
 *
 * This is registered as the auth-secret serializer for the `mijia_qr_login`
 * driver, so `${auth_b64:mijiaAccount}` in the seed entryPoint base64-encodes
 * THIS shape rather than the raw internal state.
 */
export function serializeMijiaAuthForMiot(
  state: Record<string, unknown>
): Record<string, unknown> {
  const s = state as Partial<MijiaAuthState> & Record<string, unknown>
  const out: Record<string, unknown> = {
    ua: s.userAgent,
    deviceId: s.deviceId,
    pass_o: s.passO,
    userId: s.userId,
    cUserId: s.cUserId,
    serviceToken: s.serviceToken,
    ssecurity: s.ssecurity,
    passToken: s.passToken,
    psecurity: s.psecurity,
    nonce: s.nonce,
    expireTime: s.expireTime,
    saveTime: s.saveTime,
  }
  // Drop undefined keys so the JSON the sidecar receives is clean.
  for (const key of Object.keys(out)) {
    if (out[key] === undefined) delete out[key]
  }
  return out
}
