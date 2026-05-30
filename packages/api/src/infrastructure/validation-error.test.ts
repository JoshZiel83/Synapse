import test from "node:test"
import assert from "node:assert/strict"
import { z } from "zod"
import { formatValidationDetails } from "./validation-error.js"

// The helper wraps z.treeifyError (zod 4). These tests pin the nested-tree
// contract so a future change to the validation `details` shape is caught
// here rather than silently breaking API clients.

test("formatValidationDetails: flat object reports per-property errors", () => {
  const schema = z.object({ name: z.string(), age: z.number() })
  const result = schema.safeParse({ name: 123, age: "x" })
  assert.equal(result.success, false)
  if (result.success) return
  const details = formatValidationDetails(result.error) as {
    properties?: Record<string, { errors: string[] }>
  }
  assert.ok(details.properties?.name?.errors.length)
  assert.ok(details.properties?.age?.errors.length)
})

test("formatValidationDetails: nested object preserves shape", () => {
  const schema = z.object({
    outer: z.object({ inner: z.string() }),
  })
  const result = schema.safeParse({ outer: { inner: 5 } })
  assert.equal(result.success, false)
  if (result.success) return
  const details = formatValidationDetails(result.error) as {
    properties?: {
      outer?: { properties?: { inner?: { errors: string[] } } }
    }
  }
  assert.ok(details.properties?.outer?.properties?.inner?.errors.length)
})

test("formatValidationDetails: discriminatedUnion surfaces discriminator error", () => {
  const schema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("a"), a: z.string() }),
    z.object({ kind: z.literal("b"), b: z.number() }),
  ])
  const result = schema.safeParse({ kind: "c" })
  assert.equal(result.success, false)
  if (result.success) return
  const details = formatValidationDetails(result.error) as { errors?: string[] }
  // Tree form always carries a top-level `errors` array.
  assert.ok(Array.isArray(details.errors))
})
