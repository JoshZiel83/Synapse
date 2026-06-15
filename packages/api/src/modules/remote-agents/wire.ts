import type {
  RemoteAgentApiToDaemonWsMessage,
  RemoteAgentDaemonToApiWsMessage,
  RemoteAgentRuntimeCapabilityWire,
  RemoteAgentRuntimeCatalogEntryWire,
} from "@synapse/device-protocol"
import {
  RemoteAgentApiToDaemonWsMessageSchema,
  RemoteAgentDaemonToApiWsMessageSchema,
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

export type RemoteAgentMachineMessage =
  | { type: "heartbeat" }
  | { type: "ready"; runtimeCatalog: RemoteAgentRuntimeCatalogRecord[] }
  | {
      type: "runtime:catalog"
      runtimeCatalog: RemoteAgentRuntimeCatalogRecord[]
    }
  | {
      type: "agent:session"
      remoteAgentId: string
      conversationId: string
      state?: RemoteAgentRuntimeStateType
      sessionId?: string | null
    }
  | {
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
    }

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
    }
  | { type: "agent:stop"; remoteAgentId: string }
  | {
      type: "agent:deliver"
      deliveries: Array<{
        remoteAgentId: string
        deliveryId: string
        conversationId: string
        itemId: string
      }>
    }
  | {
      type: "agent:task:resolved"
      remoteAgentId: string
      taskId: string
      task: Record<string, unknown>
    }

export function parseRemoteAgentMachineMessage(
  raw: unknown
): RemoteAgentMachineMessage | null {
  let json: unknown
  try {
    json = JSON.parse(String(raw))
  } catch {
    return null
  }

  const parsed = RemoteAgentDaemonToApiWsMessageSchema.safeParse(json)
  if (!parsed.success) {
    return null
  }
  return fromWireMessage(parsed.data)
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
      }
    case "runtime:catalog":
      return {
        type: "runtime:catalog",
        runtimeCatalog: message.runtime_catalog.map(fromWireCatalogEntry),
      }
    case "agent:session":
      return {
        type: "agent:session",
        remoteAgentId: message.remote_agent_id,
        conversationId: message.conversation_id,
        state: message.state,
        sessionId: message.session_id,
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
        })),
      }
    case "agent:task:resolved":
      return {
        type: "agent:task:resolved",
        remote_agent_id: message.remoteAgentId,
        task_id: message.taskId,
        task: message.task,
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
