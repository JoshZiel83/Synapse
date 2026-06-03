import { betterAuth } from "better-auth"
import { bearer, genericOAuth } from "better-auth/plugins"
import { deviceAuthorization } from "better-auth/plugins"
import { getOAuth2Tokens } from "better-auth/oauth2"
import { expo } from "@better-auth/expo"
import { config } from "../../config/index.js"
import { createBetterAuthDialect } from "../../infrastructure/database/kysely.js"
import { db } from "../../infrastructure/database/kysely.js"
import { createLogger } from "../../infrastructure/logger/index.js"
import { createGeneratedUserAvatarFile } from "../avatar/service.js"
import { AUTH_SESSION_MAX_AGE_SECONDS } from "@synapse/shared"
import { disconnectSocketsForSession } from "../../infrastructure/websocket/auth-session-registry.js"
import { deviceSessionCookie } from "./device-session-cookie.js"

const log = createLogger("auth.better-auth")

/**
 * Feishu / Lark OAuth endpoints. Feishu is NOT standard OIDC (no
 * .well-known/openid-configuration, token endpoint wants a JSON body, user_info
 * is wrapped in `{ code, data }`), so the provider is wired with explicit URLs
 * and a custom getToken/getUserInfo rather than discovery.
 */
const FEISHU_HOST = config.feishu.intl
  ? "https://open.larksuite.com"
  : "https://open.feishu.cn"
const FEISHU_ACCOUNTS = config.feishu.intl
  ? "https://accounts.larksuite.com"
  : "https://accounts.feishu.cn"

const FEISHU_AUTHORIZE_URL = `${FEISHU_ACCOUNTS}/open-apis/authen/v1/authorize`
const FEISHU_TOKEN_URL = `${FEISHU_HOST}/open-apis/authen/v2/oauth/token`
const FEISHU_USER_INFO_URL = `${FEISHU_HOST}/open-apis/authen/v1/user_info`

type FeishuUserInfo = {
  open_id?: string
  union_id?: string
  name?: string
  en_name?: string
  avatar_url?: string
  email?: string
  enterprise_email?: string
  tenant_key?: string
}

/**
 * Build the genericOAuth Feishu provider. Returns `null` when Feishu is not
 * configured so we don't register a half-wired provider that 400s on use.
 */
function buildFeishuProvider() {
  if (!config.feishu.appId || !config.feishu.appSecret) {
    log.info(
      "Feishu OAuth disabled (FEISHU_APP_ID / FEISHU_APP_SECRET not set)"
    )
    return null
  }

  return {
    providerId: "feishu",
    clientId: config.feishu.appId,
    clientSecret: config.feishu.appSecret,
    authorizationUrl: FEISHU_AUTHORIZE_URL,
    // tokenUrl is still REQUIRED by genericOAuth even with a custom getToken
    // (the plugin reads it before deciding whether getToken overrides it).
    tokenUrl: FEISHU_TOKEN_URL,
    userInfoUrl: FEISHU_USER_INFO_URL,
    scopes: [
      "contact:user.base:readonly",
      "contact:user.email:readonly",
      "offline_access",
    ],
    // Feishu's v2 token endpoint wants a JSON body; Better Auth's built-in
    // exchange posts x-www-form-urlencoded, so we hand-roll the request and
    // normalize the response via getOAuth2Tokens.
    getToken: async (data: {
      code: string
      redirectURI: string
      codeVerifier?: string
    }) => {
      // Log the exact redirect_uri Better Auth emits so it can be registered
      // verbatim in the Feishu console (BA may strip the basePath).
      log.info(
        { redirectURI: data.redirectURI },
        "Feishu token exchange (register this exact redirect_uri in the Feishu console)"
      )
      const response = await fetch(FEISHU_TOKEN_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          Accept: "application/json",
        },
        body: JSON.stringify({
          grant_type: "authorization_code",
          client_id: config.feishu.appId,
          client_secret: config.feishu.appSecret,
          code: data.code,
          redirect_uri: data.redirectURI,
          ...(data.codeVerifier ? { code_verifier: data.codeVerifier } : {}),
        }),
      })
      const json = (await response.json()) as Record<string, unknown> & {
        code?: number
        msg?: string
      }
      if (!response.ok || (typeof json.code === "number" && json.code !== 0)) {
        log.error(
          { status: response.status, code: json.code, msg: json.msg },
          "Feishu token exchange failed"
        )
        throw new Error(
          `Feishu token exchange failed: ${json.msg ?? response.statusText}`
        )
      }
      // getOAuth2Tokens maps access_token/refresh_token/expires_in/scope/id_token
      // from the raw provider JSON into Better Auth's OAuth2Tokens shape.
      return getOAuth2Tokens(json)
    },
    // Feishu user_info wraps the profile in `{ code, msg, data }`; the account
    // row is keyed on the returned `id`, so we set id = union_id (stable across
    // apps). Email is frequently absent → synthesize one and mark it unverified
    // so it can never auto-link to (or auto-grant admin via) a real account.
    getUserInfo: async (tokens: { accessToken?: string }) => {
      const response = await fetch(FEISHU_USER_INFO_URL, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${tokens.accessToken ?? ""}`,
          Accept: "application/json",
        },
      })
      const body = (await response.json()) as {
        code?: number
        msg?: string
        data?: FeishuUserInfo
      }
      const profile = body.data
      if (!response.ok || body.code !== 0 || !profile?.union_id) {
        log.error(
          { status: response.status, code: body.code, msg: body.msg },
          "Feishu user_info failed"
        )
        return null
      }
      const realEmail = profile.email ?? profile.enterprise_email
      const email =
        realEmail ?? `${profile.open_id ?? profile.union_id}@feishu.local`
      return {
        id: profile.union_id,
        name: profile.name ?? profile.en_name ?? "Feishu user",
        email,
        // Never trust the (possibly synthetic) email as verified.
        emailVerified: false,
        image: profile.avatar_url,
        // Carried through to mapProfileToUser via the merged userInfo object.
        feishuOpenId: profile.open_id,
        feishuUnionId: profile.union_id,
        feishuTenantKey: profile.tenant_key,
      }
    },
    // Persist the Feishu ids onto the user row. Crucially does NOT return `id`
    // (returning an id here would override account.accountId, which must stay
    // union_id from getUserInfo). Cast: these are additionalFields, not part of
    // Better Auth's base User type that mapProfileToUser is declared to return.
    mapProfileToUser: (profile: Record<string, unknown>) =>
      ({
        feishuOpenId: profile.feishuOpenId as string | undefined,
        feishuUnionId: profile.feishuUnionId as string | undefined,
        feishuTenantKey: profile.feishuTenantKey as string | undefined,
      }) as Record<string, unknown>,
  }
}

const feishuProvider = buildFeishuProvider()

/**
 * The single Better Auth instance. Owns the user/account/session/verification +
 * device_code tables (hand-written in schema.sql, snake_case, mapped here via
 * modelName + per-field `fields`). Mounted under /api/v1/auth (see auth module).
 */
export const auth = betterAuth({
  appName: "Synapse",
  // baseURL MUST be the public browser origin (drives OAuth redirect_uri + the
  // origin where session/state cookies land), NOT the internal API origin.
  baseURL: config.auth.baseUrl,
  basePath: "/api/v1/auth",
  secret: config.auth.secret,
  trustedOrigins: [config.auth.baseUrl, ...config.auth.trustedOrigins].filter(
    Boolean
  ),

  database: {
    // Reuse the app's existing pg pool via a Kysely PostgresDialect (exposed by
    // the database layer so the bare pool stays sealed there). type:"postgres"
    // is required for the adapter to enable UUID/JSON support and let the DB
    // generate ids; transaction:true makes the credential/OAuth multi-write atomic.
    dialect: createBetterAuthDialect(),
    type: "postgres",
    transaction: true,
  },

  advanced: {
    database: {
      // The DB generates every id (DEFAULT uuid_generate_v4()); BA must not.
      generateId: false,
    },
    cookies: {
      // Keep the canonical session cookie name. Better Auth still adds the
      // __Secure- prefix automatically in production; business code never reads
      // the cookie by name (it calls auth.api.getSession / forwards headers).
      session_token: { name: "synapse_session" },
    },
  },

  session: {
    modelName: "session",
    expiresIn: AUTH_SESSION_MAX_AGE_SECONDS,
    updateAge: 60 * 60 * 24, // slide expiry at most once per day
    fields: {
      userId: "user_id",
      expiresAt: "expires_at",
      ipAddress: "ip_address",
      userAgent: "user_agent",
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
  },

  emailAndPassword: {
    enabled: true,
    autoSignIn: true,
  },

  account: {
    modelName: "account",
    // Encrypt provider access/refresh tokens at rest with the BA secret.
    encryptOAuthTokens: true,
    accountLinking: {
      enabled: true,
      // No trusted providers and implicit linking OFF: until real email
      // verification exists, never auto-link an OAuth identity onto an existing
      // (possibly admin) account by matching email.
      trustedProviders: [],
      disableImplicitLinking: true,
    },
    fields: {
      accountId: "account_id",
      providerId: "provider_id",
      userId: "user_id",
      accessToken: "access_token",
      refreshToken: "refresh_token",
      idToken: "id_token",
      accessTokenExpiresAt: "access_token_expires_at",
      refreshTokenExpiresAt: "refresh_token_expires_at",
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
  },

  user: {
    modelName: "users",
    fields: {
      emailVerified: "email_verified",
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
    additionalFields: {
      avatarFileId: {
        type: "string",
        required: false,
        input: false,
        fieldName: "avatar_file_id",
      },
      feishuOpenId: {
        type: "string",
        required: false,
        input: false,
        fieldName: "feishu_open_id",
      },
      feishuUnionId: {
        type: "string",
        required: false,
        input: false,
        fieldName: "feishu_union_id",
      },
      feishuTenantKey: {
        type: "string",
        required: false,
        input: false,
        fieldName: "feishu_tenant_key",
      },
    },
  },

  verification: {
    modelName: "verification",
    fields: {
      expiresAt: "expires_at",
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
  },

  databaseHooks: {
    user: {
      create: {
        before: async (user: Record<string, unknown>) => {
          // Defensive: never let any creation path mark a Feishu-synthetic
          // email as verified.
          const email = String(user.email ?? "").toLowerCase()
          if (email.endsWith("@feishu.local")) {
            return { data: { ...user, emailVerified: false } }
          }
          return undefined
        },
        after: async (user: { id: string; email: string; name: string }) => {
          // Generate a pixel-art avatar and backfill avatar_file_id. Best-effort:
          // this hook is awaited, so a throw would fail the (already-committed)
          // sign-up/OAuth — log and move on instead.
          try {
            const existing = await db
              .selectFrom("users")
              .select("avatar_file_id")
              .where("id", "=", user.id)
              .executeTakeFirst()
            if (existing?.avatar_file_id) return
            const avatar = await createGeneratedUserAvatarFile(db, {
              userId: user.id,
              name: user.name,
              email: user.email,
            })
            await db
              .updateTable("users")
              .set({ avatar_file_id: avatar.fileId })
              .where("id", "=", user.id)
              .execute()
          } catch (error) {
            log.error(
              { err: error, userId: user.id },
              "Failed to generate user avatar on create (non-fatal)"
            )
          }
        },
      },
    },
    session: {
      delete: {
        after: async (session: { id: string }) => {
          // Disconnect any live WebSockets bound to a revoked session. Fires for
          // sign-out / revoke-session / revoke-sessions / revoke-other-sessions
          // / password-reset (BA's bulk delete wrapper runs this per row).
          // Best-effort: a redis publish failure must not fail the revoke.
          try {
            await disconnectSocketsForSession(session.id, "Session revoked")
          } catch (error) {
            log.error(
              { err: error, sessionId: session.id },
              "Failed to disconnect sockets after session delete (non-fatal)"
            )
          }
        },
      },
    },
  },

  plugins: [
    bearer(),
    expo(),
    deviceSessionCookie(),
    deviceAuthorization({
      expiresIn: "10m",
      interval: "5s",
      // First release: QR is scanned inside the app, which reads the user_code
      // directly; no standalone /device landing page is required yet.
      verificationUri: "/m/device",
      // Only our own first-party surfaces may drive the device flow.
      validateClient: async (clientId: string) =>
        clientId === "synapse-web" || clientId === "synapse-mobile",
      schema: {
        deviceCode: {
          modelName: "device_code",
          fields: {
            deviceCode: "device_code",
            userCode: "user_code",
            userId: "user_id",
            expiresAt: "expires_at",
            status: "status",
            lastPolledAt: "last_polled_at",
            pollingInterval: "polling_interval",
            clientId: "client_id",
            scope: "scope",
          },
        },
      },
    }),
    ...(feishuProvider ? [genericOAuth({ config: [feishuProvider] })] : []),
  ],
})

export type Auth = typeof auth
