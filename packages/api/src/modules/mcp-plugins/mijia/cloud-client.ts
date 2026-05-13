import type { JsonObject, MijiaAuthState, MijiaDeviceRecord } from "./types.js"
import {
  decryptEncryptedPayload,
  genNonce,
  generateEncryptedParams,
  getSignedNonce,
} from "./crypto.js"
import { getMijiaAppBaseUrl, refreshMijiaSessionTokens } from "./auth.js"
import { asObject } from "./http.js"

const CHECK_NEW_MSG_URI = "/v2/message/v2/check_new_msg"
const HOME_LIST_URI = "/v2/homeroom/gethome_merged"
const HOME_DEVICE_LIST_URI = "/home/home_device_list"
const SHARED_DEVICE_LIST_URI = "/v2/home/device_list_page"
const SCENE_LIST_URI =
  "/appgateway/miot/appsceneservice/AppSceneService/GetSimpleSceneList"
const RUN_SCENE_URI =
  "/appgateway/miot/appsceneservice/AppSceneService/NewRunScene"
const CONSUMABLE_ITEMS_URI = "/v2/home/standard_consumable_items"
const GET_PROP_URI = "/miotspec/prop/get"
const SET_PROP_URI = "/miotspec/prop/set"
const ACTION_URI = "/miotspec/action"
const STATISTICS_URI = "/v2/user/statistics"
const AVAILABLE_CACHE_TTL_MS = 60_000
const LIST_CACHE_TTL_MS = 30_000

const MIJIA_ERROR_CODE_MESSAGES: Record<string, string> = {
  "-10005": "Permission denied.",
  "-10007": "Device is offline or missing.",
  "-10020": "OAuth authorization is missing.",
  "-10030": "The Xiaomi token is invalid.",
  "-704030013": "Property is not readable.",
  "-704030023": "Property is not writable.",
  "-704040005": "Action does not exist.",
  "-704042011": "Device is offline.",
  "-704053100": "The device cannot perform this action in its current state.",
}

function isMijiaAuthErrorCode(code: unknown) {
  return code === -10020 || code === -10030
}

function formatMijiaErrorMessage(code: number, fallback?: string) {
  return (
    fallback || MIJIA_ERROR_CODE_MESSAGES[String(code)] || `Mijia error ${code}`
  )
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined
}

function readBoolean(value: unknown) {
  return typeof value === "boolean" ? value : undefined
}

function readNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function normalizeLocale(locale: string) {
  return locale.trim().replace("-", "_")
}

function buildTimezoneCookies() {
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

function cloneAuthState(state: MijiaAuthState): MijiaAuthState {
  return JSON.parse(JSON.stringify(state)) as MijiaAuthState
}

type CacheEntry<T> = {
  value: T
  expiresAt: number
}

export class MijiaApiError extends Error {
  code?: number
  isAuthError: boolean

  constructor(
    message: string,
    options?: { code?: number; isAuthError?: boolean }
  ) {
    super(message)
    this.name = "MijiaApiError"
    this.code = options?.code
    this.isAuthError = options?.isAuthError === true
  }
}

export class MijiaCloudClient {
  private authState: MijiaAuthState
  private readonly onAuthStateChanged?: (
    nextState: MijiaAuthState
  ) => Promise<void> | void
  private availabilityCache: CacheEntry<boolean> | null = null
  private homesCache: CacheEntry<any[]> | null = null

  constructor(
    authState: MijiaAuthState,
    options?: {
      onAuthStateChanged?: (nextState: MijiaAuthState) => Promise<void> | void
    }
  ) {
    this.authState = cloneAuthState(authState)
    this.authState.locale = normalizeLocale(this.authState.locale)
    this.onAuthStateChanged = options?.onAuthStateChanged
  }

  getAuthState() {
    return cloneAuthState(this.authState)
  }

  private async updateAuthState(nextState: MijiaAuthState) {
    this.authState = cloneAuthState(nextState)
    this.authState.locale = normalizeLocale(this.authState.locale)
    this.availabilityCache = null
    await this.onAuthStateChanged?.(this.getAuthState())
  }

  private buildSessionCookie() {
    const timezone = buildTimezoneCookies()
    const countryCode = this.authState.locale.split("_")[1] || "CN"

    return [
      `cUserId=${this.authState.cUserId || ""}`,
      `yetAnotherServiceToken=${this.authState.yetAnotherServiceToken || this.authState.serviceToken || ""}`,
      `serviceToken=${this.authState.serviceToken || ""}`,
      `timezone_id=${timezone.timezoneId}`,
      `timezone=${timezone.timezone}`,
      `is_daylight=${timezone.isDaylight ? "1" : "0"}`,
      `dst_offset=${timezone.dstOffset}`,
      "channel=MI_APP_STORE",
      `countryCode=${countryCode}`,
      `PassportDeviceId=${this.authState.deviceId}`,
      `locale=${this.authState.locale}`,
    ].join(";")
  }

  private buildApiHeaders() {
    return {
      "User-Agent": this.authState.userAgent,
      "accept-encoding": "identity",
      "Content-Type": "application/x-www-form-urlencoded",
      "miot-accept-encoding": "GZIP",
      "miot-encrypt-algorithm": "ENCRYPT-RC4",
      "x-xiaomi-protocal-flag-cli": "PROTOCAL-HTTP2",
      Cookie: this.buildSessionCookie(),
    }
  }

  private async encryptedRequest(uri: string, data: JsonObject) {
    if (
      !this.authState.serviceToken ||
      !this.authState.ssecurity ||
      !this.authState.cUserId
    ) {
      throw new MijiaApiError(
        "The Mijia account is missing an active service token. Reconnect the plugin.",
        { isAuthError: true }
      )
    }

    const nonce = genNonce()
    const signedNonce = getSignedNonce(this.authState.ssecurity, nonce)
    const encryptedParams = generateEncryptedParams(
      uri,
      "POST",
      signedNonce,
      nonce,
      {
        data: JSON.stringify(data),
      },
      this.authState.ssecurity
    )

    const response = await fetch(`${getMijiaAppBaseUrl()}${uri}`, {
      method: "POST",
      headers: this.buildApiHeaders(),
      body: new URLSearchParams(encryptedParams).toString(),
    })

    const bodyText = await response.text()
    let payload: JsonObject
    try {
      payload = JSON.parse(bodyText) as JsonObject
    } catch {
      payload = JSON.parse(
        decryptEncryptedPayload(this.authState.ssecurity, nonce, bodyText)
      ) as JsonObject
    }

    const code = readNumber(payload.code) ?? 0
    if (!response.ok) {
      throw new MijiaApiError(
        `Mijia request failed with HTTP ${response.status}`,
        {
          isAuthError: response.status === 401 || isMijiaAuthErrorCode(code),
          code,
        }
      )
    }
    if (code !== 0 || payload.result === undefined) {
      throw new MijiaApiError(
        formatMijiaErrorMessage(
          code,
          readString(payload.message) || readString(payload.desc)
        ),
        { code, isAuthError: isMijiaAuthErrorCode(code) }
      )
    }

    return payload.result
  }

  private async ensureValidSession() {
    if (
      this.availabilityCache &&
      this.availabilityCache.value &&
      this.availabilityCache.expiresAt > Date.now()
    ) {
      return
    }

    try {
      await this.encryptedRequest(CHECK_NEW_MSG_URI, {
        begin_at: Math.floor(Date.now() / 1_000) - 3_600,
      })
      this.availabilityCache = {
        value: true,
        expiresAt: Date.now() + AVAILABLE_CACHE_TTL_MS,
      }
      return
    } catch (error) {
      if (!(error instanceof MijiaApiError) || !error.isAuthError) {
        throw error
      }
    }

    const refreshed = await refreshMijiaSessionTokens(this.authState)
    await this.updateAuthState(refreshed)
    this.availabilityCache = {
      value: true,
      expiresAt: Date.now() + AVAILABLE_CACHE_TTL_MS,
    }
  }

  private async request(uri: string, data: JsonObject) {
    await this.ensureValidSession()
    try {
      return await this.encryptedRequest(uri, data)
    } catch (error) {
      if (!(error instanceof MijiaApiError) || !error.isAuthError) {
        throw error
      }
      const refreshed = await refreshMijiaSessionTokens(this.authState)
      await this.updateAuthState(refreshed)
      return this.encryptedRequest(uri, data)
    }
  }

  async getHomesList() {
    if (this.homesCache && this.homesCache.expiresAt > Date.now()) {
      return this.homesCache.value
    }
    const homes = asObject(
      await this.request(HOME_LIST_URI, {
        fg: true,
        fetch_share: true,
        fetch_share_dev: true,
        fetch_cariot: true,
        limit: 300,
        app_ver: 7,
        plat_form: 0,
      })
    ).homelist
    const normalized = Array.isArray(homes) ? homes : []
    this.homesCache = {
      value: normalized,
      expiresAt: Date.now() + LIST_CACHE_TTL_MS,
    }
    return normalized
  }

  private async getHomeOwner(homeId: string) {
    const homes = await this.getHomesList()
    const matched = homes.find(
      (home: any) => String(home?.id) === String(homeId)
    )
    if (!matched) {
      throw new Error(`Unable to find home ${homeId}.`)
    }
    return Number(matched.uid)
  }

  private buildHomeRoomLookup(homes: any[]) {
    const roomByDid = new Map<
      string,
      { homeId: string; homeName?: string; roomId?: string; roomName?: string }
    >()
    for (const home of homes) {
      for (const room of Array.isArray(home?.roomlist) ? home.roomlist : []) {
        for (const did of Array.isArray(room?.dids) ? room.dids : []) {
          roomByDid.set(String(did), {
            homeId: String(home.id),
            homeName: readString(home.name),
            roomId: readString(room.id),
            roomName: readString(room.name),
          })
        }
      }
    }
    return roomByDid
  }

  private async getDevicesByHome(homeId: string) {
    const devices: any[] = []
    let startDid = ""
    let hasMore = true
    const ownerUid = await this.getHomeOwner(homeId)

    while (hasMore) {
      const response = asObject(
        await this.request(HOME_DEVICE_LIST_URI, {
          home_owner: ownerUid,
          home_id: Number(homeId),
          limit: 200,
          start_did: startDid,
          get_split_device: true,
          support_smart_home: true,
          get_cariot_device: true,
          get_third_device: true,
        })
      )

      const pageDevices = Array.isArray(response.device_info)
        ? response.device_info
        : []
      devices.push(...pageDevices)
      startDid = readString(response.max_did) || ""
      hasMore = Boolean(response.has_more) && startDid.length > 0
    }

    return devices
  }

  async getDevicesList(homeId?: string) {
    const homes = await this.getHomesList()
    const roomLookup = this.buildHomeRoomLookup(homes)
    const devices: any[] = []

    if (homeId) {
      devices.push(...(await this.getDevicesByHome(homeId)))
    } else {
      for (const home of homes) {
        devices.push(...(await this.getDevicesByHome(String(home.id))))
      }
    }

    return devices.map((device) =>
      this.mapDeviceRecord(device, roomLookup, false)
    )
  }

  async getSharedDevicesList() {
    const response = asObject(
      await this.request(SHARED_DEVICE_LIST_URI, {
        ssid: "<unknown ssid>",
        bssid: "02:00:00:00:00:00",
        getVirtualModel: true,
        getHuamiDevices: 1,
        get_split_device: true,
        support_smart_home: true,
        get_cariot_device: true,
        get_third_device: true,
        get_phone_device: true,
        get_miwear_device: true,
      })
    )

    const list = Array.isArray(response.list) ? response.list : []
    return list
      .filter((item) => item?.owner)
      .map((device) => this.mapDeviceRecord(device, new Map(), true))
  }

  private mapDeviceRecord(
    device: any,
    roomLookup: Map<
      string,
      { homeId: string; homeName?: string; roomId?: string; roomName?: string }
    >,
    isShared: boolean
  ): MijiaDeviceRecord {
    const did = String(device?.did || "")
    const placement = roomLookup.get(did)
    const homeId =
      readString(device?.home_id) ||
      placement?.homeId ||
      (isShared ? "shared" : "")
    return {
      did,
      name: readString(device?.name) || did,
      model: readString(device?.model) || "unknown",
      homeId,
      homeName: placement?.homeName,
      roomId: placement?.roomId || readString(device?.room_id),
      roomName: placement?.roomName,
      isOnline: readBoolean(device?.isOnline) ?? false,
      isShared,
      raw: asObject(device),
    }
  }

  async getScenesList(homeId?: string) {
    const homes = await this.getHomesList()
    const targetHomes = homeId
      ? homes.filter((home: any) => String(home?.id) === String(homeId))
      : homes
    const scenes: any[] = []

    for (const home of targetHomes) {
      const response = asObject(
        await this.request(SCENE_LIST_URI, {
          app_version: 12,
          get_type: 2,
          home_id: String(home.id),
          owner_uid: await this.getHomeOwner(String(home.id)),
        })
      )
      const currentScenes = Array.isArray(response.manual_scene_info_list)
        ? response.manual_scene_info_list
        : []
      for (const scene of currentScenes) {
        scenes.push({
          ...scene,
          home_id: String(home.id),
          home_name: readString(home.name),
        })
      }
    }

    return scenes
  }

  async runScene(sceneId: string, homeId: string) {
    return this.request(RUN_SCENE_URI, {
      scene_id: sceneId,
      scene_type: 2,
      phone_id: "null",
      home_id: String(homeId),
      owner_uid: await this.getHomeOwner(homeId),
    })
  }

  async getConsumableItems(homeId?: string) {
    const homes = await this.getHomesList()
    const targetHomes = homeId
      ? homes.filter((home: any) => String(home?.id) === String(homeId))
      : homes
    const items: any[] = []

    for (const home of targetHomes) {
      const response = asObject(
        await this.request(CONSUMABLE_ITEMS_URI, {
          home_id: Number(home.id),
          owner_id: await this.getHomeOwner(String(home.id)),
          filter_ignore: true,
        })
      )
      const groups = Array.isArray(response.items) ? response.items : []
      const consumables = Array.isArray(groups[0]?.consumes_data)
        ? groups[0]!.consumes_data
        : []
      for (const item of consumables) {
        items.push({
          ...item,
          home_id: String(home.id),
          home_name: readString(home.name),
        })
      }
    }

    return items
  }

  async getDevicesProp(params: JsonObject[] | JsonObject) {
    const payload = Array.isArray(params) ? params : [params]
    const result = await this.request(GET_PROP_URI, {
      params: payload,
      datasource: 1,
    })
    if (!Array.isArray(result)) {
      return result
    }
    return Array.isArray(params) ? result : result[0]
  }

  async setDevicesProp(params: JsonObject[] | JsonObject) {
    const payload = Array.isArray(params) ? params : [params]
    const result = await this.request(SET_PROP_URI, {
      params: payload,
    })
    if (!Array.isArray(result)) {
      return result
    }
    return Array.isArray(params) ? result : result[0]
  }

  async runAction(params: JsonObject[] | JsonObject) {
    const payload = Array.isArray(params) ? params : [params]
    const results = []
    for (const item of payload) {
      results.push(
        await this.request(ACTION_URI, {
          params: item,
        })
      )
    }
    return Array.isArray(params) ? results : results[0]
  }

  async getStatistics(data: JsonObject) {
    return this.request(STATISTICS_URI, data)
  }
}
