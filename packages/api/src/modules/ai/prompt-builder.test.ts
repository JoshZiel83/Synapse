import test from "node:test";
import assert from "node:assert/strict";
import {
  buildActorPrompt,
  buildPlanModeGuidance,
  buildRequestUserInputGuidance,
} from "./prompt-builder.js";
import type { ToolDefinition } from "@synapse/shared";

test("buildRequestUserInputGuidance includes exploration and approval rules", () => {
  const guidance = buildRequestUserInputGuidance(false);

  assert.match(guidance, /Explore the repo and current state first/i);
  assert.match(guidance, /Do not use `request_user_input` for status checks, courtesy confirmations, or plan approval/i);
  assert.match(guidance, /use the exact `targetParticipantId`/i);
});

test("buildPlanModeGuidance reserves approval for exit_plan_mode", () => {
  const guidance = buildPlanModeGuidance("plan_drafting");

  assert.match(guidance, /You are planning, not executing/i);
  assert.match(guidance, /Use `update_plan` only to maintain the checklist/i);
  assert.match(guidance, /call `exit_plan_mode` instead/i);
});

test("buildPlanModeGuidance handles awaiting approval state", () => {
  const guidance = buildPlanModeGuidance("plan_awaiting_approval");

  assert.match(guidance, /plan_awaiting_approval/);
  assert.match(guidance, /Do not keep drafting, do not ask for approval again/i);
});

test("buildActorPrompt injects request-user-input guidance for human conversations", () => {
  const prompt = buildActorPrompt(
    { definition: { name: "Planner", title: "Engineer" }, currentVersion: 1 },
    undefined,
    undefined,
    undefined,
    [
      {
        id: "participant-user",
        participant_kind: "workspace_member",
        user_id: "user-1",
        user_name: "Ada",
      },
    ],
    "private",
    undefined,
    "default",
  );

  assert.match(prompt.system, /# Requesting User Input/);
  assert.match(prompt.system, /recipient is implicit/i);
});

test("buildActorPrompt injects stronger plan mode guidance", () => {
  const prompt = buildActorPrompt(
    { definition: { name: "Planner", title: "Engineer" }, currentVersion: 1 },
    undefined,
    undefined,
    undefined,
    [
      {
        id: "participant-user",
        participant_kind: "workspace_member",
        user_id: "user-1",
        user_name: "Ada",
      },
    ],
    "private",
    undefined,
    "plan_drafting",
  );

  assert.match(prompt.system, /Current collaboration mode: `plan_drafting`/);
  assert.match(prompt.system, /Do not request plan approval through normal assistant text or `request_user_input`/i);
});

test("buildActorPrompt teaches private threads not to overuse replyToRef", () => {
  const prompt = buildActorPrompt(
    { id: "actor-1", definition: { name: "Planner", title: "Engineer" }, currentVersion: 1 },
    undefined,
    undefined,
    undefined,
    [
      {
        id: "participant-user",
        participant_kind: "workspace_member",
        user_id: "user-1",
        user_name: "Ada",
      },
    ],
    "private",
    undefined,
    "default",
  );

  assert.match(prompt.system, /omit `replyToRef` by default/i);
  assert.match(prompt.system, /Do not add `replyToRef` mechanically/i);
});

test("buildActorPrompt rejects plan mode in group conversations", () => {
  assert.throws(
    () =>
      buildActorPrompt(
        { definition: { name: "Planner", title: "Engineer" }, currentVersion: 1 },
        undefined,
        undefined,
        undefined,
        [
          {
            id: "participant-user",
            participant_kind: "workspace_member",
            user_id: "user-1",
            user_name: "Ada",
          },
        ],
        "group",
        undefined,
        "plan_drafting",
      ),
    /Plan mode is only available in private conversations/i,
  );
});

test("buildActorPrompt mentions relay request_authorization guidance for builtin tools", () => {
  const tools: ToolDefinition[] = [
    {
      name: "relay__shell__bash",
      description: "Run bash",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "Command",
          },
          request_authorization: {
            type: "string",
            description: "Server-only authorization mode",
            enum: ["none", "background", "blocking"],
          },
        },
        required: ["command"],
      },
    },
  ];

  const prompt = buildActorPrompt(
    { definition: { name: "Planner", title: "Engineer" }, currentVersion: 1 },
    undefined,
    undefined,
    tools,
    [
      {
        id: "participant-user",
        participant_kind: "workspace_member",
        user_id: "user-1",
        user_name: "Ada",
      },
    ],
    "private",
    undefined,
    "default",
  );

  assert.match(prompt.system, /request_authorization/);
  assert.match(prompt.system, /not send it to the relay client/i);
  assert.match(prompt.system, /execution_mode: "async".*blocking/i);
});
