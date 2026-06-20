import test from "node:test"
import assert from "node:assert/strict"
import {
  buildActorPrompt,
  buildPlanModeGuidance,
  buildRequestUserInputGuidance,
} from "./prompt-builder.js"
import type { ActorDoc, ToolDefinition } from "@synapse/shared"

test("buildRequestUserInputGuidance includes exploration and approval rules", () => {
  const guidance = buildRequestUserInputGuidance(false)

  assert.match(guidance, /Explore the repo and current state first/i)
  assert.match(
    guidance,
    /Do not use `request_user_input` for status checks, courtesy confirmations, or plan approval/i
  )
  assert.match(guidance, /use the exact `targetParticipantId`/i)
})

test("buildPlanModeGuidance reserves approval for exit_plan_mode", () => {
  const guidance = buildPlanModeGuidance("plan_drafting")

  assert.match(guidance, /You are planning, not executing/i)
  assert.match(guidance, /Use `update_plan` only to maintain the checklist/i)
  assert.match(guidance, /call `exit_plan_mode` instead/i)
})

test("buildPlanModeGuidance handles awaiting approval state", () => {
  const guidance = buildPlanModeGuidance("plan_awaiting_approval")

  assert.match(guidance, /plan_awaiting_approval/)
  assert.match(guidance, /Do not keep drafting, do not ask for approval again/i)
})

test("buildActorPrompt injects request-user-input guidance for human conversations", () => {
  const prompt = buildActorPrompt(
    { definition: { name: "Planner", title: "Engineer" }, currentVersion: 1 },
    undefined,
    undefined,
    undefined,
    [
      {
        id: "participant-user",
        participantType: "workspace_member",
        userId: "user-1",
        userName: "Ada",
      },
    ],
    "direct",
    undefined,
    "default"
  )

  assert.match(prompt.system, /# Requesting User Input/)
  assert.match(prompt.system, /recipient is implicit/i)
})

test("buildActorPrompt injects stronger plan mode guidance", () => {
  const prompt = buildActorPrompt(
    { definition: { name: "Planner", title: "Engineer" }, currentVersion: 1 },
    undefined,
    undefined,
    undefined,
    [
      {
        id: "participant-user",
        participantType: "workspace_member",
        userId: "user-1",
        userName: "Ada",
      },
    ],
    "direct",
    undefined,
    "plan_drafting"
  )

  assert.match(prompt.system, /Current collaboration mode: `plan_drafting`/)
  assert.match(
    prompt.system,
    /Do not request plan approval through normal assistant text or `request_user_input`/i
  )
})

test("buildActorPrompt teaches direct threads not to overuse replyToRef", () => {
  const prompt = buildActorPrompt(
    {
      id: "actor-1",
      definition: { name: "Planner", title: "Engineer" },
      currentVersion: 1,
    },
    undefined,
    undefined,
    undefined,
    [
      {
        id: "participant-user",
        participantType: "workspace_member",
        userId: "user-1",
        userName: "Ada",
      },
    ],
    "direct",
    undefined,
    "default"
  )

  assert.match(prompt.system, /omit `replyToRef` by default/i)
  assert.match(prompt.system, /Do not add `replyToRef` mechanically/i)
})

// Regression for the CamelCasePlugin-cutover residue (rename-propagation audit):
// the roster must read camelCase ChatParticipantRow keys for the actor + external
// branches too (snake reads previously rendered "Unknown actor" / "External
// participant" with no version/title).
test("buildActorPrompt renders actor and external roster entries from camelCase participants", () => {
  const prompt = buildActorPrompt(
    {
      id: "actor-1",
      definition: { name: "Planner", title: "Engineer" },
      currentVersion: 1,
    },
    undefined,
    undefined,
    undefined,
    [
      {
        id: "p-actor",
        participantType: "actor",
        actorId: "actor-9",
        participantName: "Helper",
        participantTitle: "Specialist",
        actorCurrentVersion: 3,
      },
      {
        id: "p-external",
        participantType: "external",
        transportExternalId: "ext-1",
        transportDisplayName: "Wei",
      },
      {
        id: "p-user",
        participantType: "workspace_member",
        userId: "user-2",
        userName: "Sam",
      },
    ],
    "group",
    undefined,
    "default"
  )

  assert.match(prompt.system, /# Conversation Participants/)
  assert.match(prompt.system, /\[actor\] \*\*Helper\*\* v3/)
  assert.match(prompt.system, /Specialist/)
  assert.match(prompt.system, /\[external\] \*\*Wei\*\*/)
  assert.match(prompt.system, /\[workspace_member\] \*\*Sam\*\*/)
})

test("buildActorPrompt only consumes decoded actor doc and specialty arrays", () => {
  const decodedDoc: ActorDoc = {
    id: "00000000-0000-4000-8000-000000000111",
    key: "custom",
    title: "Decoded guidance",
    content: [
      {
        id: "00000000-0000-4000-8000-000000000112",
        type: "text",
        text: "Use the decoded docs.",
      },
    ],
    visibility: "always",
    priority: 1,
  }

  const decodedPrompt = buildActorPrompt(
    {
      definition: {
        name: "Planner",
        title: "Engineer",
        docs: [decodedDoc],
        specialties: ["planning"],
      },
      currentVersion: 1,
    },
    undefined,
    undefined,
    undefined,
    undefined,
    "direct",
    undefined,
    "default"
  )

  assert.match(decodedPrompt.system, /Decoded guidance/)
  assert.match(decodedPrompt.system, /Use the decoded docs/)
  assert.match(decodedPrompt.system, /`planning`/)

  const stringPrompt = buildActorPrompt(
    {
      definition: {
        name: "Planner",
        title: "Engineer",
        docs: JSON.stringify([decodedDoc]),
        specialties: JSON.stringify(["planning"]),
      },
      currentVersion: 1,
    },
    undefined,
    undefined,
    undefined,
    undefined,
    "direct",
    undefined,
    "default"
  )

  assert.doesNotMatch(stringPrompt.system, /Decoded guidance/)
  assert.doesNotMatch(stringPrompt.system, /Use the decoded docs/)
  assert.doesNotMatch(stringPrompt.system, /`planning`/)
})

test("buildActorPrompt rejects plan mode in group conversations", () => {
  assert.throws(
    () =>
      buildActorPrompt(
        {
          definition: { name: "Planner", title: "Engineer" },
          currentVersion: 1,
        },
        undefined,
        undefined,
        undefined,
        [
          {
            id: "participant-user",
            participantType: "workspace_member",
            userId: "user-1",
            userName: "Ada",
          },
        ],
        "group",
        undefined,
        "plan_drafting"
      ),
    /Plan mode is only available in direct conversations/i
  )
})

test("buildActorPrompt no longer emits legacy relay routing guidance for builtin tools", () => {
  // PR #31 (KKK): the per-tool routing block that taught the model
  // about `request_authorization`, relay `bash` `execution_mode`,
  // and the `Relay builtin filesystem/browser/desktop/commandline`
  // surface was removed because v3 redefines those tools and the old
  // prompts pushed the model to emit calls that don't exist on the
  // new surface. This test pins the new behavior so a future
  // accidental re-introduction is caught.
  const tools: ToolDefinition[] = [
    {
      name: "device__shell__bash",
      description: "Run bash",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "Command",
          },
        },
        required: ["command"],
      },
    },
  ]

  const prompt = buildActorPrompt(
    { definition: { name: "Planner", title: "Engineer" }, currentVersion: 1 },
    undefined,
    undefined,
    tools,
    [
      {
        id: "participant-user",
        participantType: "workspace_member",
        userId: "user-1",
        userName: "Ada",
      },
    ],
    "direct",
    undefined,
    "default"
  )

  // The system prompt must not contain any of the legacy relay-era
  // tool-routing language: that surface no longer exists.
  assert.doesNotMatch(prompt.system, /relay client/i)
  assert.doesNotMatch(prompt.system, /relay builtin/i)
  assert.doesNotMatch(prompt.system, /execution_mode/i)
  assert.doesNotMatch(prompt.system, /request_authorization/i)
  assert.doesNotMatch(prompt.system, /# Tool Routing/i)
})
