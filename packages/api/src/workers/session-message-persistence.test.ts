import test from "node:test";
import assert from "node:assert/strict";
import { textBlocks } from "@synapse/shared";
import { getAssistantSessionMessagePersistence } from "./session-message-persistence.js";

test("does not persist a hidden assistant session message when a turn has only reasoning", () => {
  const persistence = getAssistantSessionMessagePersistence({
    actions: [],
  });

  assert.deepEqual(persistence, { kind: "none" });
});

test("persists visible respond actions", () => {
  const contentBlocks = textBlocks("Visible reply");
  const persistence = getAssistantSessionMessagePersistence({
    actions: [
      {
        type: "respond",
        content: "Visible reply",
        contentBlocks,
      },
    ],
  });

  assert.equal(persistence.kind, "respond");
  assert.equal(persistence.actions.length, 1);
  assert.deepEqual(persistence.actions[0]?.contentBlocks, contentBlocks);
});

test("falls back to a silent action marker for non-respond actions", () => {
  const persistence = getAssistantSessionMessagePersistence({
    actions: [
      {
        type: "create_memory",
        content: "Remember this",
      },
      {
        type: "rename_self",
        content: "Rename me",
      },
    ],
  });

  assert.deepEqual(persistence, {
    kind: "silent_actions",
    actionNames: ["create_memory", "rename_self"],
  });
});
