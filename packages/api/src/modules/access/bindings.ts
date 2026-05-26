import type { AccessGrant, CapabilityAccessTarget } from "@synapse/shared/types"
import {
  SUBJECT_KIND,
  isScopeEligibleSubject,
  remoteAgentRef,
  type ScopedSubjectTarget,
  type SubjectRef,
} from "@synapse/shared"
import type { AccessResourceType } from "./evaluator.js"

export type AccessBindableResourceType = Extract<
  AccessResourceType,
  | "installed_skill"
  | "plugin_installation"
  | "relay_capability"
  | "automation_event_source"
  | "actor"
  | "remote_agent"
>

export type ResourceAccessBindingStorageRow = {
  resource_type: AccessBindableResourceType
  installed_skill_id: string | null
  plugin_installation_id: string | null
  relay_capability_id: string | null
  automation_event_source_id: string | null
  actor_id: string | null
  remote_agent_id: string | null
}

export type AccessBindingTargetType =
  | "workspace"
  | "workspace_member"
  | "conversation"
  | "actor"
  | "actor_in_conversation"

export type AccessBindingRelation =
  | "use_workspace"
  | "use_workspace_member"
  | "use_conversation"
  | "use_actor"
  | "use_actor_in_conversation"
  // New for PR2: relation for the scoped-subject variant. The display value
  // mirrors `use_<subject.kind>` for legacy parity; for combinations carrying
  // a scope (e.g. actor + scope=conversation) callers should not rely on the
  // string but on the decoded target shape directly.
  | "use_remote_agent"
  | "use_scoped"

export type AccessBindingRow = ResourceAccessBindingStorageRow & {
  id: string
  workspace_id: string
  resource_id: string
  // PR2: target_type is becoming legacy-only. Scoped-subject targets carry a
  // null target_type and downstream code must use `if ("subject" in target)`
  // to discriminate. PR7 will drop the field entirely.
  target_type: AccessBindingTargetType | null
  relation: AccessBindingRelation
  // P1b: new canonical reference.
  subject_id: string | null
  // PR2: scope_subject_id pairs with subject_id to express subject + scope.
  // Non-null only on rows written by PR2+ writers.
  scope_subject_id: string | null
  subject_workspace_id: string | null
  subject_workspace_member_id: string | null
  subject_actor_id: string | null
  subject_conversation_id: string | null
  subject_conversation_actor_context_id: string | null
  conversation_type_mask_override: number | null
  status: "active" | "revoked"
  source: "manual" | "default_open" | "relay_auto" | "approval" | "system"
  created_by_workspace_member_id: string | null
  reason: string | null
  created_at: string
  revoked_at: string | null
}

export function readAccessBindingResourceId(
  row: Pick<
    ResourceAccessBindingStorageRow,
    | "resource_type"
    | "installed_skill_id"
    | "plugin_installation_id"
    | "relay_capability_id"
    | "automation_event_source_id"
    | "actor_id"
    | "remote_agent_id"
  >
) {
  switch (row.resource_type) {
    case "installed_skill":
      if (!row.installed_skill_id) {
        throw new Error(
          "installed_skill_id is required for installed_skill bindings"
        )
      }
      return row.installed_skill_id
    case "plugin_installation":
      if (!row.plugin_installation_id) {
        throw new Error(
          "plugin_installation_id is required for plugin_installation bindings"
        )
      }
      return row.plugin_installation_id
    case "relay_capability":
      if (!row.relay_capability_id) {
        throw new Error(
          "relay_capability_id is required for relay_capability bindings"
        )
      }
      return row.relay_capability_id
    case "automation_event_source":
      if (!row.automation_event_source_id) {
        throw new Error(
          "automation_event_source_id is required for automation_event_source bindings"
        )
      }
      return row.automation_event_source_id
    case "actor":
      if (!row.actor_id) {
        throw new Error("actor_id is required for actor bindings")
      }
      return row.actor_id
    case "remote_agent":
      if (!row.remote_agent_id) {
        throw new Error("remote_agent_id is required for remote_agent bindings")
      }
      return row.remote_agent_id
    default:
      throw new Error(
        `Unsupported access binding resource type: ${String(row.resource_type)}`
      )
  }
}

export function buildResourceAccessBindingRef(input: {
  resourceType: AccessBindableResourceType
  resourceId: string
}): ResourceAccessBindingStorageRow {
  return {
    resource_type: input.resourceType,
    installed_skill_id:
      input.resourceType === "installed_skill" ? input.resourceId : null,
    plugin_installation_id:
      input.resourceType === "plugin_installation" ? input.resourceId : null,
    relay_capability_id:
      input.resourceType === "relay_capability" ? input.resourceId : null,
    automation_event_source_id:
      input.resourceType === "automation_event_source"
        ? input.resourceId
        : null,
    actor_id: input.resourceType === "actor" ? input.resourceId : null,
    remote_agent_id:
      input.resourceType === "remote_agent" ? input.resourceId : null,
  }
}

export function relationForAccessTargetType(
  targetType: AccessBindingTargetType
): AccessBindingRelation {
  switch (targetType) {
    case "workspace":
      return "use_workspace"
    case "workspace_member":
      return "use_workspace_member"
    case "conversation":
      return "use_conversation"
    case "actor":
      return "use_actor"
    case "actor_in_conversation":
      return "use_actor_in_conversation"
    default:
      throw new Error(
        `Unsupported access binding target type: ${String(targetType)}`
      )
  }
}

/**
 * PR2 transitional helper: assert that a row has a non-null `target_type`
 * (i.e. is a legacy subject, not a scoped-subject row written through the new
 * path). Use this from code paths that don't yet support the new variant
 * (skills / automation / mcp-plugins legacy read paths) so we fail loud with
 * a clear error rather than the cryptic Kysely / TypeScript type mismatch.
 */
export function assertLegacyTargetType(
  targetType: AccessBindingTargetType | null
): AccessBindingTargetType {
  if (targetType == null) {
    throw new Error(
      "Scoped-subject access bindings are not supported in this code path; expected a legacy target_type. " +
        "Use the scoped-subject reader (readAccessBindingTarget → 'subject' in target) instead."
    )
  }
  return targetType
}

/**
 * PR2: derive the AccessBindingRelation from a decoded AccessGrantTarget.
 * Replaces the row-driven `relationForAccessTargetType(row.target_type)` path
 * so scoped-subject targets (which have a null target_type in their row) can
 * still resolve a sensible relation string. The new variant gets
 * `use_remote_agent` when its subject is a remote_agent, otherwise
 * `use_scoped` as a generic marker — callers that need precise discrimination
 * should branch on the decoded target shape, not the relation string.
 */
export function relationForAccessGrantTarget(
  target: AccessGrantTarget
): AccessBindingRelation {
  if ("subject" in target) {
    if (target.subject.kind === SUBJECT_KIND.REMOTE_AGENT) {
      return "use_remote_agent"
    }
    return "use_scoped"
  }
  return relationForAccessTargetType(target.targetType)
}

export function normalizeAccessBindingRow<
  T extends ResourceAccessBindingStorageRow & {
    target_type: AccessBindingTargetType | null
    subject_id?: string | null
    scope_subject_id?: string | null
    subject_workspace_id?: string | null
    subject_workspace_member_id?: string | null
    subject_actor_id?: string | null
    subject_conversation_id?: string | null
    subject_conversation_actor_context_id?: string | null
    subject_kind?: string | null
    subject_remote_agent_id_via_join?: string | null
    scope_workspace_id_via_join?: string | null
    scope_conversation_id_via_join?: string | null
  },
>(row: T): T & { resource_id: string; relation: AccessBindingRelation } {
  // PR2: normalize is intentionally lightweight — it derives `resource_id` +
  // `relation` without fully decoding the binding target. The relation only
  // needs target_type (legacy) or subject_kind (scoped-subject). This avoids
  // forcing every caller to provide the full subject_*_id projection set just
  // to get a row with `relation` attached.
  let relation: AccessBindingRelation
  if (row.target_type != null) {
    relation = relationForAccessTargetType(row.target_type)
  } else if (row.subject_kind === "remote_agent") {
    relation = "use_remote_agent"
  } else {
    relation = "use_scoped"
  }
  return {
    ...row,
    resource_id: readAccessBindingResourceId(row),
    relation,
  }
}

export type LegacyAccessGrantTarget =
  | {
      targetType: "workspace"
      subjectWorkspaceId: string
      subjectWorkspaceMemberId: null
      subjectActorId: null
      subjectConversationId: null
      subjectConversationActorContextId: null
    }
  | {
      targetType: "workspace_member"
      subjectWorkspaceId: null
      subjectWorkspaceMemberId: string
      subjectActorId: null
      subjectConversationId: null
      subjectConversationActorContextId: null
    }
  | {
      targetType: "conversation"
      subjectWorkspaceId: null
      subjectWorkspaceMemberId: null
      subjectActorId: null
      subjectConversationId: string
      subjectConversationActorContextId: null
    }
  | {
      targetType: "actor"
      subjectWorkspaceId: null
      subjectWorkspaceMemberId: null
      subjectActorId: string
      subjectConversationId: null
      subjectConversationActorContextId: null
    }
  | {
      targetType: "actor_in_conversation"
      subjectWorkspaceId: null
      subjectWorkspaceMemberId: null
      subjectActorId: string
      subjectConversationId: string
      subjectConversationActorContextId: string
    }

/**
 * PR2: AccessGrantTarget becomes a true union of
 * `LegacyAccessGrantTarget` (discriminated by `targetType`) and
 * `ScopedSubjectTarget` (discriminated by the presence of `subject`).
 *
 * All consumers MUST type-guard with `if ("subject" in target)` before
 * destructuring legacy fields. PR7 collapses to just ScopedSubjectTarget.
 */
export type AccessGrantTarget = LegacyAccessGrantTarget | ScopedSubjectTarget

/**
 * P1b bridge: translate an application-layer AccessGrantTarget into the
 * canonical SubjectRef used by access_subjects. Pass the resulting ref to
 * `upsertAccessSubject` (from subject-registry.ts) to obtain a subject_id.
 *
 * PR2: handles both the legacy (`targetType`) and new (`subject`) variants.
 */
export function accessGrantTargetToSubjectRef(
  target: AccessGrantTarget
): SubjectRef {
  if ("subject" in target) {
    return target.subject
  }
  switch (target.targetType) {
    case "workspace":
      return {
        kind: SUBJECT_KIND.WORKSPACE,
        workspaceId: target.subjectWorkspaceId,
      }
    case "workspace_member":
      return {
        kind: SUBJECT_KIND.WORKSPACE_MEMBER,
        memberId: target.subjectWorkspaceMemberId,
      }
    case "conversation":
      return {
        kind: SUBJECT_KIND.CONVERSATION,
        conversationId: target.subjectConversationId,
      }
    case "actor":
      return { kind: SUBJECT_KIND.ACTOR, actorId: target.subjectActorId }
    case "actor_in_conversation":
      return {
        kind: SUBJECT_KIND.CONVERSATION_ACTOR_CONTEXT,
        contextId: target.subjectConversationActorContextId,
      }
  }
}

/**
 * PR2: extract the optional scope SubjectRef from an AccessGrantTarget.
 * Returns undefined for legacy variants (which can't carry scope) and for
 * scoped-subject targets that omit `scope`. Validates that the scope kind is
 * eligible (workspace | conversation) — throws otherwise so callers don't
 * silently write rows that the database trigger would later reject.
 */
export function accessGrantTargetScopeRef(
  target: AccessGrantTarget
): SubjectRef | undefined {
  if (!("subject" in target)) return undefined
  if (!target.scope) return undefined
  if (!isScopeEligibleSubject(target.scope)) {
    throw new Error(
      `scope_subject_id must be workspace | conversation, got ${target.scope.kind}`
    )
  }
  return target.scope
}

function requireResolvedSubjectId(
  value: string | null | undefined,
  fieldName: string,
  targetType: AccessBindingTargetType
) {
  if (value) {
    return value
  }
  throw new Error(
    `${fieldName} is required for resolved ${targetType} access bindings`
  )
}

export function readAccessBindingTarget(row: {
  target_type: AccessBindingTargetType | null
  subject_workspace_id?: string | null
  subject_workspace_member_id?: string | null
  subject_actor_id?: string | null
  subject_conversation_id?: string | null
  subject_conversation_actor_context_id?: string | null
  scope_subject_id?: string | null
  conversation_type_mask_override?: number | null
  // PR2: optional JOIN-projection fields populated by `binding-storage.ts`
  // `bindingRowSelectFor`. When `target_type` is null these are how the
  // scoped-subject variant rebuilds its SubjectRef + scope without needing
  // a second lookup. We accept them as optional to keep legacy callers
  // (whose rows might not carry these fields) compiling.
  subject_kind?: string | null
  subject_remote_agent_id_via_join?: string | null
  scope_kind?: string | null
  scope_workspace_id_via_join?: string | null
  scope_conversation_id_via_join?: string | null
}): AccessGrantTarget {
  // PR2: scoped-subject decode path. Either (a) target_type is null because
  // this row was written through the new path, or (b) subject_kind is
  // remote_agent (which has no legacy projection field), or (c) the row
  // carries a non-null scope_subject_id (legacy + scope mix only happens
  // during PR2-PR7 transition; we surface it as the new variant). All three
  // cases route to the scoped-subject decoder.
  const hasScope = row.scope_subject_id != null
  const isRemoteAgentSubject = row.subject_kind === "remote_agent"
  if (row.target_type == null || isRemoteAgentSubject || hasScope) {
    return decodeScopedSubjectTarget(row)
  }
  switch (row.target_type) {
    case "workspace":
      return {
        targetType: "workspace",
        subjectWorkspaceId: requireResolvedSubjectId(
          row.subject_workspace_id,
          "subject_workspace_id",
          row.target_type
        ),
        subjectWorkspaceMemberId: null,
        subjectActorId: null,
        subjectConversationId: null,
        subjectConversationActorContextId: null,
      }
    case "workspace_member":
      return {
        targetType: "workspace_member",
        subjectWorkspaceId: null,
        subjectWorkspaceMemberId: requireResolvedSubjectId(
          row.subject_workspace_member_id,
          "subject_workspace_member_id",
          row.target_type
        ),
        subjectActorId: null,
        subjectConversationId: null,
        subjectConversationActorContextId: null,
      }
    case "conversation":
      return {
        targetType: "conversation",
        subjectWorkspaceId: null,
        subjectWorkspaceMemberId: null,
        subjectActorId: null,
        subjectConversationId: requireResolvedSubjectId(
          row.subject_conversation_id,
          "subject_conversation_id",
          row.target_type
        ),
        subjectConversationActorContextId: null,
      }
    case "actor":
      return {
        targetType: "actor",
        subjectWorkspaceId: null,
        subjectWorkspaceMemberId: null,
        subjectActorId: requireResolvedSubjectId(
          row.subject_actor_id,
          "subject_actor_id",
          row.target_type
        ),
        subjectConversationId: null,
        subjectConversationActorContextId: null,
      }
    case "actor_in_conversation":
      return {
        targetType: "actor_in_conversation",
        subjectWorkspaceId: null,
        subjectWorkspaceMemberId: null,
        subjectActorId: requireResolvedSubjectId(
          row.subject_actor_id,
          "subject_actor_id",
          row.target_type
        ),
        subjectConversationId: requireResolvedSubjectId(
          row.subject_conversation_id,
          "subject_conversation_id",
          row.target_type
        ),
        subjectConversationActorContextId: requireResolvedSubjectId(
          row.subject_conversation_actor_context_id,
          "subject_conversation_actor_context_id",
          row.target_type
        ),
      }
    default:
      throw new Error(
        `Unsupported stored access target type: ${String(row.target_type)}`
      )
  }
}

function decodeScopedSubjectTarget(row: {
  subject_kind?: string | null
  subject_workspace_id?: string | null
  subject_workspace_member_id?: string | null
  subject_actor_id?: string | null
  subject_remote_agent_id_via_join?: string | null
  subject_conversation_id?: string | null
  subject_conversation_actor_context_id?: string | null
  scope_kind?: string | null
  scope_workspace_id_via_join?: string | null
  scope_conversation_id_via_join?: string | null
}): ScopedSubjectTarget {
  const subject = subjectRefFromRow(row)
  const scope = scopeSubjectRefFromRow(row)
  return scope ? { subject, scope } : { subject }
}

function subjectRefFromRow(row: {
  subject_kind?: string | null
  subject_workspace_id?: string | null
  subject_workspace_member_id?: string | null
  subject_actor_id?: string | null
  subject_remote_agent_id_via_join?: string | null
  subject_conversation_id?: string | null
  subject_conversation_actor_context_id?: string | null
}): SubjectRef {
  switch (row.subject_kind) {
    case "workspace":
      if (!row.subject_workspace_id)
        throw new Error("workspace subject missing workspace_id")
      return {
        kind: SUBJECT_KIND.WORKSPACE,
        workspaceId: row.subject_workspace_id,
      }
    case "workspace_member":
      if (!row.subject_workspace_member_id)
        throw new Error("workspace_member subject missing workspace_member_id")
      return {
        kind: SUBJECT_KIND.WORKSPACE_MEMBER,
        memberId: row.subject_workspace_member_id,
      }
    case "actor":
      if (!row.subject_actor_id)
        throw new Error("actor subject missing actor_id")
      return { kind: SUBJECT_KIND.ACTOR, actorId: row.subject_actor_id }
    case "remote_agent":
      if (!row.subject_remote_agent_id_via_join)
        throw new Error(
          "remote_agent subject missing remote_agent_id (subject_remote_agent_id_via_join projection required)"
        )
      return remoteAgentRef(row.subject_remote_agent_id_via_join)
    case "conversation":
      if (!row.subject_conversation_id)
        throw new Error("conversation subject missing conversation_id")
      return {
        kind: SUBJECT_KIND.CONVERSATION,
        conversationId: row.subject_conversation_id,
      }
    case "conversation_actor_context":
      if (!row.subject_conversation_actor_context_id)
        throw new Error("conversation_actor_context subject missing context id")
      return {
        kind: SUBJECT_KIND.CONVERSATION_ACTOR_CONTEXT,
        contextId: row.subject_conversation_actor_context_id,
      }
    default:
      throw new Error(
        `Unsupported subject_kind for scoped-subject decode: ${String(row.subject_kind)}`
      )
  }
}

function scopeSubjectRefFromRow(row: {
  scope_kind?: string | null
  scope_workspace_id_via_join?: string | null
  scope_conversation_id_via_join?: string | null
}): SubjectRef | undefined {
  if (!row.scope_kind) return undefined
  switch (row.scope_kind) {
    case "workspace":
      if (!row.scope_workspace_id_via_join)
        throw new Error("scope workspace subject missing workspace_id")
      return {
        kind: SUBJECT_KIND.WORKSPACE,
        workspaceId: row.scope_workspace_id_via_join,
      }
    case "conversation":
      if (!row.scope_conversation_id_via_join)
        throw new Error("scope conversation subject missing conversation_id")
      return {
        kind: SUBJECT_KIND.CONVERSATION,
        conversationId: row.scope_conversation_id_via_join,
      }
    default:
      // scope_subject_id rows whose kind is not scope-eligible should never
      // exist (the DB trigger rejects them) — but be defensive.
      throw new Error(
        `Unsupported scope subject kind: ${String(row.scope_kind)}`
      )
  }
}

export function accessBindingHasTarget(
  row: Pick<
    AccessBindingRow,
    | "target_type"
    | "subject_workspace_id"
    | "subject_workspace_member_id"
    | "subject_actor_id"
    | "subject_conversation_id"
    | "subject_conversation_actor_context_id"
    | "subject_id"
    | "scope_subject_id"
  > & {
    subject_kind?: string | null
    subject_remote_agent_id_via_join?: string | null
    scope_kind?: string | null
    scope_workspace_id_via_join?: string | null
    scope_conversation_id_via_join?: string | null
  },
  target: AccessGrantTarget
) {
  if ("subject" in target) {
    // For the scoped-subject target we compare the decoded subject + scope
    // shape against the row's decoded version. Decoding is cheap (no DB lookup
    // — JOIN-projection fields are inline) so we accept the slight cost over
    // a hand-rolled comparison.
    let rowTarget: AccessGrantTarget
    try {
      rowTarget = readAccessBindingTarget(
        row as unknown as Parameters<typeof readAccessBindingTarget>[0]
      )
    } catch {
      return false
    }
    if (!("subject" in rowTarget)) return false
    return (
      subjectRefEqual(rowTarget.subject, target.subject) &&
      ((rowTarget.scope == null && target.scope == null) ||
        (rowTarget.scope != null &&
          target.scope != null &&
          subjectRefEqual(rowTarget.scope, target.scope)))
    )
  }
  switch (target.targetType) {
    case "workspace":
      return (
        row.target_type === "workspace" &&
        (row.subject_workspace_id || null) === target.subjectWorkspaceId
      )
    case "workspace_member":
      return (
        row.target_type === "workspace_member" &&
        (row.subject_workspace_member_id || null) ===
          target.subjectWorkspaceMemberId
      )
    case "conversation":
      return (
        row.target_type === "conversation" &&
        (row.subject_conversation_id || null) === target.subjectConversationId
      )
    case "actor":
      return (
        row.target_type === "actor" &&
        (row.subject_actor_id || null) === target.subjectActorId
      )
    case "actor_in_conversation":
      return (
        row.target_type === "actor_in_conversation" &&
        (row.subject_conversation_actor_context_id || null) ===
          target.subjectConversationActorContextId
      )
    default:
      return false
  }
}

function subjectRefEqual(a: SubjectRef, b: SubjectRef): boolean {
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
 * Shared matcher used by callers that have a decoded
 * `CapabilityAccessTarget` (as returned by `mapAccessBindingToGrant`) and need
 * to check whether it covers the current (workspace, conversation, actor,
 * workspace_member) context.
 *
 * Workspace-scoped targets are implicit — the grant is bound to the workspace
 * row holding it. Pass `grantOwnerWorkspaceId` (the workspace the grant lives
 * in) plus `contextWorkspaceId` (the runtime context's workspace) to disambiguate.
 *
 * Returns true when the grant's target shape matches the runtime context for
 * its target type:
 *   - workspace                : context workspace == grant's owning workspace
 *   - workspace_member         : workspace_member-id matches
 *   - conversation             : conversation-id matches
 *   - actor                    : actor-id matches
 *   - actor_in_conversation    : actor-id AND conversation-id both match
 */
export function capabilityTargetMatchesContext(
  target: CapabilityAccessTarget,
  context: {
    grantOwnerWorkspaceId: string
    contextWorkspaceId: string
    actorId?: string | null
    conversationId?: string | null
    workspaceMemberId?: string | null
    remoteAgentId?: string | null
  }
): boolean {
  if ("subject" in target) {
    // PR2: scoped-subject CapabilityAccessTarget matching. The match logic is
    // subject-level (does the runtime context have the subject identity?) AND,
    // if `scope` is present, scope-level (does the runtime context fall inside
    // that scope?). Same shape as evaluator hasResourceGrant.
    if (!subjectInContext(target.subject, context)) return false
    if (!target.scope) return true
    return scopeInContext(target.scope, context)
  }
  switch (target.type) {
    case "workspace":
      return context.contextWorkspaceId === context.grantOwnerWorkspaceId
    case "workspace_member":
      return (
        !!context.workspaceMemberId &&
        target.workspaceMemberId === context.workspaceMemberId
      )
    case "conversation":
      return (
        !!context.conversationId &&
        target.conversationId === context.conversationId
      )
    case "actor":
      return !!context.actorId && target.actorId === context.actorId
    case "actor_in_conversation":
      return (
        !!context.actorId &&
        !!context.conversationId &&
        target.actorId === context.actorId &&
        target.conversationId === context.conversationId
      )
    default:
      return false
  }
}

function subjectInContext(
  subject: SubjectRef,
  context: {
    grantOwnerWorkspaceId: string
    contextWorkspaceId: string
    actorId?: string | null
    conversationId?: string | null
    workspaceMemberId?: string | null
    remoteAgentId?: string | null
  }
): boolean {
  switch (subject.kind) {
    case SUBJECT_KIND.WORKSPACE:
      return context.contextWorkspaceId === context.grantOwnerWorkspaceId
    case SUBJECT_KIND.WORKSPACE_MEMBER:
      return (
        !!context.workspaceMemberId &&
        subject.memberId === context.workspaceMemberId
      )
    case SUBJECT_KIND.ACTOR:
      return !!context.actorId && subject.actorId === context.actorId
    case SUBJECT_KIND.REMOTE_AGENT:
      return (
        !!context.remoteAgentId &&
        subject.remoteAgentId === context.remoteAgentId
      )
    case SUBJECT_KIND.CONVERSATION:
      return (
        !!context.conversationId &&
        subject.conversationId === context.conversationId
      )
    default:
      // user / external / system / conversation_actor_context not used as
      // capability targets — defensive deny.
      return false
  }
}

function scopeInContext(
  scope: SubjectRef,
  context: {
    contextWorkspaceId: string
    grantOwnerWorkspaceId: string
    conversationId?: string | null
  }
): boolean {
  switch (scope.kind) {
    case SUBJECT_KIND.WORKSPACE:
      return scope.workspaceId === context.contextWorkspaceId
    case SUBJECT_KIND.CONVERSATION:
      return (
        !!context.conversationId &&
        scope.conversationId === context.conversationId
      )
    default:
      return false
  }
}

export function mapAccessBindingToGrant(
  row: AccessBindingRow,
  fallbackReason?: string,
  options?: {
    effectiveConversationTypeMask?: number
  }
): AccessGrant {
  const target = readAccessBindingTarget(row)
  let capabilityTarget: CapabilityAccessTarget

  if ("subject" in target) {
    // PR2: pass the scoped-subject target through unchanged. CapabilityAccessTarget
    // is now a union; consumers that branch on `target.type` MUST also branch
    // on `if ("subject" in target)` first (see the type guard pass added in PR2).
    capabilityTarget = target.scope
      ? { subject: target.subject, scope: target.scope }
      : { subject: target.subject }
  } else {
    switch (target.targetType) {
      case "workspace":
        capabilityTarget = { type: "workspace" }
        break
      case "workspace_member":
        capabilityTarget = {
          type: "workspace_member",
          workspaceMemberId: target.subjectWorkspaceMemberId || undefined,
        }
        break
      case "conversation":
        capabilityTarget = {
          type: "conversation",
          conversationId: target.subjectConversationId || undefined,
        }
        break
      case "actor":
        capabilityTarget = {
          type: "actor",
          actorId: target.subjectActorId || undefined,
        }
        break
      case "actor_in_conversation":
        capabilityTarget = {
          type: "actor_in_conversation",
          actorId: target.subjectActorId || undefined,
          conversationId: target.subjectConversationId || undefined,
        }
        break
    }
  }

  return {
    id: row.id,
    resourceId: row.resource_id,
    workspaceId: row.workspace_id || "",
    target: capabilityTarget,
    status: row.status,
    grantedByWorkspaceMemberId: row.created_by_workspace_member_id || undefined,
    reason: row.reason || fallbackReason,
    conversationTypeMaskOverride: row.conversation_type_mask_override ?? null,
    effectiveConversationTypeMask: options?.effectiveConversationTypeMask,
    createdAt: row.created_at,
    revokedAt: row.revoked_at || undefined,
  }
}
