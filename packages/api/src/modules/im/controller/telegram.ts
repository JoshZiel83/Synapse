/**
 * Telegram-specific REST endpoints (mounted as a Fastify plugin from
 * controller.ts).
 *
 * POST/PUT /im/accounts/telegram routes that take a BotFather token (+ an
 * optional webhook secret-token for webhook mode) as discrete fields and
 * assemble the generic `credentials` JSON for the shared account service.
 *
 * The async work that the SYNC validators cannot do lives HERE:
 *   - `getMe` probe — confirm the token is live and learn the bot username
 *     (stored in `config.botUsername` for `@mention` / `/cmd@bot` detection).
 *   - `setWebhook` / `deleteWebhook` registration on create/update, driven by
 *     `connectionMode`: webhook mode registers the public webhook + secret
 *     token; long_connection mode deletes any existing webhook so getUpdates
 *     won't 409.
 *
 * Local zod schemas (NOT added to shared/schemas/im.ts) reuse the shared
 * owner/inbound-actor shapes + validators re-exported from `_shared.ts`.
 */

import type { FastifyInstance } from "fastify"
import { TransportAccountResponseSchema } from "@synapse/shared/schemas"
import { appRoute } from "../../../infrastructure/http/route.js"
import { config } from "../../../config/index.js"
import { createLogger } from "../../../infrastructure/logger/index.js"
import {
  createTransportAccount,
  getTransportAccountById,
  updateTransportAccount,
} from "../service.js"
import { callMethod } from "../connectors/telegram/client.js"
import type { TelegramCredentials } from "../connectors/telegram/credentials.js"
import type { TelegramBotInfo } from "../connectors/telegram/types.js"
import {
  refreshTransportRuntimeState,
  requireWorkspaceAction,
  telegramAccountSchema,
  updateTelegramAccountSchema,
} from "./_shared.js"

const log = createLogger("im.telegram")

// ───────────────────────── Probe + webhook lifecycle ─────────────────────────

/** Confirm the token and learn the bot username (getMe probe). */
async function probeBot(creds: TelegramCredentials): Promise<TelegramBotInfo> {
  return callMethod<TelegramBotInfo>(creds, "getMe", {})
}

/**
 * Build the public webhook URL for an account. Best-effort from
 * `config.app.baseUrl` (the public app origin). NOTE: this assumes the API is
 * reachable under the same origin as the app; deployments that split the two
 * must front the API webhook path accordingly. Returns undefined when no base
 * URL is configured.
 */
function webhookUrl(accountId: string): string | undefined {
  const base = config.app.baseUrl?.replace(/\/+$/, "")
  if (!base) return undefined
  return `${base}/api/v1/im/webhooks/telegram/${accountId}`
}

/**
 * Reconcile the platform-side webhook to match the account's connection mode.
 * webhook mode → setWebhook(url, secret_token, allowed_updates); other modes →
 * deleteWebhook so getUpdates won't 409. Best-effort: logs and continues on
 * failure (the runtime + long-poll loop also self-heal).
 */
async function reconcileWebhook(input: {
  creds: TelegramCredentials
  connectionMode: string
  accountId: string
}): Promise<void> {
  try {
    if (input.connectionMode === "webhook") {
      const url = webhookUrl(input.accountId)
      if (!url) {
        log.warn(
          { accountId: input.accountId },
          "telegram: no app.baseUrl configured; cannot register webhook"
        )
        return
      }
      await callMethod(input.creds, "setWebhook", {
        url,
        secret_token: input.creds.webhookSecretToken,
        allowed_updates: [
          "message",
          "edited_message",
          "channel_post",
          "message_reaction",
          "chat_member",
          "my_chat_member",
        ],
      })
    } else {
      await callMethod(input.creds, "deleteWebhook", {
        drop_pending_updates: false,
      })
    }
  } catch (err) {
    log.warn(
      {
        accountId: input.accountId,
        connectionMode: input.connectionMode,
        err: String(err),
      },
      "telegram: webhook reconcile failed"
    )
  }
}

// ───────────────────────── Routes ─────────────────────────

export default async function imTelegramController(
  app: FastifyInstance
): Promise<void> {
  appRoute(
    app,
    "POST",
    "/api/v1/workspaces/:workspaceId/im/accounts/telegram",
    { schema: TransportAccountResponseSchema },
    async (request, reply) => {
      const allowed = await requireWorkspaceAction(
        request,
        reply,
        "workspace.manage",
        "Not allowed to manage IM accounts in this workspace"
      )
      if (!allowed) return

      const { workspaceId } = request.params as { workspaceId: string }
      const body = telegramAccountSchema.parse(request.body)

      if (body.connectionMode === "webhook" && !body.webhookSecretToken) {
        reply.status(400).send({
          error: "invalid_telegram_credentials",
          message: "webhookSecretToken is required for webhook mode",
        })
        return
      }

      const creds: TelegramCredentials = { botToken: body.botToken }
      if (body.webhookSecretToken) {
        creds.webhookSecretToken = body.webhookSecretToken
      }
      if (body.apiRoot) creds.apiRoot = body.apiRoot.replace(/\/+$/, "")

      // Live probe: confirm the token + learn the bot username.
      let botInfo: TelegramBotInfo
      try {
        botInfo = await probeBot(creds)
      } catch (err) {
        reply.status(400).send({
          error: "invalid_telegram_credentials",
          message: `getMe probe failed: ${err instanceof Error ? err.message : String(err)}`,
        })
        return
      }

      const credentials: Record<string, unknown> = { botToken: body.botToken }
      if (body.webhookSecretToken) {
        credentials.webhookSecretToken = body.webhookSecretToken
      }
      if (creds.apiRoot) credentials.apiRoot = creds.apiRoot
      const accountConfig: Record<string, unknown> = {
        botUsername: botInfo.username ?? null,
        botId: botInfo.id,
      }

      const account = await createTransportAccount({
        workspaceId,
        transportKind: "telegram",
        accountKey: body.accountKey || botInfo.username || String(botInfo.id),
        displayName: body.displayName,
        ownerScope: body.ownerScope,
        ownerWorkspaceMemberId: body.ownerWorkspaceMemberId ?? null,
        connectionMode: body.connectionMode,
        status: body.status,
        inboundActorMode: body.inboundActorMode,
        inboundActorId:
          body.inboundActorId === null ? null : body.inboundActorId,
        credentials,
        config: accountConfig,
      })

      await reconcileWebhook({
        creds,
        connectionMode: body.connectionMode,
        accountId: account.id,
      })
      await refreshTransportRuntimeState()
      reply.status(201)
      return { account }
    }
  )

  appRoute(
    app,
    "PUT",
    "/api/v1/workspaces/:workspaceId/im/accounts/telegram/:accountId",
    { schema: TransportAccountResponseSchema },
    async (request, reply) => {
      const allowed = await requireWorkspaceAction(
        request,
        reply,
        "workspace.manage",
        "Not allowed to manage IM accounts in this workspace"
      )
      if (!allowed) return

      const { workspaceId, accountId } = request.params as {
        workspaceId: string
        accountId: string
      }
      const body = updateTelegramAccountSchema.parse(request.body)

      // Only include credentials if at least one field was supplied —
      // otherwise the service treats the JSONB column as a total replacement
      // and would wipe previously stored values.
      const hasCredField =
        body.botToken !== undefined ||
        body.webhookSecretToken !== undefined ||
        body.apiRoot !== undefined
      const credentials = hasCredField
        ? {
            ...(body.botToken ? { botToken: body.botToken } : {}),
            ...(body.webhookSecretToken
              ? { webhookSecretToken: body.webhookSecretToken }
              : {}),
            ...(body.apiRoot
              ? { apiRoot: body.apiRoot.replace(/\/+$/, "") }
              : {}),
          }
        : undefined

      const account = await updateTransportAccount({
        workspaceId,
        accountId,
        expectedTransportKind: "telegram",
        displayName: body.displayName,
        ownerScope: body.ownerScope,
        ownerWorkspaceMemberId: body.ownerWorkspaceMemberId,
        connectionMode: body.connectionMode,
        status: body.status,
        inboundActorMode: body.inboundActorMode,
        inboundActorId:
          body.inboundActorId === null ? null : body.inboundActorId,
        credentials,
        config: undefined,
      })

      // Reconcile the webhook against the (possibly changed) effective creds +
      // connection mode. Read the persisted row so we use the merged creds.
      const persisted = await getTransportAccountById(accountId)
      if (persisted && persisted.workspaceId === workspaceId) {
        const merged = (persisted.credentials ?? {}) as Record<string, unknown>
        const botToken =
          typeof merged.botToken === "string" ? merged.botToken : ""
        const effective: TelegramCredentials = {
          botToken,
          ...(typeof merged.webhookSecretToken === "string"
            ? { webhookSecretToken: merged.webhookSecretToken }
            : {}),
          ...(typeof merged.apiRoot === "string"
            ? { apiRoot: merged.apiRoot }
            : {}),
        }
        if (effective.botToken) {
          await reconcileWebhook({
            creds: effective,
            connectionMode: persisted.connectionMode,
            accountId,
          })
        }
      }
      await refreshTransportRuntimeState()
      return { account }
    }
  )
}
