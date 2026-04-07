import test from "node:test";
import assert from "node:assert/strict";
import { readRelayAutoLoadedSkill } from "./relay-auto-skills.js";

test("readRelayAutoLoadedSkill resolves provider-prefixed child skill", async () => {
  const result = await readRelayAutoLoadedSkill({
    skillName: "lark-cli-lark-shared",
  });

  assert.ok(result);
  assert.equal(result.skill.slug, "lark-cli-lark-shared");
  assert.match(result.asset.textContent, /lark-cli|Lark CLI/i);
});

test("readRelayAutoLoadedSkill resolves single-directory provider skill", async () => {
  const result = await readRelayAutoLoadedSkill({
    skillName: "xiaohongshu-cli",
  });

  assert.ok(result);
  assert.equal(result.skill.slug, "xiaohongshu-cli");
  assert.match(result.asset.textContent, /xhs|Xiaohongshu/i);
});
