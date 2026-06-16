import { test } from "node:test"
import assert from "node:assert/strict"
import { parseSeedSkillMetadataJson } from "./seed-metadata-codec.js"

test("parseSeedSkillMetadataJson accepts seed metadata", () => {
  assert.deepEqual(
    parseSeedSkillMetadataJson(
      JSON.stringify({
        ownerId: "clawhub",
        slug: "browser",
        version: "1.0.0",
        publishedAt: 123,
      })
    ),
    {
      ownerId: "clawhub",
      slug: "browser",
      version: "1.0.0",
      publishedAt: 123,
    }
  )
})

test("parseSeedSkillMetadataJson rejects malformed JSON", () => {
  assert.throws(
    () => parseSeedSkillMetadataJson("{"),
    /seed skill _meta\.json is invalid JSON/
  )
})

test("parseSeedSkillMetadataJson rejects invalid metadata shape", () => {
  for (const raw of [
    "[]",
    "null",
    '"skill"',
    JSON.stringify({ ownerId: 1 }),
    JSON.stringify({ slug: 1 }),
    JSON.stringify({ version: 1 }),
    JSON.stringify({ publishedAt: "today" }),
  ]) {
    assert.throws(
      () => parseSeedSkillMetadataJson(raw),
      /seed skill _meta\.json has invalid shape/
    )
  }
})

test("parseSeedSkillMetadataJson includes custom source label", () => {
  assert.throws(
    () =>
      parseSeedSkillMetadataJson(
        "[]",
        "seed skill metadata in /tmp/_meta.json"
      ),
    /seed skill metadata in \/tmp\/_meta\.json has invalid shape/
  )
})
