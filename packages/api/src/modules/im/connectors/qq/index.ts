/**
 * QQ official-bot TransportConnector — registers into the IM connector
 * registry on import.
 *
 * Stage 1 wires the contract surface end-to-end:
 *   - capabilities (read by the dashboard + degradation pass)
 *   - credentials validation
 *   - config validation (was service/account-config.ts before the
 *     shared-prep refactor moved it to the polymorphic hook)
 *   - inbound (Stage 2/3 implement webhook + WS)
 *   - outbound (Stage 4/5/8 implement text/media/keyboard)
 *   - getBindingDefaults (webhook-unconfirmed accounts default
 *     outbound off + autoDisabledReason marker so the shared
 *     re-enable hook can lift the gate when the operator flips
 *     `webhookInboundConfirmed`)
 *   - planAccountRecoveryActions (returns the closed-enum
 *     AccountRecoveryAction[] for the generic executor)
 *   - getInteractionProjectionReadiness (gates QQ webhook accounts
 *     out of interaction projection until the operator confirms
 *     OQ2)
 *
 * Status / reaction adapters are null (QQ has no message edit, no
 * reaction concept on either C2C or group messages).
 */

import { ZodError } from "zod"
import { registerConnector } from "../registry.js"
import type {
  AccountRecoveryAction,
  TransportConnector,
  WebhookHandlerInput,
  WebhookHandlerResult,
} from "../types.js"
import {
  QQ_CONNECTOR_CAPABILITY,
  QQ_MESSAGE_CAPABILITIES,
} from "./capabilities.js"
import { validateQqCredentialsForMode } from "./credentials.js"
import { handleQqWebhook, startQqAccount } from "./inbound.js"
import { parseQqMentions, renderQqMention } from "./mentions.js"
import { sendQqMessage } from "./outbound.js"
import { createQqTypingAdapter } from "./typing.js"
import {
  normalizeQqAccountConfig,
  readQqAccountConfig,
} from "./qq-account-config.js"

export const qqConnector: TransportConnector = {
  transportKind: "qq",
  capability: QQ_CONNECTOR_CAPABILITY,
  messageCapabilities: QQ_MESSAGE_CAPABILITIES,

  validateCredentials(input) {
    const r = validateQqCredentialsForMode(
      input.credentials,
      input.connectionMode
    )
    return {
      ok: r.ok,
      errors: r.errors,
      normalized: r.normalized
        ? (r.normalized as unknown as Record<string, unknown>)
        : undefined,
    }
  },

  // Promotion of the QQ-specific config dispatcher (was
  // service/account-config.ts in the pre-merge branch) into the
  // generic `validateConfig?()` hook. Generic `account-credentials.ts:
  // validateAndNormalizeAccountConfig` consumes it; if QQ is the only
  // connector with a config schema, this hook is the only place we
  // need transport-specific config validation logic.
  validateConfig(input) {
    try {
      const normalized = normalizeQqAccountConfig(input.config)
      return {
        ok: true,
        normalized: normalized as unknown as Record<string, unknown>,
      }
    } catch (err) {
      if (err instanceof ZodError) {
        return {
          ok: false,
          errors: err.issues.map(
            (i) => `${i.path.join(".") || "(root)"}: ${i.message}`
          ),
        }
      }
      return {
        ok: false,
        errors: [err instanceof Error ? err.message : String(err)],
      }
    }
  },

  async startAccount(ctx) {
    return startQqAccount(ctx)
  },

  async sendMessage(input) {
    return sendQqMessage(input)
  },

  // QQ has no per-message reaction API on either C2C or groups.
  createStatusReactionAdapter() {
    return null
  },

  // QQ C2C input_notify shows the "typing" bubble for ~60s; group
  // endpoints have no equivalent (returns null). See typing.ts for
  // why we hand back {adapter, config:{heartbeatMs:50_000}} so the
  // controller refreshes inside the 60s expiry window.
  createTypingAdapter(input) {
    return createQqTypingAdapter(input)
  },

  parseInboundMentions(input) {
    return parseQqMentions(input)
  },

  renderOutboundMention(input) {
    return renderQqMention(input)
  },

  async handleWebhook(
    input: WebhookHandlerInput
  ): Promise<WebhookHandlerResult> {
    return handleQqWebhook(input)
  },

  // QQ webhook accounts whose operator has NOT yet confirmed
  // `webhookInboundConfirmed` cannot reliably reply (no inbound
  // anchor). Default the binding to outbound-off + stable marker so
  // the shared `reEnableAutoDisabledBindings` action can lift the
  // gate when the operator flips the flag.
  getBindingDefaults({ account }) {
    if (account.connectionMode === "webhook") {
      const config = readQqAccountConfig({
        config: (account.config ?? {}) as Record<string, unknown>,
      } as never)
      if (!config.webhookInboundConfirmed) {
        return {
          outboundEnabled: false,
          metadata: { autoDisabledReason: "webhook_inbound_unavailable" },
        }
      }
    }
    return { outboundEnabled: true }
  },

  // Emit closed-enum recovery actions for the transitions QQ cares
  // about. The shared executor in `service/accounts.ts` runs all
  // `reEnableAutoDisabledBindings` before any
  // `recoverSkippedInteractionProjections` per the order contract on
  // `AccountRecoveryAction`.
  planAccountRecoveryActions({ previous, next, incomingConfig }) {
    const actions: AccountRecoveryAction[] = []
    const newlyActive = previous.status !== "active" && next.status === "active"
    const switchedToLongConnection =
      previous.connectionMode !== "long_connection" &&
      next.connectionMode === "long_connection"
    const webhookJustConfirmed = (() => {
      if (incomingConfig === undefined) return false
      // `incomingConfig` reaching this hook means the caller actually
      // touched `config` on the update. Use the literal incoming flag
      // to detect the confirm step; comparing previous vs next would
      // misfire on any status update that left config untouched.
      const flag = (incomingConfig as { webhookInboundConfirmed?: unknown })
        .webhookInboundConfirmed
      return flag === true
    })()
    if (webhookJustConfirmed || switchedToLongConnection) {
      actions.push({
        type: "reEnableAutoDisabledBindings",
        reason: "webhook_inbound_unavailable",
      })
    }
    if (newlyActive) {
      actions.push({
        type: "recoverSkippedInteractionProjections",
        eventKind: "account_status_activated",
      })
    }
    if (switchedToLongConnection) {
      actions.push({
        type: "recoverSkippedInteractionProjections",
        eventKind: "connection_mode_changed_to_long_connection",
      })
    }
    if (webhookJustConfirmed) {
      actions.push({
        type: "recoverSkippedInteractionProjections",
        eventKind: "config_webhook_confirmed",
      })
    }
    return actions
  },

  // QQ inline-keyboard projection only works when the account has a
  // confirmed webhook inbound — the projection's button click comes
  // back as an INTERACTION_CREATE event on the same webhook channel.
  // Until the operator flips `webhookInboundConfirmed`, the
  // interaction-projection worker skips the projection and stamps
  // the reason on the row so the shared recovery code can re-arm
  // when the flag flips later.
  getInteractionProjectionReadiness(account) {
    if (account.connectionMode === "long_connection") return { ok: true }
    const config = readQqAccountConfig({
      config: (account.config ?? {}) as Record<string, unknown>,
    } as never)
    if (config.webhookInboundConfirmed) return { ok: true }
    return { ok: false, reason: "webhook_inbound_unavailable" }
  },
}

registerConnector(qqConnector)
