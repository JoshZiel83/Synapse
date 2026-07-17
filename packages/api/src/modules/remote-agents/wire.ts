import type {
  RemoteAgentApiToDaemonWsMessage,
  RemoteAgentDaemonToApiWsMessage,
  RemoteAgentRuntimeCapabilityWire,
  RemoteAgentRuntimeCatalogEntryWire,
} from "@synapse/device-protocol"
import {
  RemoteAgentApiToDaemonWsMessageSchema,
  parseRemoteAgentDaemonToApiWsFrame,
} from "@synapse/device-protocol"
import type {
  RemoteAgentRuntimeCatalogStatus,
  RemoteAgentRuntimeKind,
  RemoteAgentRuntimeStateType,
} from "@synapse/shared"
import type { RemoteAgentRuntimeCapabilityRecord } from "./presenter.js"

export type RemoteAgentRuntimeCatalogRecord = {
  runtimeKind: RemoteAgentRuntimeKind
  executablePath?: string
  status: RemoteAgentRuntimeCatalogStatus
  version?: string
  metadata?: Record<string, unknown>
  lastError?: string
}

/**
 * Optional W3C trace context on the four work-triggering daemon→api machine
 * messages (never heartbeat), stamped from the daemon's carrier ALS. The
 * `/ws/remote-agents` message handler extracts these into the per-message
 * SERVER span's parent context (extract-or-ROOT, §4.C/§4.D) — already
 * degrade-not-reject-validated by the device-protocol wire schemas.
 */
export type RemoteAgentMachineMessageTraceContext = {
  traceparent?: string
  tracestate?: string
}

export type RemoteAgentMachineMessage =
  | { type: "heartbeat" }
  | ({
      type: "ready"
      runtimeCatalog: RemoteAgentRuntimeCatalogRecord[]
    } & RemoteAgentMachineMessageTraceContext)
  | ({
      type: "runtime:catalog"
      runtimeCatalog: RemoteAgentRuntimeCatalogRecord[]
    } & RemoteAgentMachineMessageTraceContext)
  | ({
      type: "agent:session"
      remoteAgentId: string
      conversationId: string
      state?: RemoteAgentRuntimeStateType
      sessionId?: string | null
    } & RemoteAgentMachineMessageTraceContext)
  | ({
      type: "agent:status"
      remoteAgentId: string
      state: RemoteAgentRuntimeStateType
      statusText?: string | null
      conversationId?: string | null
      taskId?: string | null
      sessionId?: string | null
      lastError?: string | null
      runKey?: string | null
      capabilities?: RemoteAgentRuntimeCapabilityRecord
    } & RemoteAgentMachineMessageTraceContext)

export type RemoteAgentApiToDaemonMessage =
  | {
      type: "connected"
      machineId: string
      sessionId: string
      fencingToken?: string
    }
  | { type: "auth_error"; message: string }
  | { type: "fenced"; reason?: string }
  | { type: "pong" }
  | {
      type: "agent:start"
      remoteAgentId: string
      conversationId?: string | null
      runtimeKind: RemoteAgentRuntimeKind
      runtimePath?: string | null
      localRootPath?: string | null
      sessionId?: string | null
      fencingToken?: string
      serverUrl?: string
      // Minted via activeTraceCarrier() on live paths; the persisted
      // delivery-replay path is traceparent-only (§3c).
      traceparent?: string
      tracestate?: string
    }
  | { type: "agent:stop"; remoteAgentId: string }
  | {
      type: "agent:deliver"
      deliveries: Array<{
        remoteAgentId: string
        deliveryId: string
        conversationId: string
        itemId: string
        traceparent?: string
        tracestate?: string
      }>
    }
  | {
      type: "agent:task:resolved"
      remoteAgentId: string
      taskId: string
      task: Record<string, unknown>
      traceparent?: string
      tracestate?: string
    }

export function parseRemoteAgentMachineMessage(
  raw: unknown
): RemoteAgentMachineMessage | null {
  const parsed = parseRemoteAgentDaemonToApiWsFrame(String(raw))
  if (!parsed.ok) {
    return null
  }
  return fromWireMessage(parsed.message)
}

export function serializeRemoteAgentApiToDaemonMessage(
  message: RemoteAgentApiToDaemonMessage
) {
  return JSON.stringify(
    RemoteAgentApiToDaemonWsMessageSchema.parse(toWireApiMessage(message))
  )
}

function fromWireMessage(
  message: RemoteAgentDaemonToApiWsMessage
): RemoteAgentMachineMessage {
  switch (message.type) {
    case "heartbeat":
      return { type: "heartbeat" }
    case "ready":
      return {
        type: "ready",
        runtimeCatalog: message.runtime_catalog.map(fromWireCatalogEntry),
        traceparent: message.traceparent,
        tracestate: message.tracestate,
      }
    case "runtime:catalog":
      return {
        type: "runtime:catalog",
        runtimeCatalog: message.runtime_catalog.map(fromWireCatalogEntry),
        traceparent: message.traceparent,
        tracestate: message.tracestate,
      }
    case "agent:session":
      return {
        type: "agent:session",
        remoteAgentId: message.remote_agent_id,
        conversationId: message.conversation_id,
        state: message.state,
        sessionId: message.session_id,
        traceparent: message.traceparent,
        tracestate: message.tracestate,
      }
    case "agent:status":
      return {
        type: "agent:status",
        remoteAgentId: message.remote_agent_id,
        state: message.state,
        statusText: message.status_text,
        conversationId: message.conversation_id,
        taskId: message.task_id,
        sessionId: message.session_id,
        lastError: message.last_error,
        runKey: message.run_key,
        capabilities: message.capabilities
          ? fromWireCapabilities(message.capabilities)
          : undefined,
        traceparent: message.traceparent,
        tracestate: message.tracestate,
      }
  }
}

function toWireApiMessage(
  message: RemoteAgentApiToDaemonMessage
): RemoteAgentApiToDaemonWsMessage {
  switch (message.type) {
    case "connected":
      return {
        type: "connected",
        machine_id: message.machineId,
        session_id: message.sessionId,
        fencing_token: message.fencingToken,
      }
    case "auth_error":
      return {
        type: "auth_error",
        message: message.message,
      }
    case "fenced":
      return {
        type: "fenced",
        reason: message.reason,
      }
    case "pong":
      return { type: "pong" }
    case "agent:start":
      return {
        type: "agent:start",
        remote_agent_id: message.remoteAgentId,
        conversation_id: message.conversationId,
        runtime_kind: message.runtimeKind,
        runtime_path: message.runtimePath,
        local_root_path: message.localRootPath,
        session_id: message.sessionId,
        fencing_token: message.fencingToken,
        server_url: message.serverUrl,
        traceparent: message.traceparent,
        tracestate: message.tracestate,
      }
    case "agent:stop":
      return {
        type: "agent:stop",
        remote_agent_id: message.remoteAgentId,
      }
    case "agent:deliver":
      return {
        type: "agent:deliver",
        deliveries: message.deliveries.map((delivery) => ({
          remote_agent_id: delivery.remoteAgentId,
          delivery_id: delivery.deliveryId,
          conversation_id: delivery.conversationId,
          item_id: delivery.itemId,
          traceparent: delivery.traceparent,
          tracestate: delivery.tracestate,
        })),
      }
    case "agent:task:resolved":
      return {
        type: "agent:task:resolved",
        remote_agent_id: message.remoteAgentId,
        task_id: message.taskId,
        task: message.task,
        traceparent: message.traceparent,
        tracestate: message.tracestate,
      }
  }
}

function fromWireCatalogEntry(
  entry: RemoteAgentRuntimeCatalogEntryWire
): RemoteAgentRuntimeCatalogRecord {
  return {
    runtimeKind: entry.runtime_kind,
    executablePath: entry.executable_path,
    status: entry.status,
    version: entry.version,
    metadata: entry.metadata,
    lastError: entry.last_error,
  }
}

function fromWireCapabilities(
  capabilities: RemoteAgentRuntimeCapabilityWire
): RemoteAgentRuntimeCapabilityRecord {
  return {
    supportsRequestUserInput: capabilities.supports_request_user_input,
    supportsPlanMode: capabilities.supports_plan_mode,
    supportsPersistentSession: capabilities.supports_persistent_session,
    supportsCodexAppServer: capabilities.supports_codex_app_server,
    supportsStructuredIo: capabilities.supports_structured_io,
  }
}
