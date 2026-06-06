// CUA focus-scope id derivation.
//
// The cua focus state lives in the Go sidecar's per-Agent-session focusStore.
// To key it correctly we sign a `cua_focus_scope_id` into every cua envelope
// on the server side. This file owns the derivation rule.
//
// Why a dedicated field (not device_runtime_session_id)? The latter is
// freshly randomUUID'd per dispatch in capability-projection/service.ts and
// would never persist focus across two consecutive cua calls. We need a key
// that:
//
//   1. Is stable across the same Agent run-session (so set_focus + the very
//      next capture_view see the same store entry).
//   2. Is NOT model-controlled (otherwise an adversarial tool input could
//      hijack another session's focus).
//   3. Isolates concurrent Agents in the same conversation (a `conv:`-only
//      key would let two actors stomp on each other's focus).
//
// Primary: `session:${RuntimeActorContext.sessionId}` — sessionId is required
// at the type level (packages/shared/src/types/index.ts:2292) and originates
// from the server's execution context. Defense-in-depth fallbacks below
// cover any future caller that constructs a ProjectToolsInput without a
// sessionId; production paths today always have one.

/**
 * Mirrors the canonical `DevicePrincipal` (capability-projection/service.ts).
 * Kept as a structurally-identical local type (not an import) only to avoid a
 * circular-feeling dependency for this otherwise-pure helper — it MUST stay in
 * lock-step with DevicePrincipal. subject-scope-refactor dropped the legacy
 * flat scoped-actor discriminator, so it is intentionally absent here;
 * the exhaustive switch below throws on any kind DevicePrincipal grows that
 * this helper hasn't handled, forcing an explicit decision.
 */
export type PrincipalForScope =
  | { kind: "actor"; actorId: string; conversationId?: string }
  | { kind: "remote_agent"; remoteAgentId: string; conversationId: string }
  | { kind: "conversation"; conversationId: string }
  | { kind: "workspace_member"; workspaceMemberId: string }

export interface CuaFocusScopeInput {
  /** From RuntimeActorContext.sessionId — the primary scope key. */
  sessionId?: string
  workspaceId: string
  principal: PrincipalForScope
}

export function deriveCuaFocusScopeId(input: CuaFocusScopeInput): string {
  if (input.sessionId) return `session:${input.sessionId}`
  const p = input.principal
  switch (p.kind) {
    case "remote_agent":
      return `ra:${p.conversationId}:${p.remoteAgentId}`
    case "actor":
      return p.conversationId
        ? `actor:${p.conversationId}:${p.actorId}`
        : `actor:${p.actorId}`
    case "conversation":
      return `conv:${p.conversationId}`
    case "workspace_member":
      return `wm:${input.workspaceId}:${p.workspaceMemberId}`
    default: {
      const _exhaustive: never = p
      void _exhaustive
      throw new Error("deriveCuaFocusScopeId: unreachable principal kind")
    }
  }
}
