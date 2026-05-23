import crypto from "node:crypto"
import { db } from "../../infrastructure/database/kysely.js"
import type {
  ConversationTransportBindingSummary,
  TransportAccountSummary,
  TransportEndpointType,
} from "@synapse/shared/types"
import { emitEvent } from "../../infrastructure/events/index.js"
import { redis } from "../../infrastructure/redis/index.js"
import { tryGetConnector } from "./connectors/registry.js"
import type { InboundEnvelope } from "./connectors/types.js"
import { derivePlainText } from "./messaging/canonical-message.js"
import { mergeInboundMetadata } from "./ingest-metadata.js"
import {
  accountFingerprint,
  runtimeHandles,
  type RuntimeHandle,
} from "./runtime/handle.js"
import {
  acquireTransportRuntimeLease,
  releaseTransportRuntimeLease,
  renewTransportRuntimeLease,
} from "./runtime/lease.js"
import {
  createConversation,
  createConversationItem,
  enqueueActorWakeupsForConversationMessage,
  ensureConversationParticipant,
} from "../chat/service.js"
import { getWorkspaceChiefActorPreference } from "../workspace/service.js"
import {
  consumeTransportAccountAutoLink,
  ensureTransportAddress,
  findConversationTransportBindingByEndpoint,
  findTransportMessageLinkByExternalMessage,
  getPendingTransportAccountAutoLinkWorkspaceMemberId,
  getTransportAccountByKindAndId,
  listActiveTransportAccounts,
  queueConversationTransportProjection,
  syncTransportAddressConversationParticipant,
  updateTransportAddressMetadata,
  updateTransportEndpointMetadata,
  updateTransportMessageLinkStatus,
  upsertConversationTransportBinding,
} from "./service.js"

function connectorEnvelopeToLegacyInbound(
  envelope: InboundEnvelope,
  account: TransportAccountSummary
): GenericInboundMessage {
  const content =
    envelope.message.plainText || derivePlainText(envelope.message.parts)
  return {
    account,
    endpointType: envelope.endpointType,
    endpointExternalId: envelope.endpointExternalId,
    endpointDisplayName: envelope.endpointDisplayName,
    externalMessageId: envelope.externalMessageId,
    senderExternalId: envelope.sender.externalId,
    senderDisplayName: envelope.sender.displayName,
    content,
    metadata: {
      ...(envelope.raw || {}),
      transport: {
        canonicalParts: envelope.message.parts,
        externalReplyToId: envelope.externalReplyToId,
        externalThreadId: envelope.externalThreadId,
      },
    },
    senderMetadata: envelope.sender.metadata,
    endpointMetadata: envelope.endpointMetadata,
  }
}

type GenericInboundMessage = {
  account: TransportAccountSummary
  endpointType: TransportEndpointType
  endpointExternalId: string
  endpointDisplayName?: string
  externalMessageId: string
  senderExternalId: string
  senderDisplayName?: string
  content: string
  metadata?: Record<string, unknown>
  senderMetadata?: Record<string, unknown>
  endpointMetadata?: Record<string, unknown>
}

const RUNTIME_RECONCILE_INTERVAL_MS = 15_000
let reconcileTimer: NodeJS.Timeout | null = null
let reconcilePromise: Promise<void> | null = null

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value)
      return parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)
        : {}
    } catch {
      return {}
    }
  }
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {}
}

function nonEmptyString(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const normalized: string | undefined = nonEmptyString(entry)
      if (normalized) return normalized
    }
    return undefined
  }
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function waitForAbort(signal: AbortSignal) {
  if (signal.aborted) {
    return Promise.resolve()
  }
  return new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true })
  })
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => resolve(), ms)
    if (!signal) return
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer)
        reject(new Error("aborted"))
      },
      { once: true }
    )
  })
}

async function getWorkspaceOwnerId(workspaceId: string) {
  const row = await db
    .selectFrom("workspaces")
    .select("owner_id")
    .where("id", "=", workspaceId)
    .limit(1)
    .executeTakeFirst()
  const ownerId = row?.owner_id
  if (!ownerId) {
    throw new Error(`Workspace ${workspaceId} not found`)
  }
  return ownerId
}

async function ensureTransportConversationBinding(params: {
  account: TransportAccountSummary
  endpointType: TransportEndpointType
  endpointExternalId: string
  endpointDisplayName?: string
}) {
  const existing = await findConversationTransportBindingByEndpoint({
    transportAccountId: params.account.id,
    endpointType: params.endpointType,
    endpointExternalId: params.endpointExternalId,
  })
  if (existing) {
    return existing
  }

  await getWorkspaceOwnerId(params.account.workspaceId)
  const created = await createConversation({
    workspaceId: params.account.workspaceId,
    kind: "virtual",
    boundary: "external",
    title:
      params.endpointDisplayName ||
      `${params.account.displayName} ${params.endpointType === "group" ? "群聊" : "私聊"}`,
  })

  try {
    return await upsertConversationTransportBinding({
      workspaceId: params.account.workspaceId,
      conversationId: created.id as string,
      transportAccountId: params.account.id,
      endpointType: params.endpointType,
      endpointExternalId: params.endpointExternalId,
      endpointDisplayName: params.endpointDisplayName,
      outboundEnabled: true,
      inboundActorMode: "inherit_account",
      metadata: {
        autoCreated: true,
      },
    })
  } catch (error: any) {
    if (error?.code === "23505") {
      return findConversationTransportBindingByEndpoint({
        transportAccountId: params.account.id,
        endpointType: params.endpointType,
        endpointExternalId: params.endpointExternalId,
      })
    }
    throw error
  }
}

async function resolveDefaultWakeTarget(
  binding: ConversationTransportBindingSummary
) {
  let actorId: string | null = null

  if (binding.inboundActorMode === "specified_actor") {
    actorId = binding.inboundActorId || null
  } else if (binding.inboundActorMode === "inherit_account") {
    if (binding.account.inboundActorMode === "specified_actor") {
      actorId = binding.account.inboundActorId || null
    } else if (
      binding.account.inboundActorMode === "follow_owner_chief_actor" &&
      binding.account.ownerScope === "workspace_member" &&
      binding.account.ownerWorkspaceMemberId
    ) {
      const preference = await getWorkspaceChiefActorPreference(
        binding.workspaceId,
        binding.account.ownerWorkspaceMemberId
      )
      actorId = preference.chiefActorId || null
    }
  }

  if (!actorId) return null

  const target = await ensureConversationParticipant({
    conversationId: binding.conversationId,
    participantKind: "actor",
    actorId,
  })

  if (!target?.id) return null
  return {
    participantId: target.id as string,
    actorId,
  }
}

async function ingestInboundTransportMessage(params: GenericInboundMessage) {
  const binding = await ensureTransportConversationBinding({
    account: params.account,
    endpointType: params.endpointType,
    endpointExternalId: params.endpointExternalId,
    endpointDisplayName: params.endpointDisplayName,
  })
  if (!binding) {
    throw new Error(
      "Unable to resolve conversation binding for inbound message"
    )
  }

  const existingLink = await findTransportMessageLinkByExternalMessage({
    transportAccountId: params.account.id,
    transportEndpointId: binding.endpoint.id,
    externalMessageId: params.externalMessageId,
    direction: "inbound",
  })
  if (existingLink) {
    return existingLink
  }

  const senderAddress = await ensureTransportAddress({
    workspaceId: binding.workspaceId,
    transportAccountId: params.account.id,
    transportKind: params.account.transportKind,
    addressType: "user",
    externalId: params.senderExternalId,
    displayName: params.senderDisplayName,
    metadata: params.senderMetadata,
  })
  if (!senderAddress) {
    throw new Error("Failed to create sender transport address")
  }
  let linkedWorkspaceMemberId =
    typeof senderAddress.workspace_member_id === "string" &&
    senderAddress.workspace_member_id.trim()
      ? senderAddress.workspace_member_id
      : undefined
  if (!linkedWorkspaceMemberId) {
    const pendingAutoLinkWorkspaceMemberId =
      getPendingTransportAccountAutoLinkWorkspaceMemberId(params.account)
    if (pendingAutoLinkWorkspaceMemberId) {
      await consumeTransportAccountAutoLink({
        account: params.account,
        transportAddressId: senderAddress.id,
        targetWorkspaceMemberId: pendingAutoLinkWorkspaceMemberId,
        matchedExternalId: params.senderExternalId,
      })
      if (
        params.account.metadata &&
        typeof params.account.metadata === "object"
      ) {
        delete (params.account.metadata as Record<string, unknown>)
          .pendingAutoLinkWorkspaceMemberId
        delete (params.account.metadata as Record<string, unknown>)
          .pendingAutoLinkMode
        delete (params.account.metadata as Record<string, unknown>)
          .pendingAutoLinkConfiguredAt
      }
      linkedWorkspaceMemberId = pendingAutoLinkWorkspaceMemberId
    }
  }
  const senderParticipant = await syncTransportAddressConversationParticipant({
    conversationId: binding.conversationId,
    transportAddressId: senderAddress.id,
    workspaceMemberId: linkedWorkspaceMemberId,
    displayName:
      params.senderDisplayName || params.senderExternalId || "External user",
  })
  if (params.senderMetadata) {
    await updateTransportAddressMetadata({
      transportAddressId: senderAddress.id,
      metadata: params.senderMetadata,
    })
  }
  if (params.endpointMetadata) {
    await updateTransportEndpointMetadata({
      endpointId: binding.endpoint.id,
      metadata: params.endpointMetadata,
    })
  }

  const wakeTarget = await resolveDefaultWakeTarget(binding)
  const normalizedContent =
    nonEmptyString(params.content) ||
    `[${params.account.transportKind} message]`
  // Deep-merge metadata so connector-supplied transport fields (e.g.
  // canonicalParts, externalReplyToId, externalThreadId) extend rather than
  // overwrite the runtime-built transport descriptor below. Runtime-built
  // keys always win to prevent connector payloads from spoofing identity.
  const mergedMetadata = mergeInboundMetadata(
    {
      direction: "inbound",
      transportKind: params.account.transportKind,
      transportAccountId: params.account.id,
      endpointType: params.endpointType,
      endpointExternalId: params.endpointExternalId,
      externalMessageId: params.externalMessageId,
      transportAddressId: senderAddress.id,
      senderExternalId: params.senderExternalId,
    },
    params.metadata
  )

  const item = await createConversationItem({
    workspaceId: binding.workspaceId,
    conversationId: binding.conversationId,
    scope: "shared",
    surface: "visible",
    itemType: "message",
    subtype: "chat.message",
    role: "user",
    authorParticipantId: senderParticipant.id,
    metadata: mergedMetadata,
    parts: [
      {
        type: "text",
        text: normalizedContent,
      },
    ],
  })

  // Extract reply/thread ids the connector put in incoming transport metadata
  // (see ingest-metadata.ts merge rules). Persist them onto their own columns.
  const mergedTransport =
    (mergedMetadata.transport as Record<string, unknown> | undefined) || {}
  const externalReplyToId =
    typeof mergedTransport.externalReplyToId === "string"
      ? mergedTransport.externalReplyToId
      : undefined
  const externalThreadId =
    typeof mergedTransport.externalThreadId === "string"
      ? mergedTransport.externalThreadId
      : undefined

  const link = await queueConversationTransportProjection({
    workspaceId: binding.workspaceId,
    conversationId: binding.conversationId,
    itemId: item.id,
    direction: "inbound",
    externalMessageId: params.externalMessageId,
    externalReplyToId,
    externalThreadId,
    metadata: {
      transportKind: params.account.transportKind,
      senderExternalId: params.senderExternalId,
      endpointExternalId: params.endpointExternalId,
    },
  })
  if (link?.id) {
    await updateTransportMessageLinkStatus({
      linkId: link.id,
      status: "sent",
      externalMessageId: params.externalMessageId,
    })
  }

  await enqueueActorWakeupsForConversationMessage({
    workspaceId: binding.workspaceId,
    conversationId: binding.conversationId,
    itemId: item.id,
  })
  const { notifyRemoteAgentDeliveriesForConversation } =
    await import("../remote-agents/service.js")
  await notifyRemoteAgentDeliveriesForConversation(binding.conversationId)

  return link
}

async function startRuntimeForAccount(
  account: TransportAccountSummary,
  leaseToken: string
) {
  const abortController = new AbortController()
  const fingerprint = accountFingerprint(account)

  const run = async () => {
    // Prefer the new TransportConnector path when a connector is registered
    // for this transport_kind. The old per-kind if/else fall-throughs below
    // remain for transports that haven't been ported yet (weixin in v1).
    const connector = tryGetConnector(account.transportKind)
    if (connector) {
      const running = await connector.startAccount({
        account,
        signal: abortController.signal,
        emitInbound: async (envelope) => {
          await ingestInboundTransportMessage(
            connectorEnvelopeToLegacyInbound(envelope, account)
          )
        },
        logger: {
          debug: () => {},
          info: (msg, fields) =>
            console.log(`[im:${account.transportKind}] ${msg}`, fields || ""),
          warn: (msg, fields) =>
            console.warn(`[im:${account.transportKind}] ${msg}`, fields || ""),
          error: (msg, err, fields) =>
            console.error(
              `[im:${account.transportKind}] ${msg}`,
              err,
              fields || ""
            ),
        },
      })
      try {
        await waitForAbort(abortController.signal)
      } finally {
        await running.stop().catch(() => undefined)
      }
      return
    }

    // No connector registered — log and exit. The legacy weixin pollWeixinAccount
    // branch is gone; the weixin connector now handles long-poll. This branch is
    // reachable only if a TRANSPORT_KIND is added to the enum without a connector.
    console.warn(
      `[im] no TransportConnector for transport_kind=${account.transportKind}`
    )
  }

  const promise = run()
    .catch((error) => {
      if (!abortController.signal.aborted) {
        console.error(
          `[im] Transport runtime crashed for account ${account.id}:`,
          error
        )
      }
    })
    .finally(() => {
      const current = runtimeHandles.get(account.id)
      if (current?.fingerprint === fingerprint) {
        runtimeHandles.delete(account.id)
      }
    })

  runtimeHandles.set(account.id, {
    accountId: account.id,
    fingerprint,
    leaseToken,
    stop: async () => {
      abortController.abort()
      await promise
      await releaseTransportRuntimeLease(account.id, leaseToken).catch(
        () => undefined
      )
    },
  })
}

async function reconcileTransportRuntimesOnce() {
  const desiredAccounts = await listActiveTransportAccounts({
    connectionMode: "long_connection",
  })
  const desiredById = new Map(
    desiredAccounts.map((account) => [account.id, account])
  )

  for (const [accountId, handle] of runtimeHandles.entries()) {
    const desired = desiredById.get(accountId)
    const shouldStop =
      !desired ||
      handle.fingerprint !== accountFingerprint(desired) ||
      !(await renewTransportRuntimeLease(accountId, handle.leaseToken))
    if (shouldStop) {
      await handle.stop().catch((error) => {
        console.error(
          `[im] Failed to stop runtime for account ${accountId}:`,
          error
        )
      })
    }
  }

  for (const account of desiredAccounts) {
    if (runtimeHandles.has(account.id)) continue
    const leaseToken = await acquireTransportRuntimeLease(account.id)
    if (!leaseToken) continue
    await startRuntimeForAccount(account, leaseToken)
  }
}

async function reconcileTransportRuntimes() {
  if (reconcilePromise) {
    await reconcilePromise
    return
  }

  reconcilePromise = reconcileTransportRuntimesOnce().finally(() => {
    reconcilePromise = null
  })
  await reconcilePromise
}

export async function refreshTransportRuntimeManager() {
  await reconcileTransportRuntimes()
}

export async function startTransportRuntimeManager() {
  await reconcileTransportRuntimes()
  if (reconcileTimer) return
  reconcileTimer = setInterval(() => {
    void reconcileTransportRuntimes().catch((error) => {
      console.error("[im] Transport runtime reconcile failed:", error)
    })
  }, RUNTIME_RECONCILE_INTERVAL_MS)
  reconcileTimer.unref()
}

export async function stopTransportRuntimeManager() {
  if (reconcileTimer) {
    clearInterval(reconcileTimer)
    reconcileTimer = null
  }
  const handles = Array.from(runtimeHandles.values())
  runtimeHandles.clear()
  await Promise.allSettled(handles.map((handle) => handle.stop()))
}

export async function handleFeishuWebhookRequest(params: {
  accountId: string
  headers: Record<string, unknown>
  body: unknown
}) {
  // Legacy route. Delegates to the new connector.handleWebhook path so the
  // logic lives in exactly one place. Public-controller.ts also has a
  // generic /api/v1/im/webhooks/:transportKind/:accountId entry — new
  // deployments should point Feishu at that one.
  const account = await getTransportAccountByKindAndId({
    accountId: params.accountId,
    transportKind: "feishu",
  })
  if (!account || account.status !== "active") {
    return {
      statusCode: 404,
      body: { error: "Transport account not found" },
    }
  }
  if (account.connectionMode !== "webhook") {
    return {
      statusCode: 409,
      body: { error: "Transport account is not configured for webhook mode" },
    }
  }
  const connector = tryGetConnector("feishu")
  if (!connector || !connector.handleWebhook) {
    return {
      statusCode: 503,
      body: { error: "feishu connector not registered" },
    }
  }
  return connector.handleWebhook({
    account,
    headers: params.headers,
    body: params.body,
  })
}
