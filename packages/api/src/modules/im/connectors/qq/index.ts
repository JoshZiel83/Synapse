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
 *   - getBindingDefaults (a webhook account with the inbound kill-switch
 *     off defaults outbound off + autoDisabledReason marker so the shared
 *     re-enable hook can lift the gate when `webhookInboundConfirmed` is
 *     turned back on; default/true → outbound on)
 *   - planAccountRecoveryActions (returns the closed-enum
 *     AccountRecoveryAction[] for the generic executor)
 *   - getTaskProjectionReadiness (gates QQ webhook accounts
 *     out of task projection until the operator confirms
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

  // QQ Bot OpenAPI v2 has no typing-indicator API, so this always
  // returns null (see typing.ts). Kept wired for contract symmetry.
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

  // A webhook account with the inbound KILL-SWITCH off
  // (`webhookInboundConfirmed: false`) cannot reliably reply (no inbound
  // anchor). Default that binding to outbound-off + stable marker so the
  // shared `reEnableAutoDisabledBindings` action can lift the gate when
  // the operator turns inbound back on. Default/true → outbound on.
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
  // `recoverSkippedTaskProjections` per the order contract on
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
        type: "recoverSkippedTaskProjections",
        eventKind: "account_status_activated",
      })
    }
    if (switchedToLongConnection) {
      actions.push({
        type: "recoverSkippedTaskProjections",
        eventKind: "connection_mode_changed_to_long_connection",
      })
    }
    if (webhookJustConfirmed) {
      actions.push({
        type: "recoverSkippedTaskProjections",
        eventKind: "config_webhook_confirmed",
      })
    }
    return actions
  },

  // QQ inline-keyboard projection needs webhook inbound enabled — the
  // button click comes back as an INTERACTION_CREATE on the same webhook
  // channel. If the operator turned the inbound kill-switch off
  // (`webhookInboundConfirmed: false`), the task-projection worker skips
  // the projection and stamps the reason so the shared recovery code can
  // re-arm when the flag is turned back on.
  getTaskProjectionReadiness(account) {
    if (account.connectionMode === "long_connection") return { ok: true }
    const config = readQqAccountConfig({
      config: (account.config ?? {}) as Record<string, unknown>,
    } as never)
    if (config.webhookInboundConfirmed) return { ok: true }
    return { ok: false, reason: "webhook_inbound_unavailable" }
  },
}

registerConnector(qqConnector)
