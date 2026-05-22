import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk"

export type RuntimeKind = "claude_code" | "codex"

export type RuntimeCatalogStatus =
  | "available"
  | "missing_binary"
  | "broken_path"
  | "unsupported_platform"
  | "runtime_error"

export type RuntimeCatalogEntry = {
  runtimeKind: RuntimeKind
  executablePath?: string
  status: RuntimeCatalogStatus
  version?: string
  metadata?: Record<string, unknown>
  lastError?: string
}

export type PermissionDecision =
  | {
      behavior: "allow"
      updatedInput?: Record<string, unknown>
    }
  | {
      behavior: "deny"
      message: string
    }

export type AgentSessionEvent =
  | { kind: "session_started"; sessionId: string }
  | { kind: "assistant_message"; text: string }
  | {
      kind: "user_input_requested"
      requestId: string
      title: string
      questions: Array<Record<string, unknown>>
      toolName?: string
      originalInput?: Record<string, unknown>
    }
  | {
      kind: "plan_approval_requested"
      requestId: string
      title: string
      summary?: string
      planMarkdown: string
      checklist?: Array<Record<string, unknown>>
      toolName?: string
      originalInput?: Record<string, unknown>
    }
  | {
      kind: "plan_updated"
      explanation?: string
      plan: Array<{ step: string; status: string }>
    }
  | { kind: "turn_completed" }
  | { kind: "error"; message: string }

export type SessionSpec = {
  remoteAgentId: string
  conversationId: string
  workingDirectory: string
  resumeSessionId?: string
  runtimePath?: string
  mcpServers?: Record<string, McpServerConfig>
  initialPrompt: string
  /** Extra env (e.g. SOCKS5 proxy) merged on top of process.env for the agent child process. */
  childEnvOverlay?: Record<string, string | undefined>
  abortSignal?: AbortSignal
}

export type SendPromptOptions = {
  /** Treat this as a wake/resume rather than a fresh start. The driver decides protocol details. */
  wake?: boolean
}

export interface AgentSession {
  readonly runtimeKind: RuntimeKind
  readonly conversationId: string
  readonly remoteAgentId: string
  readonly sessionId: string | undefined
  /** Send a user-role text prompt into the live session. */
  send(prompt: string, options?: SendPromptOptions): Promise<void>
  /** Update the MCP server map for the live session. No-op if unsupported. */
  setMcpServers(servers: Record<string, McpServerConfig>): Promise<void>
  /** Resolve a pending permission / user-input / plan-approval request. */
  respondPermission(
    requestId: string,
    decision: PermissionDecision
  ): Promise<void>
  /** Pull events emitted by the runtime. The async iterable ends when close() is called. */
  events(): AsyncIterable<AgentSessionEvent>
  close(reason: string): Promise<void>
}

export interface AgentDriver {
  readonly runtimeKind: RuntimeKind
  /** Probe the local machine for the runtime binary and report capabilities. */
  detect(): RuntimeCatalogEntry
  createSession(spec: SessionSpec): Promise<AgentSession>
}
