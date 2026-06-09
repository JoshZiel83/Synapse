import {
  type FeishuFeatureKey,
  assertFeishuFeatureSelection,
  resolveFeishuFeatureScopes,
} from "./features.js"
import {
  type FeishuBrand,
  resolveFeishuAccountsBaseUrl,
  resolveFeishuOpenBaseUrl,
} from "./client.js"
import {
  dateToIsoInstant,
  nowIsoInstant,
  parseIsoInstant,
} from "@synapse/shared/datetime"
import type { Timestamp } from "@synapse/shared"

type JsonObject = Record<string, unknown>

type DeviceLikePayload = {
  brand: FeishuBrand
  deviceCode: string
  verificationUrl: string
  interval: number
  expiresAt: Timestamp
  lastPollAt?: Timestamp
}

type AppRegistrationPayload = DeviceLikePayload

type UserAuthorizationPayload = DeviceLikePayload & {
  openBaseUrl: string
  accountsBaseUrl: string
}

export type FeishuCliSetupStage = "app_registration" | "user_authorization"

export interface FeishuCliSetupTransientPayload {
  stage: FeishuCliSetupStage
  requestedFeatures: FeishuFeatureKey[]
  requestedScopes: string[]
  appRegistration?: AppRegistrationPayload
  appCredentials?: {
    brand: FeishuBrand
    appId: string
    appSecret: string
  }
  userAuthorization?: UserAuthorizationPayload
}

export type FeishuCliSetupProgressResult =
  | {
      status: "pending"
      transientPayload?: FeishuCliSetupTransientPayload
      challengePayload?: JsonObject
      expiresAt?: Timestamp
    }
  | {
      status: "completed"
      appCredentials: {
        brand: FeishuBrand
        appId: string
        appSecret: string
      }
      tokenData: {
        accessToken: string
        refreshToken: string
        expiresIn: number
        refreshExpiresIn: number
        scope: string
        tokenType: string
      }
      profile: JsonObject
      requestedFeatures: FeishuFeatureKey[]
    }
  | {
      status: "failed" | "expired"
      errorCode: string
      errorMessage: string
    }

function asObject(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {}
  }
  return value as JsonObject
}

function asString(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
}

function asNumber(value: unknown, fallback: number) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value
  }
  return fallback
}

function buildQrChallenge(input: {
  stage: FeishuCliSetupStage
  scanUrl: string
  expiresAt: Timestamp
  userCode?: string
}) {
  const stageLabel =
    input.stage === "app_registration" ? "create_app" : "authorize_user"

  return {
    kind: "qr_code",
    expiresAt: input.expiresAt,
    metadata: {
      provider: "feishu",
      stage: stageLabel,
      scanUrl: input.scanUrl,
      title:
        input.stage === "app_registration"
          ? "Create Feishu app"
          : "Authorize Feishu account",
      description:
        input.stage === "app_registration"
          ? "Scan the QR code with Feishu to create a personal app for this plugin."
          : "Scan the QR code with Feishu to authorize the selected Feishu features.",
      actionLabel:
        input.stage === "app_registration"
          ? "Open app creation page"
          : "Open Feishu authorization page",
      userCode: input.userCode,
    },
  }
}

function shouldPoll(lastPollAt: string | undefined, intervalSeconds: number) {
  if (!lastPollAt) return true
  return (
    Date.now() - parseIsoInstant(lastPollAt).getTime() >= intervalSeconds * 1000
  )
}

async function readJsonResponse(response: Response) {
  return asObject(await response.json().catch(() => ({})))
}

function buildVerificationUrl(baseOpenUrl: string, userCode: string) {
  const url = new URL("/page/cli", baseOpenUrl)
  url.searchParams.set("user_code", userCode)
  url.searchParams.set("from", "synapse")
  return url.toString()
}

async function beginAppRegistration() {
  const endpoint = `${resolveFeishuAccountsBaseUrl("feishu")}/oauth/v1/app/registration`
  const body = new URLSearchParams({
    action: "begin",
    archetype: "PersonalAgent",
    auth_method: "client_secret",
    request_user_info: "open_id tenant_brand",
  })

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  })

  const payload = await readJsonResponse(response)
  if (!response.ok || asString(payload.error)) {
    throw new Error(
      asString(payload.error_description) ||
        asString(payload.error) ||
        "Failed to start Feishu app registration."
    )
  }

  const userCode = asString(payload.user_code)
  return {
    brand: "feishu" as const,
    deviceCode: asString(payload.device_code),
    interval: asNumber(payload.interval, 5),
    expiresAt: dateToIsoInstant(
      new Date(Date.now() + asNumber(payload.expires_in, 300) * 1000)
    ),
    verificationUrl: buildVerificationUrl(
      resolveFeishuOpenBaseUrl("feishu"),
      userCode
    ),
    userCode,
  }
}

async function pollAppRegistration(payload: AppRegistrationPayload): Promise<
  | {
      status: "pending"
      next: AppRegistrationPayload
    }
  | {
      status: "completed"
      brand: FeishuBrand
      appId: string
      appSecret: string
    }
  | {
      status: "failed" | "expired"
      errorCode: string
      errorMessage: string
    }
> {
  const endpoint = `${resolveFeishuAccountsBaseUrl(payload.brand)}/oauth/v1/app/registration`
  const body = new URLSearchParams({
    action: "poll",
    device_code: payload.deviceCode,
  })

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  })

  const result = await readJsonResponse(response)
  const nowIso = nowIsoInstant()
  const error = asString(result.error)

  if (!error && asString(result.client_id)) {
    const tenantBrand =
      asString(asObject(result.user_info).tenant_brand) === "lark"
        ? "lark"
        : payload.brand

    if (
      !asString(result.client_secret) &&
      tenantBrand === "lark" &&
      payload.brand !== "lark"
    ) {
      return pollAppRegistration({
        ...payload,
        brand: "lark",
        lastPollAt: nowIso,
      })
    }

    return {
      status: "completed",
      brand: tenantBrand,
      appId: asString(result.client_id),
      appSecret: asString(result.client_secret),
    }
  }

  switch (error) {
    case "":
    case "authorization_pending":
      return {
        status: "pending",
        next: {
          ...payload,
          lastPollAt: nowIso,
        },
      }
    case "slow_down":
      return {
        status: "pending",
        next: {
          ...payload,
          interval: Math.min(payload.interval + 5, 60),
          lastPollAt: nowIso,
        },
      }
    case "access_denied":
      return {
        status: "failed",
        errorCode: "FEISHU_APP_REGISTRATION_DENIED",
        errorMessage:
          asString(result.error_description) ||
          "Feishu app registration was denied.",
      }
    case "expired_token":
    case "invalid_grant":
      return {
        status: "expired",
        errorCode: "FEISHU_APP_REGISTRATION_EXPIRED",
        errorMessage:
          asString(result.error_description) ||
          "Feishu app registration timed out. Start again.",
      }
    default:
      return {
        status: "failed",
        errorCode: "FEISHU_APP_REGISTRATION_ERROR",
        errorMessage:
          asString(result.error_description) ||
          error ||
          "Feishu app registration failed.",
      }
  }
}

async function beginUserAuthorization(input: {
  brand: FeishuBrand
  appId: string
  appSecret: string
  scopes: string[]
}) {
  const endpoint = `${resolveFeishuAccountsBaseUrl(input.brand)}/oauth/v1/device_authorization`
  const scope = Array.from(new Set(["offline_access", ...input.scopes])).join(
    " "
  )
  const body = new URLSearchParams({
    client_id: input.appId,
    scope,
  })
  const basicAuth = Buffer.from(`${input.appId}:${input.appSecret}`).toString(
    "base64"
  )

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  })

  const payload = await readJsonResponse(response)
  if (!response.ok || asString(payload.error)) {
    throw new Error(
      asString(payload.error_description) ||
        asString(payload.error) ||
        "Failed to start Feishu user authorization."
    )
  }

  const verificationUrl =
    asString(payload.verification_uri_complete) ||
    asString(payload.verification_uri)

  return {
    brand: input.brand,
    deviceCode: asString(payload.device_code),
    interval: asNumber(payload.interval, 5),
    expiresAt: dateToIsoInstant(
      new Date(Date.now() + asNumber(payload.expires_in, 240) * 1000)
    ),
    verificationUrl,
    userCode: asString(payload.user_code),
    openBaseUrl: resolveFeishuOpenBaseUrl(input.brand),
    accountsBaseUrl: resolveFeishuAccountsBaseUrl(input.brand),
  }
}

async function pollUserAuthorization(input: {
  appId: string
  appSecret: string
  payload: UserAuthorizationPayload
}): Promise<
  | {
      status: "pending"
      next: UserAuthorizationPayload
    }
  | {
      status: "completed"
      tokenData: {
        accessToken: string
        refreshToken: string
        expiresIn: number
        refreshExpiresIn: number
        scope: string
        tokenType: string
      }
    }
  | {
      status: "failed" | "expired"
      errorCode: string
      errorMessage: string
    }
> {
  const endpoint = `${input.payload.openBaseUrl}/open-apis/authen/v2/oauth/token`
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    device_code: input.payload.deviceCode,
    client_id: input.appId,
    client_secret: input.appSecret,
  })

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  })

  const payload = await readJsonResponse(response)
  const nowIso = nowIsoInstant()
  const error = asString(payload.error)

  if (!error && asString(payload.access_token)) {
    return {
      status: "completed",
      tokenData: {
        accessToken: asString(payload.access_token),
        refreshToken: asString(payload.refresh_token),
        expiresIn: asNumber(payload.expires_in, 7200),
        refreshExpiresIn: asNumber(payload.refresh_token_expires_in, 604800),
        scope: asString(payload.scope),
        tokenType: asString(payload.token_type) || "Bearer",
      },
    }
  }

  switch (error) {
    case "":
    case "authorization_pending":
      return {
        status: "pending",
        next: {
          ...input.payload,
          lastPollAt: nowIso,
        },
      }
    case "slow_down":
      return {
        status: "pending",
        next: {
          ...input.payload,
          interval: Math.min(input.payload.interval + 5, 60),
          lastPollAt: nowIso,
        },
      }
    case "access_denied":
      return {
        status: "failed",
        errorCode: "FEISHU_AUTH_DENIED",
        errorMessage:
          asString(payload.error_description) ||
          "Feishu account authorization was denied.",
      }
    case "expired_token":
    case "invalid_grant":
      return {
        status: "expired",
        errorCode: "FEISHU_AUTH_EXPIRED",
        errorMessage:
          asString(payload.error_description) ||
          "Feishu account authorization timed out. Start again.",
      }
    default:
      return {
        status: "failed",
        errorCode: "FEISHU_AUTH_ERROR",
        errorMessage:
          asString(payload.error_description) ||
          error ||
          "Feishu account authorization failed.",
      }
  }
}

async function fetchCurrentUserProfile(
  brand: FeishuBrand,
  accessToken: string
) {
  const endpoint = `${resolveFeishuOpenBaseUrl(brand)}/open-apis/authen/v1/user_info`
  const response = await fetch(endpoint, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  })

  const payload = await readJsonResponse(response)
  if (
    !response.ok ||
    (typeof payload.code === "number" && payload.code !== 0)
  ) {
    throw new Error(
      asString(payload.msg) || "Failed to fetch Feishu user profile."
    )
  }

  return asObject(payload.data)
}

export async function refreshFeishuUserAccessToken(input: {
  brand: FeishuBrand
  openBaseUrl?: string
  appId: string
  appSecret: string
  refreshToken: string
}) {
  const endpoint = `${
    input.openBaseUrl || resolveFeishuOpenBaseUrl(input.brand)
  }/open-apis/authen/v2/oauth/token`
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: input.refreshToken,
    client_id: input.appId,
    client_secret: input.appSecret,
  })

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  })

  const payload = await readJsonResponse(response)
  if (!response.ok || asString(payload.error)) {
    throw new Error(
      asString(payload.error_description) ||
        asString(payload.error) ||
        "Failed to refresh Feishu access token."
    )
  }

  return {
    accessToken: asString(payload.access_token),
    refreshToken: asString(payload.refresh_token) || input.refreshToken,
    expiresIn: asNumber(payload.expires_in, 7200),
    refreshExpiresIn: asNumber(payload.refresh_token_expires_in, 604800),
    scope: asString(payload.scope),
    tokenType: asString(payload.token_type) || "Bearer",
  }
}

export async function startFeishuCliSetup(
  features: FeishuFeatureKey[],
  existingAppCredentials?: {
    brand: FeishuBrand
    appId: string
    appSecret: string
  }
) {
  assertFeishuFeatureSelection(features)
  const requestedScopes = resolveFeishuFeatureScopes(features)

  if (existingAppCredentials) {
    const userAuthorization = await beginUserAuthorization({
      brand: existingAppCredentials.brand,
      appId: existingAppCredentials.appId,
      appSecret: existingAppCredentials.appSecret,
      scopes: requestedScopes,
    })

    return {
      challengePayload: buildQrChallenge({
        stage: "user_authorization",
        scanUrl: userAuthorization.verificationUrl,
        expiresAt: userAuthorization.expiresAt,
        userCode: userAuthorization.userCode,
      }),
      transientPayload: {
        stage: "user_authorization",
        requestedFeatures: features,
        requestedScopes,
        appCredentials: existingAppCredentials,
        userAuthorization: {
          brand: userAuthorization.brand,
          deviceCode: userAuthorization.deviceCode,
          verificationUrl: userAuthorization.verificationUrl,
          interval: userAuthorization.interval,
          expiresAt: userAuthorization.expiresAt,
          openBaseUrl: userAuthorization.openBaseUrl,
          accountsBaseUrl: userAuthorization.accountsBaseUrl,
        },
      } satisfies FeishuCliSetupTransientPayload,
      expiresAt: userAuthorization.expiresAt,
    }
  }

  const appRegistration = await beginAppRegistration()
  const transientPayload: FeishuCliSetupTransientPayload = {
    stage: "app_registration",
    requestedFeatures: features,
    requestedScopes,
    appRegistration: {
      brand: appRegistration.brand,
      deviceCode: appRegistration.deviceCode,
      verificationUrl: appRegistration.verificationUrl,
      interval: appRegistration.interval,
      expiresAt: appRegistration.expiresAt,
    },
  }

  return {
    challengePayload: buildQrChallenge({
      stage: "app_registration",
      scanUrl: appRegistration.verificationUrl,
      expiresAt: appRegistration.expiresAt,
      userCode: appRegistration.userCode,
    }),
    transientPayload,
    expiresAt: appRegistration.expiresAt,
  }
}

export async function progressFeishuCliSetup(
  transientPayload: FeishuCliSetupTransientPayload
): Promise<FeishuCliSetupProgressResult> {
  if (transientPayload.stage === "app_registration") {
    const appRegistration = transientPayload.appRegistration
    if (!appRegistration) {
      return {
        status: "failed",
        errorCode: "FEISHU_APP_REGISTRATION_STATE_INVALID",
        errorMessage: "Feishu app registration state is missing.",
      }
    }
    if (!shouldPoll(appRegistration.lastPollAt, appRegistration.interval)) {
      return { status: "pending" }
    }

    const result = await pollAppRegistration(appRegistration)
    if (result.status === "pending") {
      return {
        status: "pending",
        transientPayload: {
          ...transientPayload,
          appRegistration: result.next,
        },
      }
    }
    if (result.status !== "completed") {
      return result
    }

    const userAuthorization = await beginUserAuthorization({
      brand: result.brand,
      appId: result.appId,
      appSecret: result.appSecret,
      scopes: transientPayload.requestedScopes,
    })

    const nextPayload: FeishuCliSetupTransientPayload = {
      ...transientPayload,
      stage: "user_authorization",
      appCredentials: {
        brand: result.brand,
        appId: result.appId,
        appSecret: result.appSecret,
      },
      userAuthorization: {
        brand: userAuthorization.brand,
        deviceCode: userAuthorization.deviceCode,
        verificationUrl: userAuthorization.verificationUrl,
        interval: userAuthorization.interval,
        expiresAt: userAuthorization.expiresAt,
        openBaseUrl: userAuthorization.openBaseUrl,
        accountsBaseUrl: userAuthorization.accountsBaseUrl,
      },
    }

    return {
      status: "pending",
      transientPayload: nextPayload,
      challengePayload: buildQrChallenge({
        stage: "user_authorization",
        scanUrl: userAuthorization.verificationUrl,
        expiresAt: userAuthorization.expiresAt,
        userCode: userAuthorization.userCode,
      }),
      expiresAt: userAuthorization.expiresAt,
    }
  }

  if (transientPayload.stage === "user_authorization") {
    const appCredentials = transientPayload.appCredentials
    const userAuthorization = transientPayload.userAuthorization
    if (!appCredentials || !userAuthorization) {
      return {
        status: "failed",
        errorCode: "FEISHU_AUTH_STATE_INVALID",
        errorMessage: "Feishu authorization state is missing.",
      }
    }
    if (!shouldPoll(userAuthorization.lastPollAt, userAuthorization.interval)) {
      return { status: "pending" }
    }

    const result = await pollUserAuthorization({
      appId: appCredentials.appId,
      appSecret: appCredentials.appSecret,
      payload: userAuthorization,
    })
    if (result.status === "pending") {
      return {
        status: "pending",
        transientPayload: {
          ...transientPayload,
          userAuthorization: result.next,
        },
      }
    }
    if (result.status !== "completed") {
      return result
    }

    const profile = await fetchCurrentUserProfile(
      appCredentials.brand,
      result.tokenData.accessToken
    )

    return {
      status: "completed",
      appCredentials,
      tokenData: result.tokenData,
      profile,
      requestedFeatures: transientPayload.requestedFeatures,
    }
  }

  return {
    status: "failed",
    errorCode: "FEISHU_AUTH_STAGE_INVALID",
    errorMessage: "Unsupported Feishu authorization stage.",
  }
}
