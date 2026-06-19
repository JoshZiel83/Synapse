import test from "node:test"
import assert from "node:assert/strict"
import crypto from "node:crypto"
import {
  automationEventSourceGrantApplies,
  ensureEventSourceIsSubscribable,
  type AutomationEventSourceAccessRow,
  type AutomationEventSourceAccessContext,
} from "./service.js"

/**
 * Characterization tests for the automation event-source authz matcher after
 * the workspace-resource authz unification (resource_access_bindings folded into
 * workspace_resource_grants). The runtime matcher
 * `automationEventSourceGrantApplies` is the load-bearing piece (plan §5) and
 * MUST逐位 preserve the pre-fold semantics:
 *
 *   - `actor`-subject use grant  -> LIVE  (subscribe_event path, goal #2 precedent)
 *   - `workspace`-subject grant  -> LIVE  ("any conversation in this workspace")
 *   - `workspace_member`-subject -> INERT (default false — plan §6.2 / D-decision)
 *   - `remote_agent`-subject     -> INERT (default false — plan §6.2 / D-decision)
 *
 * The grant row is a workspace_resource_grants row decoded into the
 * AutomationEventSourceGrantJoinedRow shape; this exercises the same decode
 * (`readAutomationEventSourceAccessGrantTarget`) + match used in production
 * but without DB nondeterminism, since the matcher loader is pool-bound.
 */

const WORKSPACE_ID = crypto.randomUUID()
const CONVERSATION_ID = crypto.randomUUID()
const ACTOR_ID = crypto.randomUUID()
const OTHER_ACTOR_ID = crypto.randomUUID()
const REMOTE_AGENT_ID = crypto.randomUUID()
const MEMBER_ID = crypto.randomUUID()
const RESOURCE_ID = crypto.randomUUID()

// A plain non-IM group conversation in WORKSPACE_ID: passes the default
// conversation-type mask gate, so subject-kind matching is what's under test.
function conversation(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: CONVERSATION_ID,
    kind: "group",
    is_im: false,
    workspace_id: WORKSPACE_ID,
    ...overrides,
  }
}

function context(
  overrides: Partial<AutomationEventSourceAccessContext> = {}
): AutomationEventSourceAccessContext {
  return { conversationId: CONVERSATION_ID, actorId: null, ...overrides }
}

// Build a decoded use-grant row for the given subject kind, mirroring the
// columns the matcher loader selects + joins from access_subjects.
function grantRow(
  subjectKind: "workspace" | "workspace_member" | "actor" | "remote_agent",
  opts: {
    scopeConversationId?: string
    conversationTypeMaskOverride?: number | null
  } = {}
): AutomationEventSourceAccessRow {
  return {
    id: crypto.randomUUID(),
    resourceId: RESOURCE_ID,
    workspaceId: WORKSPACE_ID,
    subjectId: crypto.randomUUID(),
    scopeSubjectId: opts.scopeConversationId ? crypto.randomUUID() : null,
    status: "active",
    source: "manual",
    conversationTypeMaskOverride: opts.conversationTypeMaskOverride ?? null,
    createdByWorkspaceMemberId: null,
    reason: null,
    createdAt: new Date(),
    revokedAt: null,
    subjectKind,
    subjectWorkspaceIdViaJoin:
      subjectKind === "workspace" ? WORKSPACE_ID : null,
    subjectWorkspaceMemberIdViaJoin:
      subjectKind === "workspace_member" ? MEMBER_ID : null,
    subjectActorIdViaJoin: subjectKind === "actor" ? ACTOR_ID : null,
    subjectRemoteAgentIdViaJoin:
      subjectKind === "remote_agent" ? REMOTE_AGENT_ID : null,
    subjectConversationIdViaJoin: null,
    scopeKind: opts.scopeConversationId ? "conversation" : null,
    scopeWorkspaceIdViaJoin: null,
    scopeConversationIdViaJoin: opts.scopeConversationId ?? null,
  } as unknown as AutomationEventSourceAccessRow
}

test("actor-subject use grant authorizes the matching actor (LIVE)", () => {
  const row = grantRow("actor")
  assert.equal(
    automationEventSourceGrantApplies({
      row,
      context: context({ actorId: ACTOR_ID }),
      conversation: conversation(),
    }),
    true
  )
})

test("actor-subject use grant denies a different actor and a member-only context", () => {
  const row = grantRow("actor")
  // Different actor in context.
  assert.equal(
    automationEventSourceGrantApplies({
      row,
      context: context({ actorId: OTHER_ACTOR_ID }),
      conversation: conversation(),
    }),
    false
  )
  // No actor in context (member-only subscription attempt).
  assert.equal(
    automationEventSourceGrantApplies({
      row,
      context: context({ actorId: null }),
      conversation: conversation(),
    }),
    false
  )
})

test("actor-subject + conversation scope authorizes only inside the scoped conversation", () => {
  const row = grantRow("actor", { scopeConversationId: CONVERSATION_ID })
  assert.equal(
    automationEventSourceGrantApplies({
      row,
      context: context({ actorId: ACTOR_ID }),
      conversation: conversation(),
    }),
    true
  )
  const otherConversationId = crypto.randomUUID()
  assert.equal(
    automationEventSourceGrantApplies({
      row: grantRow("actor", { scopeConversationId: otherConversationId }),
      context: context({ actorId: ACTOR_ID }),
      conversation: conversation(),
    }),
    false,
    "a grant scoped to a different conversation must not authorize"
  )
})

test("workspace-subject use grant authorizes any conversation in that workspace (LIVE)", () => {
  const row = grantRow("workspace")
  assert.equal(
    automationEventSourceGrantApplies({
      row,
      context: context(),
      conversation: conversation(),
    }),
    true
  )
})

test("workspace-subject grant denies when the subject's workspace differs from the grant", () => {
  // Characterization of the actual matcher: the workspace branch returns true
  // when the subject workspace equals EITHER the conversation's workspace OR the
  // grant row's workspace. In production the DB trigger forces subject_ws ==
  // grant_ws, so a grant whose subject workspace differs from BOTH the
  // conversation and the grant row is the only way to observe denial.
  const foreignWorkspace = crypto.randomUUID()
  const row = grantRow("workspace")
  // Force the decoded subject workspace to a foreign workspace, and the
  // conversation to yet another, so neither OR-arm matches.
  ;(
    row as unknown as { subjectWorkspaceIdViaJoin: string }
  ).subjectWorkspaceIdViaJoin = foreignWorkspace
  assert.equal(
    automationEventSourceGrantApplies({
      row,
      context: context(),
      conversation: conversation({ workspace_id: crypto.randomUUID() }),
    }),
    false
  )
})

test("workspace-subject grant still authorizes a foreign-workspace conversation via the grant-workspace OR-arm (characterization)", () => {
  // The OR with row.workspaceId means a workspace-subject grant authorizes even
  // a conversation tagged with a different workspace_id, as long as the subject
  // workspace matches the grant workspace. Pinning the verbatim-preserved
  // behavior (plan §5) so any future tightening is a conscious change.
  const row = grantRow("workspace")
  assert.equal(
    automationEventSourceGrantApplies({
      row,
      context: context(),
      conversation: conversation({ workspace_id: crypto.randomUUID() }),
    }),
    true
  )
})

test("workspace_member-subject grant is INERT (never authorizes)", () => {
  const row = grantRow("workspace_member")
  // Even with the member's own id available, the matcher has no member branch.
  assert.equal(
    automationEventSourceGrantApplies({
      row,
      context: context(),
      conversation: conversation(),
    }),
    false
  )
})

test("remote_agent-subject grant is INERT (never authorizes)", () => {
  const row = grantRow("remote_agent")
  assert.equal(
    automationEventSourceGrantApplies({
      row,
      context: context({ actorId: ACTOR_ID }),
      conversation: conversation(),
    }),
    false
  )
})

test("conversation-type mask override gates the match even for a live subject", () => {
  // Mask override = direct-only (bit 1). A group conversation is excluded, so
  // even an otherwise-live workspace grant does not apply.
  const directOnlyMask = 1
  const row = grantRow("workspace", {
    conversationTypeMaskOverride: directOnlyMask,
  })
  assert.equal(
    automationEventSourceGrantApplies({
      row,
      context: context(),
      conversation: conversation({ kind: "group" }),
    }),
    false
  )
  // The same grant DOES apply to a direct conversation.
  assert.equal(
    automationEventSourceGrantApplies({
      row,
      context: context(),
      conversation: conversation({ kind: "direct" }),
    }),
    true
  )
})

// ---- D3: runtime status gate (only `active` sources are subscribable) ----

function source(status: string) {
  return {
    id: RESOURCE_ID,
    workspaceId: WORKSPACE_ID,
    providerKind: "internal",
    sourceKey: "k",
    name: "src",
    description: "",
    payloadSchema: {},
    examplePayload: {},
    status,
    metadata: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as never
}

test("ensureEventSourceIsSubscribable accepts active and rejects deprecated/disabled/archived (D3)", () => {
  assert.doesNotThrow(() => ensureEventSourceIsSubscribable(source("active")))
  for (const status of ["deprecated", "disabled", "archived"]) {
    assert.throws(
      () => ensureEventSourceIsSubscribable(source(status)),
      /is not active/,
      `status=${status} must not be subscribable`
    )
  }
})
