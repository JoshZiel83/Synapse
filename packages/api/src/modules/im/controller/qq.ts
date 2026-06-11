/**
 * QQ-specific REST endpoints.
 *
 * POST/PUT /im/accounts/qq routes that take QQ Bot credentials as discrete
 * fields and assemble the generic `credentials` + `config` JSON for the
 * shared account service.
 *
 * Why credentials vs config split:
 *   - `appId` + `clientSecret` (+ optional `botSecret` for Ed25519 if OQ1
 *     finds the QQ console exposes a separate secret) live in `credentials`.
 *     Connector reads them via getQqCredentialsOrThrow().
 *   - `webhookInboundConfirmed`, `allowProactiveBestEffort`, and
 *     `configuredUrlDomains` are non-secret operator toggles → `config`.
 *     Connector reads them via readQqAccountConfig() which also runs the
 *     server-side normalization (lowercase, strip scheme/path/port, reject
 *     wildcards/IPs).
 */

import type { FastifyInstance } from "fastify"
import { z } from "zod"
import { TransportAccountResponseSchema } from "@synapse/shared/schemas"
import { appRoute } from "../../../infrastructure/http/route.js"
import { sendData } from "../../../infrastructure/http/respond.js"
import {
  createTransportAccount,
  getTransportAccountById,
  updateTransportAccount,
} from "../service.js"
import { normalizeQqAccountConfig } from "../connectors/qq/qq-account-config.js"
import {
  qqAccountSchema,
  refreshTransportRuntimeState,
  requireWorkspaceAction,
  updateQqAccountSchema,
} from "./_shared.js"

/**
 * Normalize + validate the QQ config object that the API layer is about
 * to persist. Without this, wildcard / IP / mis-cased hostnames would
 * pass the lightweight `qqAccountSchema` (which only checks
 * `z.string().min(1)`) and only blow up at outbound-send time as a
 * generic `Error` retry. Funnel both create and update through here so
 * the API boundary is the place that says "no" to invalid config.
 *
 * Returns either the normalized config (ready to persist) or a
 * `FastifyReply`-shaped error tuple the caller forwards.
 */
function normalizeOrError(
  raw: Record<string, unknown>
):
  | { ok: true; config: Record<string, unknown> }
  | { ok: false; status: number; body: unknown } {
  try {
    const normalized = normalizeQqAccountConfig(raw)
    // `normalizeQqAccountConfig` returns the parsed Zod type; cast back
    // to the loose record shape the service layer takes.
    return { ok: true, config: { ...(normalized as Record<string, unknown>) } }
  } catch (err) {
    if (err instanceof z.ZodError) {
      return {
        ok: false,
        status: 400,
        body: {
          error: "invalid_qq_account_config",
          issues: err.issues.map((issue) => ({
            path: issue.path,
            code: issue.code,
            message: issue.message,
          })),
        },
      }
    }
    return {
      ok: false,
      status: 400,
      body: {
        error: "invalid_qq_account_config",
        message: err instanceof Error ? err.message : String(err),
      },
    }
  }
}

export default async function imQqController(
  app: FastifyInstance
): Promise<void> {
  appRoute(
    app,
    "POST",
    "/api/v1/workspaces/:workspaceId/im/accounts/qq",
    { schema: TransportAccountResponseSchema },
    async (request, reply): Promise<undefined> => {
      const allowed = await requireWorkspaceAction(
        request,
        reply,
        "workspace.manage",
        "Not allowed to manage IM accounts in this workspace"
      )
      if (!allowed) return

      const { workspaceId } = request.params as { workspaceId: string }
      const body = qqAccountSchema.parse(request.body)
      const credentials: Record<string, unknown> = {
        appId: body.appId,
        clientSecret: body.clientSecret,
      }
      if (body.botSecret) credentials.botSecret = body.botSecret
      // Normalize + validate at the API boundary so wildcards / IP
      // literals / bad casing are 400'd here, not at outbound-send time.
      const configResult = normalizeOrError({
        webhookInboundConfirmed: body.webhookInboundConfirmed ?? false,
        allowProactiveBestEffort: body.allowProactiveBestEffort ?? false,
        configuredUrlDomains: body.configuredUrlDomains ?? [],
      })
      if (!configResult.ok) {
        reply.status(configResult.status).send(configResult.body)
        return
      }
      const config = configResult.config

      const account = await createTransportAccount({
        workspaceId,
        transportKind: "qq",
        accountKey: body.accountKey || body.appId,
        displayName: body.displayName,
        ownerScope: body.ownerScope,
        ownerWorkspaceMemberId: body.ownerWorkspaceMemberId ?? null,
        connectionMode: body.connectionMode,
        status: body.status,
        inboundActorMode: body.inboundActorMode,
        inboundActorId:
          body.inboundActorId === null ? null : body.inboundActorId,
        credentials,
        config,
      })
      await refreshTransportRuntimeState()
      sendData(reply, TransportAccountResponseSchema, { account }, 201)
      return
    }
  )

  appRoute(
    app,
    "PUT",
    "/api/v1/workspaces/:workspaceId/im/accounts/qq/:accountId",
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
      const body = updateQqAccountSchema.parse(request.body)
      const credentials =
        body.appId || body.clientSecret || body.botSecret
          ? {
              ...(body.appId ? { appId: body.appId } : {}),
              ...(body.clientSecret ? { clientSecret: body.clientSecret } : {}),
              ...(body.botSecret ? { botSecret: body.botSecret } : {}),
            }
          : undefined
      // `updateTransportAccount` replaces `config` wholesale when a value
      // is passed, so we MUST merge the partial body into the current
      // server-side config — otherwise PUT {webhookInboundConfirmed:true}
      // would wipe `configuredUrlDomains` (and vice-versa). Read the
      // existing account, merge by key, send the full object.
      let config: Record<string, unknown> | undefined
      const hasConfigField =
        body.webhookInboundConfirmed !== undefined ||
        body.allowProactiveBestEffort !== undefined ||
        body.configuredUrlDomains !== undefined
      if (hasConfigField) {
        const existing = await getTransportAccountById(accountId)
        if (!existing || existing.workspaceId !== workspaceId) {
          reply.status(404).send({ error: "qq account not found" })
          return
        }
        // Wrong-kind hits are caught by shared `assertExpectedTransportKind`
        // inside `updateTransportAccount` (it sees
        // `expectedTransportKind: "qq"` we pass below) and surface as
        // 404 `transport_account_kind_mismatch`. Removing the local 409
        // branch keeps the response code stable across every per-kind
        // PUT (Feishu / WeCom / DingTalk / QQ).
        const existingConfig =
          existing.config && typeof existing.config === "object"
            ? (existing.config as Record<string, unknown>)
            : {}
        const merged: Record<string, unknown> = {
          ...existingConfig,
          ...(body.webhookInboundConfirmed !== undefined
            ? { webhookInboundConfirmed: body.webhookInboundConfirmed }
            : {}),
          ...(body.allowProactiveBestEffort !== undefined
            ? { allowProactiveBestEffort: body.allowProactiveBestEffort }
            : {}),
          ...(body.configuredUrlDomains !== undefined
            ? { configuredUrlDomains: body.configuredUrlDomains }
            : {}),
        }
        // Re-run normalization on the merged result so the new
        // `configuredUrlDomains` (if any) is normalized AND any pre-existing
        // garbage in the persisted config (from a pre-normalize-at-write
        // deploy, or future schema additions) is checked one more time.
        const configResult = normalizeOrError(merged)
        if (!configResult.ok) {
          reply.status(configResult.status).send(configResult.body)
          return
        }
        config = configResult.config
      }

      const account = await updateTransportAccount({
        workspaceId,
        accountId,
        // Per-transport route guard — assertExpectedTransportKind in
        // updateTransportAccount throws 404 `transport_account_kind_mismatch`
        // when the row's kind doesn't match "qq".
        expectedTransportKind: "qq",
        displayName: body.displayName,
        ownerScope: body.ownerScope,
        ownerWorkspaceMemberId: body.ownerWorkspaceMemberId,
        connectionMode: body.connectionMode,
        status: body.status,
        inboundActorMode: body.inboundActorMode,
        inboundActorId:
          body.inboundActorId === null ? null : body.inboundActorId,
        credentials,
        config,
      })
      await refreshTransportRuntimeState()
      return { account }
    }
  )
}
