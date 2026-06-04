/**
 * S34: zod schema for canonical content blocks must live in shared.
 *
 * Before this stage `packages/api/src/modules/chat/controller.ts`
 * declared text/file_ref/mention zod schemas locally and built the
 * discriminated union inline. The S5 plan called for
 * CanonicalContentBlockSchema in @synapse/shared so any future consumer
 * (IM-imported messages, ingest CLI, etc.) validates against the
 * exact same shape the chat HTTP API enforces. This guard ensures the
 * canonical schema stays in shared and the API controller doesn't drift
 * back to re-declaring it.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { CanonicalContentBlockSchema } from "@synapse/shared/schemas"

const here = path.dirname(fileURLToPath(import.meta.url))
const chatControllerPath = path.resolve(
  here,
  "..",
  "..",
  "modules",
  "chat",
  "controller.ts"
)

test("CanonicalContentBlockSchema parses each canonical block kind", () => {
  const text = CanonicalContentBlockSchema.parse({
    type: "text",
    text: "hello",
  })
  assert.equal(text.type, "text")

  const fileRef = CanonicalContentBlockSchema.parse({
    type: "file_ref",
    sha256: "a".repeat(64),
    path: "/conversation/shot.png",
    mimeType: "image/png",
    name: "shot.png",
    sizeBytes: 1024,
    category: "image",
  })
  assert.equal(fileRef.type, "file_ref")

  const mention = CanonicalContentBlockSchema.parse({
    type: "mention",
    mention: { participantType: "workspace_member", id: "any" },
  })
  assert.equal(mention.type, "mention")
})

test("CanonicalContentBlockSchema rejects unknown types", () => {
  const result = CanonicalContentBlockSchema.safeParse({
    type: "weird",
    text: "nope",
  })
  assert.equal(result.success, false)
})

test("CanonicalContentBlockSchema rejects file_ref blocks missing required fields", () => {
  const result = CanonicalContentBlockSchema.safeParse({
    type: "file_ref",
    sha256: "a".repeat(64),
    // mimeType + name + sizeBytes + category all omitted
  })
  assert.equal(result.success, false)
})

test("chat controller sources CanonicalContentBlockSchema from @synapse/shared/schemas", async () => {
  const body = await readFile(chatControllerPath, "utf8")
  assert.match(
    body,
    /import \{[^}]*CanonicalContentBlockSchema[^}]*\}\s+from\s+"@synapse\/shared\/schemas"/s,
    "controller.ts must pull the canonical content-block schema from @synapse/shared/schemas — the subpath, not the root barrel, so the SW worker bundles don't pull in zod"
  )
})

test("chat controller does not re-declare the canonical block schemas locally", async () => {
  const body = await readFile(chatControllerPath, "utf8")
  // The old shape: three z.object schemas (text/file_ref/mention) wired
  // through z.discriminatedUnion("type", ...). Guard each individually so
  // a partial rewrite still fails the assertion.
  assert.equal(
    /const\s+textBlockSchema\s*=\s*z\.object/.test(body),
    false,
    "controller.ts must not declare a local textBlockSchema"
  )
  assert.equal(
    /const\s+fileRefBlockSchema\s*=\s*z\.object/.test(body),
    false,
    "controller.ts must not declare a local fileRefBlockSchema"
  )
  assert.equal(
    /const\s+mentionBlockSchema\s*=\s*z\.object/.test(body),
    false,
    "controller.ts must not declare a local mentionBlockSchema"
  )
  assert.equal(
    /z\.discriminatedUnion\("type",\s*\[\s*textBlockSchema/.test(body),
    false,
    "controller.ts must not redeclare the discriminated content-block union"
  )
})
