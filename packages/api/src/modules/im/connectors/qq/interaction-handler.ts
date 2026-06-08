/**
 * QQ INTERACTION_CREATE handler (Stage 8).
 *
 * Click flow:
 *   1. WS gateway delivers an INTERACTION_CREATE event (event.id is the
 *      QQ-side platform-stable id).
 *   2. We parse button_data → recover `actionToken` via the
 *      `synapse-interaction:` prefix; reject other payloads (some other
 *      bot's button using the same account).
 *   3. lookupActionToken (DB-backed, idempotent — see action-tokens.ts)
 *      returns the original {interactionRequestId, payload}; missing or
 *      expired token → ACK with a "session expired" tip.
 *   4. Resolve the clicker → transport_address.workspace_member_id.
 *      Unbound user → ACK + send a "please bind" message.
 *   5. Ensure the clicker has a `conversation_participants` row in the
 *      interaction's conversation (group case: members who haven't
 *      spoken yet won't have one yet).
 *   6. Derive `commandId = uuidv5(qqEvent.id + actionToken + clicker)`
 *      so QQ event replays / our ACK retries land on the same idempotence
 *      cell inside resolveInteractionRequest.
 *   7. resolveInteractionRequest({decision, preset, ...}). Successful
 *      durable outcomes (applied / duplicate / conflict) → ACK.
 *   8. Transient failures (DB/network) → do NOT ACK; QQ will time the
 *      user's button loading out, and the user can click again.
 *
 * Why ACK *after* resolve (not before): QQ does NOT replay ACKed events.
 * If we ACK first and crash before persisting the resolution, the
 * approval is lost forever. The durable resolve takes ~tens of ms;
 * QQ's user-side button loader tolerates ≥ 5s so we comfortably fit.
 */

import { v5 as uuidv5 } from "uuid"
import { SYNAPSE_INTERACTION_NAMESPACE } from "@synapse/shared"
import {
  getTaskSummary,
  resolveInteractionRequest,
  type ResolveInteractionRequestParams,
} from "../../../interactions/service.js"
import { lookupActionToken } from "../../../interactions/action-tokens.js"
import {
  getTransportAddressByExternalId,
  syncTransportAddressConversationParticipant,
} from "../../service/addresses.js"
import { qqApiFetch } from "./client.js"
import { decodeMemberOpenid } from "./address-encoding.js"
import { parseQqInteractionButtonData } from "./keyboard.js"
import type { ConnectorLogger } from "../types.js"
import type { AccountStartContext } from "../types.js"

export interface QqInteractionCreateData {
  /** Platform-stable QQ event id (same across replays of one click). */
  id?: string
  /** Per-event button bag: `{ button_data, button_id }`. */
  data?: {
    resolved?: {
      button_data?: string
      button_id?: string
      user_id?: string
    }
    type?: number
  }
  /** Chat scope identifiers (only one of {group, c2c} is populated). */
  group_openid?: string
  group_member_openid?: string
  user_openid?: string
}

export interface QqInteractionHandlerDeps {
  /** Override only in tests; production uses the live `lookupActionToken`. */
  lookupActionToken: typeof lookupActionToken
  /** Same. */
  resolveInteractionRequest: typeof resolveInteractionRequest
  /** Same. */
  getTaskSummary: typeof getTaskSummary
  /** Same. */
  getTransportAddressByExternalId: typeof getTransportAddressByExternalId
  /** Same. */
  syncTransportAddressConversationParticipant: typeof syncTransportAddressConversationParticipant
  /** Resolver for the platform ACK call. Default uses qqApiFetch. */
  ackInteraction: (params: {
    account: AccountStartContext["account"]
    eventId: string
    code: number
  }) => Promise<void>
}

const PRESET_FOR_DECISION: Record<string, string> = {
  // Maps our action-token decision values to runtime-authorization presets.
  // The mint side encodes its intended preset directly in the payload, so
  // this map is only consulted as a fallback when payload.preset is unset.
  // Values must be in RUNTIME_AUTHORIZATION_PRESETS
  // ("once" | "actor" | "conversation" |
  //  "remote_agent" | "workspace").
  allow_once: "once",
  allow_conversation: "conversation",
  allow_actor: "actor",
}

export function defaultQqInteractionHandlerDeps(): QqInteractionHandlerDeps {
  return {
    lookupActionToken,
    resolveInteractionRequest,
    getTaskSummary,
    getTransportAddressByExternalId,
    syncTransportAddressConversationParticipant,
    ackInteraction: defaultAckInteraction,
  }
}

/**
 * Handle one INTERACTION_CREATE event. Never throws — failure modes
 * map to either "ack + user-visible error" or "deliberately don't ack
 * so the user can retry".
 */
export async function handleQqInteractionCreate(params: {
  account: AccountStartContext["account"]
  data: QqInteractionCreateData
  logger: ConnectorLogger
  deps?: QqInteractionHandlerDeps
}): Promise<void> {
  const deps = params.deps ?? defaultQqInteractionHandlerDeps()
  const { account, data, logger } = params
  const eventId = data.id
  if (!eventId) {
    logger.warn("qq-interaction: missing event id; dropping")
    return
  }

  // Step 2: parse button_data
  const parsed = parseQqInteractionButtonData(data.data?.resolved?.button_data)
  if (!parsed) {
    logger.info("qq-interaction: ignoring non-synapse button payload", {
      eventId,
    })
    // ACK so the loading state clears on the user's side even though
    // we won't act — leaving it would hang the UI on a button we don't
    // own.
    await safeAck(deps, account, eventId, 0, logger)
    return
  }

  // Step 3: lookupActionToken (idempotent)
  const tokenRecord = await deps.lookupActionToken(parsed.actionToken)
  if (!tokenRecord) {
    logger.info("qq-interaction: action token expired or unknown", {
      eventId,
      actionToken: parsed.actionToken,
    })
    await safeAck(deps, account, eventId, 0, logger)
    return
  }

  // Step 4: derive clicker external id + workspace member
  const clickerExternalId = deriveClickerExternalId(data)
  if (!clickerExternalId) {
    logger.warn("qq-interaction: missing clicker openid", { eventId })
    await safeAck(deps, account, eventId, 0, logger)
    return
  }
  const clickerAddress = await deps.getTransportAddressByExternalId({
    transportAccountId: account.id,
    externalId: clickerExternalId,
    addressType: "user",
  })
  if (!clickerAddress?.workspace_member_id) {
    logger.info("qq-interaction: clicker not bound to a workspace member", {
      eventId,
      clickerExternalId,
    })
    // Ack so loading clears; future revision can also POST a hint
    // message via outbound — but that requires a fresh anchor which we
    // don't have synchronously here.
    await safeAck(deps, account, eventId, 0, logger)
    return
  }

  // Need the interaction summary to learn its workspace + conversation
  // (for participant sync) and so we can short-circuit before calling
  // resolve if the interaction is already gone.
  const interaction = await deps.getTaskSummary(
    tokenRecord.interactionRequestId
  )
  if (!interaction) {
    logger.info("qq-interaction: target interaction no longer exists", {
      eventId,
      interactionRequestId: tokenRecord.interactionRequestId,
    })
    await safeAck(deps, account, eventId, 0, logger)
    return
  }

  // Step 5: ensure conversation_participants row exists
  let participantId: string
  try {
    const participant = await deps.syncTransportAddressConversationParticipant({
      conversationId: interaction.conversationId,
      transportAddressId: clickerAddress.id,
      workspaceMemberId: clickerAddress.workspace_member_id,
      recordJoinEvent: true,
    })
    participantId = participant.id
  } catch (err) {
    logger.error("qq-interaction: failed to ensure participant row", err, {
      eventId,
    })
    // Transient — don't ACK so QQ marks the click as failed/timed out;
    // the user can try again.
    return
  }

  // Step 6: deterministic commandId — same input → same UUID, so QQ
  // replays of the same event hit the resolveInteractionRequest
  // dedup cell.
  const commandId = deriveCommandId({
    qqEventId: eventId,
    actionToken: parsed.actionToken,
    clickerExternalId,
  })

  // Step 7: resolve
  const baseRevision = interaction.revision
  const decision = tokenRecord.payload.decision
  const params7: ResolveInteractionRequestParams =
    decision === "reject"
      ? {
          interactionId: tokenRecord.interactionRequestId,
          commandId,
          baseRevision,
          resolverWorkspaceMemberId: clickerAddress.workspace_member_id,
          resolverParticipantId: participantId,
          decision: "reject",
        }
      : {
          interactionId: tokenRecord.interactionRequestId,
          commandId,
          baseRevision,
          resolverWorkspaceMemberId: clickerAddress.workspace_member_id,
          resolverParticipantId: participantId,
          decision: "approve",
          // Runtime-authorization approves carry preset + grant option.
          preset: ((tokenRecord.payload.preset ||
            PRESET_FOR_DECISION[decision]) ??
            "once") as never,
          selectedGrantOptionId:
            tokenRecord.payload.selectedGrantOptionId ?? "primary",
        }
  try {
    const result = await deps.resolveInteractionRequest(params7)
    logger.info("qq-interaction: resolved", {
      eventId,
      interactionRequestId: tokenRecord.interactionRequestId,
      outcome: result.outcome,
    })
    // Step 7 (success / durable outcome): ACK
    await safeAck(deps, account, eventId, 0, logger)
  } catch (err) {
    // Distinguish permanent (don't retry) vs transient (let user retry).
    if (isPermanentResolveError(err)) {
      logger.warn("qq-interaction: permanent resolve error; ACK to clear UI", {
        eventId,
        err: errorMessage(err),
      })
      await safeAck(deps, account, eventId, 0, logger)
      return
    }
    logger.error(
      "qq-interaction: transient resolve error; not ACKing so user can retry",
      err,
      { eventId }
    )
    // No ACK — QQ will eventually time out the loading state and the
    // user can click again, which produces the same commandId so the
    // request is idempotent.
  }
}

function deriveClickerExternalId(data: QqInteractionCreateData): string | null {
  // Group event → encode as `gm:{group_openid}:{group_member_openid}`
  // (this is the address-encoding convention used elsewhere in the QQ
  // connector — see address-encoding.ts decodeMemberOpenid).
  if (data.group_openid && data.group_member_openid) {
    return `gm:${data.group_openid}:${data.group_member_openid}`
  }
  // C2C event → `c2c:{user_openid}`
  if (data.user_openid) return `c2c:${data.user_openid}`
  return null
}

function deriveCommandId(params: {
  qqEventId: string
  actionToken: string
  clickerExternalId: string
}): string {
  const name = `qq-interaction:${params.qqEventId}:${params.actionToken}:${params.clickerExternalId}`
  return uuidv5(name, SYNAPSE_INTERACTION_NAMESPACE)
}

function isPermanentResolveError(err: unknown): boolean {
  const msg = errorMessage(err).toLowerCase()
  if (!msg) return false
  // Heuristics based on resolveInteractionRequest's throw sites — these
  // are stable error strings, not codes, so we match on substring. If
  // any of these change we should add a dedicated error class.
  return (
    msg.includes("interaction request not found") ||
    msg.includes("only the targeted user can resolve this interaction") ||
    msg.includes("you are not allowed to resolve") ||
    msg.includes("missing device_id") ||
    msg.includes("missing device_capability_id") ||
    msg.includes(
      "commandid"
    ) /* commandId reuse with a different payload (programmer error) */
  )
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function defaultAckInteraction(params: {
  account: AccountStartContext["account"]
  eventId: string
  code: number
}): Promise<void> {
  // QQ ACK: PUT /interactions/{event_id} body {code}
  await qqApiFetch(
    params.account,
    `/interactions/${encodeURIComponent(params.eventId)}`,
    {
      method: "PUT",
      body: JSON.stringify({ code: params.code }),
    }
  )
}

async function safeAck(
  deps: QqInteractionHandlerDeps,
  account: AccountStartContext["account"],
  eventId: string,
  code: number,
  logger: ConnectorLogger
): Promise<void> {
  try {
    await deps.ackInteraction({ account, eventId, code })
  } catch (err) {
    logger.warn("qq-interaction: ACK failed (best-effort)", {
      eventId,
      err: errorMessage(err),
    })
  }
}

// Re-export so inbound-ws can call decodeMemberOpenid via this module if
// it ever wants to (kept here so the import surface stays small).
export { decodeMemberOpenid }
