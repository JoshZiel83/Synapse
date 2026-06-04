import test from "node:test"
import assert from "node:assert/strict"
import { interpolateEnv } from "./interpolate.js"

const ENV = {
  FOO: "foo-value",
  BAR: "bar-value",
  EMPTY: "",
  BLANK: "   ",
  KEY: "sk-real-secret",
} satisfies NodeJS.ProcessEnv

test("replaces a ${VAR} reference with its env value", () => {
  const { value, missing } = interpolateEnv({ apiKey: "${KEY}" }, ENV)
  assert.deepEqual(value, { apiKey: "sk-real-secret" })
  assert.deepEqual(missing, [])
})

test("collects missing variables without throwing or exiting", () => {
  const { value, missing } = interpolateEnv(
    { a: "${FOO}", b: "${NOPE}", c: "${ALSO_MISSING}" },
    ENV
  )
  // Missing refs interpolate to "" and are reported (sorted, de-duplicated).
  assert.deepEqual(value, { a: "foo-value", b: "", c: "" })
  assert.deepEqual(missing, ["ALSO_MISSING", "NOPE"])
})

test("treats empty AND whitespace-only env values as missing", () => {
  const { missing } = interpolateEnv({ a: "${EMPTY}", b: "${BLANK}" }, ENV)
  assert.deepEqual(missing, ["BLANK", "EMPTY"])
})

test("de-duplicates repeated missing variable names", () => {
  const { missing } = interpolateEnv(
    { a: "${NOPE}", b: "${NOPE}", c: "${NOPE}" },
    ENV
  )
  assert.deepEqual(missing, ["NOPE"])
})

test("$$ is a literal-dollar escape and never participates in matching", () => {
  // "$${FOO}" => literal "$" + "{FOO}" (NOT an env match). And "$$" => "$".
  const { value, missing } = interpolateEnv(
    { a: "price is $$5", b: "$${FOO}", c: "${FOO}$$${BAR}" },
    ENV
  )
  assert.deepEqual(value, {
    a: "price is $5",
    b: "${FOO}",
    c: "foo-value$bar-value",
  })
  assert.deepEqual(missing, [])
})

test("recurses into nested objects and arrays", () => {
  const { value } = interpolateEnv(
    {
      version: 1,
      groups: [
        {
          name: "${FOO}",
          items: [{ apiKey: "${KEY}", tags: ["${BAR}", "static"] }],
        },
      ],
    },
    ENV
  )
  assert.deepEqual(value, {
    version: 1,
    groups: [
      {
        name: "foo-value",
        items: [{ apiKey: "sk-real-secret", tags: ["bar-value", "static"] }],
      },
    ],
  })
})

test("passes through non-string leaves (numbers, booleans, null) untouched", () => {
  const input = { n: 42, b: true, z: null, s: "${FOO}" }
  const { value } = interpolateEnv(input, ENV)
  assert.deepEqual(value, { n: 42, b: true, z: null, s: "foo-value" })
})

test("does not mutate the input object (returns a clone)", () => {
  const input = { a: "${FOO}" }
  const { value } = interpolateEnv(input, ENV)
  assert.equal(input.a, "${FOO}") // original unchanged
  assert.equal((value as { a: string }).a, "foo-value")
})
