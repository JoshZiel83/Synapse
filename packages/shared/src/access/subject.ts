/**
 * `SubjectRef` is the unified discriminated union representing "who" in the
 * authorization system. It collapses the historical fragmentation of
 * polymorphic subject columns (workspace_member_id? + actor_id? + remote_agent_id? + ...)
 * spread across 10+ tables into a single shape.
 *
 * Each variant carries exactly the IDs required to identify the subject —
 * additional context (workspace_id for an actor, etc.) is recoverable via
 * lookup and is not embedded here to keep the type minimal and equality-checkable.
 */

import { SUBJECT_KIND, type SubjectKind } from "./enums.js"

export type SubjectRef =
  | {
      readonly kind: typeof SUBJECT_KIND.WORKSPACE
      readonly workspaceId: string
    }
  | {
      readonly kind: typeof SUBJECT_KIND.WORKSPACE_MEMBER
      readonly memberId: string
    }
  | { readonly kind: typeof SUBJECT_KIND.ACTOR; readonly actorId: string }
  | {
      readonly kind: typeof SUBJECT_KIND.REMOTE_AGENT
      readonly remoteAgentId: string
    }
  | {
      readonly kind: typeof SUBJECT_KIND.CONVERSATION
      readonly conversationId: string
    }
  | {
      readonly kind: typeof SUBJECT_KIND.CONVERSATION_ACTOR_CONTEXT
      readonly contextId: string
    }
  | { readonly kind: typeof SUBJECT_KIND.USER; readonly userId: string }
  | {
      readonly kind: typeof SUBJECT_KIND.EXTERNAL
      readonly externalIdentityKey: string
    }
  | { readonly kind: typeof SUBJECT_KIND.SYSTEM }

/**
 * Workspace-scoped subjects only — the variants that can be referenced from
 * authorization rows. Maps 1:1 to ACCESS_TARGET_TYPES values plus the
 * `remote_agent` kind which (as of PR2 of the subject-scope refactor) travels
 * exclusively through the new `ScopedSubjectTarget` variant of AccessGrantTarget
 * — it is intentionally NOT in `ACCESS_TARGET_TYPES` / `CAPABILITY_ACCESS_TARGET_TYPES`
 * so the legacy projection layer in `bindings.ts` does not have to grow another
 * column.
 */
export type AccessTargetRef = Extract<
  SubjectRef,
  {
    kind:
      | typeof SUBJECT_KIND.WORKSPACE
      | typeof SUBJECT_KIND.WORKSPACE_MEMBER
      | typeof SUBJECT_KIND.CONVERSATION
      | typeof SUBJECT_KIND.ACTOR
      | typeof SUBJECT_KIND.REMOTE_AGENT
      | typeof SUBJECT_KIND.CONVERSATION_ACTOR_CONTEXT
  }
>

/**
 * Subjects that can be the principal of an authorization request (the "who am I"
 * side, as opposed to the resource side). The evaluator narrows by kind.
 */
export type AccessPrincipalRef = Extract<
  SubjectRef,
  {
    kind:
      | typeof SUBJECT_KIND.USER
      | typeof SUBJECT_KIND.WORKSPACE_MEMBER
      | typeof SUBJECT_KIND.ACTOR
      | typeof SUBJECT_KIND.WORKSPACE
      | typeof SUBJECT_KIND.CONVERSATION_ACTOR_CONTEXT
  }
>

// ---------- Type guards ----------

export function isWorkspaceSubject(
  ref: SubjectRef
): ref is Extract<SubjectRef, { kind: typeof SUBJECT_KIND.WORKSPACE }> {
  return ref.kind === SUBJECT_KIND.WORKSPACE
}

export function isWorkspaceMemberSubject(
  ref: SubjectRef
): ref is Extract<SubjectRef, { kind: typeof SUBJECT_KIND.WORKSPACE_MEMBER }> {
  return ref.kind === SUBJECT_KIND.WORKSPACE_MEMBER
}

export function isActorSubject(
  ref: SubjectRef
): ref is Extract<SubjectRef, { kind: typeof SUBJECT_KIND.ACTOR }> {
  return ref.kind === SUBJECT_KIND.ACTOR
}

export function isRemoteAgentSubject(
  ref: SubjectRef
): ref is Extract<SubjectRef, { kind: typeof SUBJECT_KIND.REMOTE_AGENT }> {
  return ref.kind === SUBJECT_KIND.REMOTE_AGENT
}

export function isConversationSubject(
  ref: SubjectRef
): ref is Extract<SubjectRef, { kind: typeof SUBJECT_KIND.CONVERSATION }> {
  return ref.kind === SUBJECT_KIND.CONVERSATION
}

export function isConversationActorContextSubject(
  ref: SubjectRef
): ref is Extract<
  SubjectRef,
  { kind: typeof SUBJECT_KIND.CONVERSATION_ACTOR_CONTEXT }
> {
  return ref.kind === SUBJECT_KIND.CONVERSATION_ACTOR_CONTEXT
}

export function isUserSubject(
  ref: SubjectRef
): ref is Extract<SubjectRef, { kind: typeof SUBJECT_KIND.USER }> {
  return ref.kind === SUBJECT_KIND.USER
}

export function isAccessTargetRef(ref: SubjectRef): ref is AccessTargetRef {
  return (
    ref.kind === SUBJECT_KIND.WORKSPACE ||
    ref.kind === SUBJECT_KIND.WORKSPACE_MEMBER ||
    ref.kind === SUBJECT_KIND.CONVERSATION ||
    ref.kind === SUBJECT_KIND.ACTOR ||
    ref.kind === SUBJECT_KIND.REMOTE_AGENT ||
    ref.kind === SUBJECT_KIND.CONVERSATION_ACTOR_CONTEXT
  )
}

// ---------- Constructors ----------

export function workspaceRef(workspaceId: string): SubjectRef {
  return { kind: SUBJECT_KIND.WORKSPACE, workspaceId }
}
export function workspaceMemberRef(memberId: string): SubjectRef {
  return { kind: SUBJECT_KIND.WORKSPACE_MEMBER, memberId }
}
export function actorRef(actorId: string): SubjectRef {
  return { kind: SUBJECT_KIND.ACTOR, actorId }
}
export function remoteAgentRef(remoteAgentId: string): SubjectRef {
  return { kind: SUBJECT_KIND.REMOTE_AGENT, remoteAgentId }
}
export function conversationRef(conversationId: string): SubjectRef {
  return { kind: SUBJECT_KIND.CONVERSATION, conversationId }
}
export function conversationActorContextRef(contextId: string): SubjectRef {
  return { kind: SUBJECT_KIND.CONVERSATION_ACTOR_CONTEXT, contextId }
}
export function userRef(userId: string): SubjectRef {
  return { kind: SUBJECT_KIND.USER, userId }
}
export function externalRef(externalIdentityKey: string): SubjectRef {
  return { kind: SUBJECT_KIND.EXTERNAL, externalIdentityKey }
}
export const systemRef: SubjectRef = { kind: SUBJECT_KIND.SYSTEM }

// ---------- Equality ----------

export function subjectsEqual(a: SubjectRef, b: SubjectRef): boolean {
  if (a.kind !== b.kind) return false
  switch (a.kind) {
    case SUBJECT_KIND.WORKSPACE:
      return (
        a.workspaceId ===
        (b as Extract<SubjectRef, { kind: typeof SUBJECT_KIND.WORKSPACE }>)
          .workspaceId
      )
    case SUBJECT_KIND.WORKSPACE_MEMBER:
      return (
        a.memberId ===
        (
          b as Extract<
            SubjectRef,
            { kind: typeof SUBJECT_KIND.WORKSPACE_MEMBER }
          >
        ).memberId
      )
    case SUBJECT_KIND.ACTOR:
      return (
        a.actorId ===
        (b as Extract<SubjectRef, { kind: typeof SUBJECT_KIND.ACTOR }>).actorId
      )
    case SUBJECT_KIND.REMOTE_AGENT:
      return (
        a.remoteAgentId ===
        (b as Extract<SubjectRef, { kind: typeof SUBJECT_KIND.REMOTE_AGENT }>)
          .remoteAgentId
      )
    case SUBJECT_KIND.CONVERSATION:
      return (
        a.conversationId ===
        (b as Extract<SubjectRef, { kind: typeof SUBJECT_KIND.CONVERSATION }>)
          .conversationId
      )
    case SUBJECT_KIND.CONVERSATION_ACTOR_CONTEXT:
      return (
        a.contextId ===
        (
          b as Extract<
            SubjectRef,
            { kind: typeof SUBJECT_KIND.CONVERSATION_ACTOR_CONTEXT }
          >
        ).contextId
      )
    case SUBJECT_KIND.USER:
      return (
        a.userId ===
        (b as Extract<SubjectRef, { kind: typeof SUBJECT_KIND.USER }>).userId
      )
    case SUBJECT_KIND.EXTERNAL:
      return (
        a.externalIdentityKey ===
        (b as Extract<SubjectRef, { kind: typeof SUBJECT_KIND.EXTERNAL }>)
          .externalIdentityKey
      )
    case SUBJECT_KIND.SYSTEM:
      return true
  }
}

/**
 * Stable string representation for use in caches, set keys, log lines, etc.
 * Format: `{kind}:{id-payload}` — round-trippable via `parseSubjectKey`.
 */
export function subjectKey(ref: SubjectRef): string {
  switch (ref.kind) {
    case SUBJECT_KIND.WORKSPACE:
      return `workspace:${ref.workspaceId}`
    case SUBJECT_KIND.WORKSPACE_MEMBER:
      return `workspace_member:${ref.memberId}`
    case SUBJECT_KIND.ACTOR:
      return `actor:${ref.actorId}`
    case SUBJECT_KIND.REMOTE_AGENT:
      return `remote_agent:${ref.remoteAgentId}`
    case SUBJECT_KIND.CONVERSATION:
      return `conversation:${ref.conversationId}`
    case SUBJECT_KIND.CONVERSATION_ACTOR_CONTEXT:
      return `conversation_actor_context:${ref.contextId}`
    case SUBJECT_KIND.USER:
      return `user:${ref.userId}`
    case SUBJECT_KIND.EXTERNAL:
      return `external:${ref.externalIdentityKey}`
    case SUBJECT_KIND.SYSTEM:
      return "system:_"
  }
}

export function parseSubjectKey(key: string): SubjectRef | null {
  const sep = key.indexOf(":")
  if (sep < 0) return null
  const kind = key.slice(0, sep) as SubjectKind
  const payload = key.slice(sep + 1)
  switch (kind) {
    case SUBJECT_KIND.WORKSPACE:
      return workspaceRef(payload)
    case SUBJECT_KIND.WORKSPACE_MEMBER:
      return workspaceMemberRef(payload)
    case SUBJECT_KIND.ACTOR:
      return actorRef(payload)
    case SUBJECT_KIND.REMOTE_AGENT:
      return remoteAgentRef(payload)
    case SUBJECT_KIND.CONVERSATION:
      return conversationRef(payload)
    case SUBJECT_KIND.CONVERSATION_ACTOR_CONTEXT:
      return conversationActorContextRef(payload)
    case SUBJECT_KIND.USER:
      return userRef(payload)
    case SUBJECT_KIND.EXTERNAL:
      return externalRef(payload)
    case SUBJECT_KIND.SYSTEM:
      return systemRef
    default:
      return null
  }
}

export function dedupeSubjects(refs: readonly SubjectRef[]): SubjectRef[] {
  const seen = new Set<string>()
  const out: SubjectRef[] = []
  for (const ref of refs) {
    const key = subjectKey(ref)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(ref)
  }
  return out
}

// ---------- Scope eligibility (PR1 additive) ----------

/**
 * A subject is eligible to act as a `scope_subject_id` if it represents a
 * group-shaped entity that an authorization can be limited to. Mirrors the
 * `is_scope_eligible_subject` SQL helper used by the schema triggers.
 *
 * Currently: workspace | conversation. `project` will join once the projects
 * table lands.
 */
export function isScopeEligibleSubject(ref: SubjectRef): boolean {
  return (
    ref.kind === SUBJECT_KIND.WORKSPACE ||
    ref.kind === SUBJECT_KIND.CONVERSATION
  )
}

/**
 * The kinds legitimate as subjects of a workspace-bound authorization row
 * (resource_access_bindings / relay_authorization_grants / memory_access_grants).
 * Excludes user / external / system — those are platform-wide subjects that
 * cannot anchor a workspace-bound grant.
 *
 * PR1 transitional: also includes `conversation_actor_context` so the legacy
 * `actor_in_conversation` writer continues to work until PR4. PR7 removes that
 * kind together with the subject_kind enum value.
 */
export function isWorkspaceBoundSubjectKind(ref: SubjectRef): boolean {
  return (
    ref.kind === SUBJECT_KIND.WORKSPACE_MEMBER ||
    ref.kind === SUBJECT_KIND.ACTOR ||
    ref.kind === SUBJECT_KIND.REMOTE_AGENT ||
    ref.kind === SUBJECT_KIND.WORKSPACE ||
    ref.kind === SUBJECT_KIND.CONVERSATION ||
    ref.kind === SUBJECT_KIND.CONVERSATION_ACTOR_CONTEXT
  )
}

/**
 * Stricter allowlist for `memory_spaces.owner_subject_id` (PR5+). Excludes
 * conversation_actor_context — memory writes only start in PR5, so there is no
 * legacy path that produces this kind. Modeling owner as
 * (actor, scope=conversation) is the canonical way to express
 * "actor in conversation"'s memory.
 */
export function isMemoryOwnerSubjectKind(ref: SubjectRef): boolean {
  return (
    ref.kind === SUBJECT_KIND.WORKSPACE_MEMBER ||
    ref.kind === SUBJECT_KIND.ACTOR ||
    ref.kind === SUBJECT_KIND.REMOTE_AGENT ||
    ref.kind === SUBJECT_KIND.WORKSPACE ||
    ref.kind === SUBJECT_KIND.CONVERSATION
  )
}

// ---------- Scoped target types (PR1 additive — not replacing legacy yet) ----------

/**
 * New target shape used by `resource_access_bindings.subject_id +
 * scope_subject_id`. PR2 promotes this to be a variant of the exported
 * `AccessTarget` / `CapabilityAccessTarget` unions; PR7 collapses to this
 * variant only.
 */
export type ScopedSubjectTarget = {
  readonly subject: SubjectRef
  readonly scope?: SubjectRef
}

export type ScopedCapabilityAccessTarget = ScopedSubjectTarget

// ---------- Memory space reference (PR1 additive) ----------

/**
 * A memory_spaces row keyed by (owner, scope?, namespace_key). PR5 introduces
 * the table with this shape; this type is the SDK-facing reference.
 */
export type MemorySpaceRef = {
  readonly owner: SubjectRef
  readonly scope?: SubjectRef
  readonly namespaceKey: string
}
