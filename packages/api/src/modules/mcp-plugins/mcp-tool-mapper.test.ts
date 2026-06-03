import { test } from "node:test"
import assert from "node:assert/strict"
import { mapToolDefinitions } from "./mcp-tool-mapper.js"

test("preserves the full upstream inputSchema verbatim in rawInputSchema", () => {
  const richSchema = {
    type: "object",
    properties: {
      filters: {
        type: "object",
        properties: {
          tags: { type: "array", items: { type: "string" } },
          mode: { oneOf: [{ const: "a" }, { const: "b" }] },
        },
        additionalProperties: false,
      },
      count: { type: "integer", minimum: 1, maximum: 100, default: 10 },
      when: { type: "string", format: "date-time" },
    },
    required: ["filters"],
  }
  const [def] = mapToolDefinitions([
    { name: "search", description: "d", inputSchema: richSchema },
  ])

  // rawInputSchema is the EXACT upstream schema — nested objects, oneOf,
  // format, min/max, default, additionalProperties all survive.
  assert.deepEqual(def.rawInputSchema, richSchema)
})

test("lossy parameters projection still populated for back-compat", () => {
  const [def] = mapToolDefinitions([
    {
      name: "t",
      description: "d",
      inputSchema: {
        type: "object",
        properties: { q: { type: "string", description: "query" } },
        required: ["q"],
      },
    },
  ])
  assert.equal(def.parameters.type, "object")
  assert.equal(def.parameters.properties.q.type, "string")
  assert.deepEqual(def.parameters.required, ["q"])
})

test("tool with no inputSchema omits rawInputSchema", () => {
  const [def] = mapToolDefinitions([{ name: "noargs", description: "d" }])
  assert.equal(def.rawInputSchema, undefined)
  assert.deepEqual(def.parameters, {
    type: "object",
    properties: {},
    required: [],
  })
})
