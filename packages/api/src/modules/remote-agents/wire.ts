import type {
  RemoteAgentDaemonToApiWsMessage,
  RemoteAgentRuntimeCapabilityWire,
  RemoteAgentRuntimeCatalogEntryWire,
} from "@synapse/device-protocol"
import { RemoteAgentDaemonToApiWsMessageSchema } from "@synapse/device-protocol"
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
