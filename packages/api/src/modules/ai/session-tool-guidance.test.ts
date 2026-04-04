import test from "node:test";
import assert from "node:assert/strict";
import {
  buildEnterPlanModeToolDescription,
  buildExitPlanModeToolDescription,
  buildRequestUserInputToolDescription,
  buildUpdatePlanToolDescription,
} from "./session-tool-guidance.js";

test("request_user_input description includes approval and Other-option guardrails", () => {
  const description = buildRequestUserInputToolDescription({
    kind: "generic",
  });

  assert.match(description, /clarification, requirements, preferences/i);
  assert.match(description, /use `allowOther` instead of adding an `Other` option/i);
  assert.match(description, /Do not use this tool for plan approval/i);
});

test("group-targeted descriptions include participant targeting rules", () => {
  const requestDescription = buildRequestUserInputToolDescription({
    kind: "group",
    candidateDirectory: '"Ada" \[participantId=user-1\]',
  });
  const exitDescription = buildExitPlanModeToolDescription({
    kind: "group",
    candidateDirectory: '"Ada" \[participantId=user-1\]',
  });

  assert.match(requestDescription, /`targetParticipantId` is required/);
  assert.match(exitDescription, /`targetParticipantId` is required/);
  assert.match(exitDescription, /Do not ask for plan approval in plain text/i);
});

test("plan mode helper descriptions distinguish planning from approval", () => {
  const enterDescription = buildEnterPlanModeToolDescription();
  const updateDescription = buildUpdatePlanToolDescription();

  assert.match(enterDescription, /non-trivial implementation task/i);
  assert.match(enterDescription, /Do not use it for pure research/i);
  assert.match(updateDescription, /does not request approval or ask whether to proceed/i);
});
