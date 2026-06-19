import test from "node:test"
import assert from "node:assert/strict"
import { SUBJECT_KIND } from "@synapse/shared"
import { readAutomationEventSourceAccessGrantTarget } from "./grant-target.js"

/**
 * Decode-only coverage for the workspace_resource_grants → scoped-subject target
 * reader. The runtime authorization matcher is
 * automationEventSourceGrantApplies (automation/service.ts); its semantics —
 * including the INERT workspace_member / remote_agent branches — are pinned in
 * automation/event-source-matcher.test.ts. This file only verifies the row→
 * target decode, which is the single piece grant-target.ts still owns.
 */

test("readAutomationEventSourceAccessGrantTarget decodes a workspace-subject row", () => {
  assert.deepEqual(
    readAutomationEventSourceAccessGrantTarget({
      subjectKind: "workspace",
      subjectWorkspaceIdViaJoin: "ws-1",
    }),
    { subject: { kind: SUBJECT_KIND.WORKSPACE, workspaceId: "ws-1" } }
  )
})

test("readAutomationEventSourceAccessGrantTarget decodes a workspace_member subject row", () => {
  assert.deepEqual(
    readAutomationEventSourceAccessGrantTarget({
      subjectKind: "workspace_member",
      subjectWorkspaceMemberIdViaJoin: "m-1",
    }),
    {
      subject: { kind: SUBJECT_KIND.WORKSPACE_MEMBER, memberId: "m-1" },
    }
  )
})

test("readAutomationEventSourceAccessGrantTarget decodes actor + scope=conversation", () => {
  assert.deepEqual(
    readAutomationEventSourceAccessGrantTarget({
      subjectKind: "actor",
      subjectActorIdViaJoin: "a-1",
      scopeKind: "conversation",
      scopeConversationIdViaJoin: "c-1",
    }),
    {
      subject: { kind: SUBJECT_KIND.ACTOR, actorId: "a-1" },
      scope: { kind: SUBJECT_KIND.CONVERSATION, conversationId: "c-1" },
    }
  )
})

test("readAutomationEventSourceAccessGrantTarget throws on missing required id", () => {
  assert.throws(() =>
    readAutomationEventSourceAccessGrantTarget({
      subjectKind: "actor",
      subjectActorIdViaJoin: null,
    })
  )
})
