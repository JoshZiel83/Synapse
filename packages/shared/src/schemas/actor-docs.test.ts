import assert from "node:assert/strict"
import test from "node:test"

import { ActorDocInputSchema, ActorDocSchema } from "./actor-docs.js"

const slugIdDoc = {
  // Seeded official-template docs use stable slug-based ids, NOT UUIDs.
  id: "official-secretary:identity-card",
  key: "identity_card",
  title: "Identity Card",
  content: [{ type: "text", text: "How this actor introduces themselves." }],
  visibility: "always",
  priority: 120,
}

test("ActorDocSchema accepts a stable slug-based id (regression: was z.uuid())", () => {
  const result = ActorDocSchema.safeParse(slugIdDoc)
  assert.equal(result.success, true)
  assert.equal(result.data?.id, "official-secretary:identity-card")
})

test("ActorDocSchema still accepts a UUID id (createActorDocId output)", () => {
  const result = ActorDocSchema.safeParse({
    ...slugIdDoc,
    id: "33333333-3333-4333-8333-333333333333",
  })
  assert.equal(result.success, true)
})

test("ActorDocSchema rejects an empty id", () => {
  const result = ActorDocSchema.safeParse({ ...slugIdDoc, id: "" })
  assert.equal(result.success, false)
})

test("ActorDocInputSchema accepts a slug id and an absent id", () => {
  assert.equal(ActorDocInputSchema.safeParse(slugIdDoc).success, true)
  const { id: _omit, ...withoutId } = slugIdDoc
  assert.equal(ActorDocInputSchema.safeParse(withoutId).success, true)
})
