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

/**
 * Exhaustiveness helper. Calling `assertNever(x)` is a COMPILE error unless
 * `x` has been narrowed to `never` — i.e. every variant of a discriminated
 * union has been handled in the preceding `switch`. When a new `SubjectKind`
 * is added to `SubjectRef`, every eligibility predicate that routes its
 * fall-through here stops compiling, forcing an explicit decision instead of
 * silently defaulting to `false` (fail-closed-but-invisible).
 */
function assertNever(value: never): never {
  throw new Error(`Unhandled subject kind: ${String(value)}`)
}

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
  | { readonly kind: typeof SUBJECT_KIND.USER; readonly userId: string }
  | {
      readonly kind: typeof SUBJECT_KIND.EXTERNAL
      readonly workspaceId: string
      readonly transportAddressId: string
    }
  | { readonly kind: typeof SUBJECT_KIND.PLATFORM }

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
    ref.kind === SUBJECT_KIND.REMOTE_AGENT
  )
}

// ---------- Constructors ----------

export function workspaceRef(
  workspaceId: string
): Extract<SubjectRef, { kind: typeof SUBJECT_KIND.WORKSPACE }> {
  return { kind: SUBJECT_KIND.WORKSPACE, workspaceId }
}
export function workspaceMemberRef(
  memberId: string
): Extract<SubjectRef, { kind: typeof SUBJECT_KIND.WORKSPACE_MEMBER }> {
  return { kind: SUBJECT_KIND.WORKSPACE_MEMBER, memberId }
}
export function actorRef(
  actorId: string
): Extract<SubjectRef, { kind: typeof SUBJECT_KIND.ACTOR }> {
  return { kind: SUBJECT_KIND.ACTOR, actorId }
}
export function remoteAgentRef(
  remoteAgentId: string
): Extract<SubjectRef, { kind: typeof SUBJECT_KIND.REMOTE_AGENT }> {
  return { kind: SUBJECT_KIND.REMOTE_AGENT, remoteAgentId }
}
export function conversationRef(
  conversationId: string
): Extract<SubjectRef, { kind: typeof SUBJECT_KIND.CONVERSATION }> {
  return { kind: SUBJECT_KIND.CONVERSATION, conversationId }
}
export function userRef(
  userId: string
): Extract<SubjectRef, { kind: typeof SUBJECT_KIND.USER }> {
  return { kind: SUBJECT_KIND.USER, userId }
}
export function externalRef(
  workspaceId: string,
  transportAddressId: string
): Extract<SubjectRef, { kind: typeof SUBJECT_KIND.EXTERNAL }> {
  return { kind: SUBJECT_KIND.EXTERNAL, workspaceId, transportAddressId }
}
export const platformRef: Extract<
  SubjectRef,
  { kind: typeof SUBJECT_KIND.PLATFORM }
> = { kind: SUBJECT_KIND.PLATFORM }

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
    case SUBJECT_KIND.USER:
      return (
        a.userId ===
        (b as Extract<SubjectRef, { kind: typeof SUBJECT_KIND.USER }>).userId
      )
    case SUBJECT_KIND.EXTERNAL: {
      const bb = b as Extract<
        SubjectRef,
        { kind: typeof SUBJECT_KIND.EXTERNAL }
      >
      return (
        a.workspaceId === bb.workspaceId &&
        a.transportAddressId === bb.transportAddressId
      )
    }
    case SUBJECT_KIND.PLATFORM:
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
    case SUBJECT_KIND.USER:
      return `user:${ref.userId}`
    case SUBJECT_KIND.EXTERNAL:
      return `external:${ref.workspaceId}:${ref.transportAddressId}`
    case SUBJECT_KIND.PLATFORM:
      return "platform:_"
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
    case SUBJECT_KIND.USER:
      return userRef(payload)
    case SUBJECT_KIND.EXTERNAL: {
      // payload is `${workspaceId}:${transportAddressId}`
      const dot = payload.indexOf(":")
      if (dot < 0) return null
      return externalRef(payload.slice(0, dot), payload.slice(dot + 1))
    }
    case SUBJECT_KIND.PLATFORM:
      return platformRef
    default:
      return null
  }
}

/**
 * Generic stable de-duplication: keeps the first occurrence of each item by
 * `keyFn(item)`, preserving order. Single source of the dedupe ALGORITHM so
 * callers only supply a key function — `dedupeSubjects` (below) and the
 * `PermissionSubject` de-dup in the access module both route through here
 * instead of hand-rolling the same `Set<string>` loop twice.
 */
export function dedupeBy<T>(
  items: readonly T[],
  keyFn: (item: T) => string
): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const item of items) {
    const key = keyFn(item)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}

export function dedupeSubjects(refs: readonly SubjectRef[]): SubjectRef[] {
  return dedupeBy(refs, subjectKey)
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
  switch (ref.kind) {
    case SUBJECT_KIND.WORKSPACE:
    case SUBJECT_KIND.CONVERSATION:
      return true
    case SUBJECT_KIND.WORKSPACE_MEMBER:
    case SUBJECT_KIND.ACTOR:
    case SUBJECT_KIND.REMOTE_AGENT:
    case SUBJECT_KIND.USER:
    case SUBJECT_KIND.EXTERNAL:
    case SUBJECT_KIND.PLATFORM:
      return false
    default:
      return assertNever(ref)
  }
}

/**
 * The kinds legitimate as subjects of a workspace-bound authorization row
 * (resource_access_bindings / runtime_authorization_grants / memory_access_grants).
 * Excludes user / external / platform. NOTE: external is workspace-rooted now
 * (it carries workspaceId) but is intentionally still excluded — first-class
 * external identities are not yet authorization principals (see plan "后续可选").
 * Mirrors the `is_workspace_bound_subject_kind` SQL helper.
 */
export function isWorkspaceBoundSubjectKind(ref: SubjectRef): boolean {
  switch (ref.kind) {
    case SUBJECT_KIND.WORKSPACE_MEMBER:
    case SUBJECT_KIND.ACTOR:
    case SUBJECT_KIND.REMOTE_AGENT:
    case SUBJECT_KIND.WORKSPACE:
    case SUBJECT_KIND.CONVERSATION:
      return true
    case SUBJECT_KIND.USER:
    case SUBJECT_KIND.EXTERNAL:
    case SUBJECT_KIND.PLATFORM:
      return false
    default:
      return assertNever(ref)
  }
}

/**
 * Allowed `memory_spaces.owner_subject_id` kinds.
 *
 * Scope note: this iteration of the memory model is **workspace-bound only**.
 * `user`, `external`, and `platform` are intentionally NOT memory owners — they
 * would require a separate platform-memory storage path (nullable
 * `memory_items.workspace_id`, cross-workspace recall, cross-tenant indexing
 * pipeline) that lives outside this refactor's scope. If platform user memory
 * or per-project memory becomes a goal in a later phase, that needs its own
 * schema design (likely a sibling `platform_memory_spaces` table, not lifting
 * this restriction in place).
 *
 * The "actor's memory inside a single conversation" pattern is modeled as
 * `owner = actor + scope = conversation`, not as a `user` owner.
 */
export function isMemoryOwnerSubjectKind(ref: SubjectRef): boolean {
  switch (ref.kind) {
    case SUBJECT_KIND.WORKSPACE_MEMBER:
    case SUBJECT_KIND.ACTOR:
    case SUBJECT_KIND.REMOTE_AGENT:
    case SUBJECT_KIND.WORKSPACE:
    case SUBJECT_KIND.CONVERSATION:
      return true
    case SUBJECT_KIND.USER:
    case SUBJECT_KIND.EXTERNAL:
    case SUBJECT_KIND.PLATFORM:
      return false
    default:
      return assertNever(ref)
  }
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

export function subjectScopeLabel(target: ScopedSubjectTarget): string {
  return target.subject.kind
}

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
