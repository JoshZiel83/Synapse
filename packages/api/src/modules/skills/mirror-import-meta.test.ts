import { test } from "node:test"
import assert from "node:assert/strict"
import { parseClawhubMirrorMetaJson } from "./mirror-import.js"

test("parseClawhubMirrorMetaJson accepts archive metadata", () => {
  assert.deepEqual(
    parseClawhubMirrorMetaJson(
      JSON.stringify({
        ownerId: "owner-1",
        owner: "owner",
        slug: "skill-one",
        displayName: "Skill One",
        version: "1.2.3",
        publishedAt: 123,
        latest: {
          version: "1.2.4",
          publishedAt: 124,
          commit: "abc",
        },
      })
    ),
    {
      ownerId: "owner-1",
      owner: "owner",
      slug: "skill-one",
      displayName: "Skill One",
      version: "1.2.3",
      publishedAt: 123,
      latest: {
        version: "1.2.4",
        publishedAt: 124,
        commit: "abc",
      },
    }
  )
})

test("parseClawhubMirrorMetaJson rejects malformed JSON", () => {
  assert.throws(
    () => parseClawhubMirrorMetaJson("{"),
    /Clawhub _meta\.json is invalid JSON/
  )
})

test("parseClawhubMirrorMetaJson rejects invalid shape", () => {
  for (const raw of [
    "[]",
    "null",
    '"skill"',
    JSON.stringify({ slug: 1 }),
    JSON.stringify({ latest: { publishedAt: "yesterday" } }),
  ]) {
    assert.throws(
      () => parseClawhubMirrorMetaJson(raw),
      /Clawhub _meta\.json has invalid shape/
    )
  }
})

test("parseClawhubMirrorMetaJson includes custom source label in errors", () => {
  assert.throws(
    () => parseClawhubMirrorMetaJson("[]", "Clawhub seed metadata in /tmp/s"),
    /Clawhub seed metadata in \/tmp\/s has invalid shape/
  )
})
