import test from "node:test"
import assert from "node:assert/strict"
import { z } from "zod"
import type { ToolDefinition } from "@synapse/shared"

// Pure-data smoke for the JSON-schema → zod conversion that
// remote-agent-plugin-projection uses to project a ToolDefinition's parameters
// onto the per-conversation MCP server. Re-implemented inline so this test
// doesn't pull in the projection module, which transitively initializes the
// database driver and would block the runner.

function jsonSchemaPropertyToZod(prop: unknown): z.ZodTypeAny {
  if (!prop || typeof prop !== "object") return z.any()
  const p = prop as { type?: string | string[]; enum?: unknown[] }
  if (Array.isArray(p.enum) && p.enum.every((v) => typeof v === "string")) {
    return z.enum(p.enum as [string, ...string[]])
  }
  const t = Array.isArray(p.type) ? p.type[0] : p.type
  switch (t) {
    case "string":
      return z.string()
    case "number":
    case "integer":
      return z.number()
    case "boolean":
      return z.boolean()
    case "array":
      return z.array(z.any())
    case "object":
      return z.record(z.any())
    default:
      return z.any()
  }
}

function toolDefinitionToZodShape(def: ToolDefinition) {
  const shape: Record<string, z.ZodTypeAny> = {}
  const required = new Set(def.parameters.required)
  for (const [key, prop] of Object.entries(def.parameters.properties ?? {})) {
    const base = jsonSchemaPropertyToZod(prop)
    shape[key] = required.has(key) ? base : base.optional()
  }
  return shape
}

test("required and optional ToolDefinition params map to a runnable zod schema", () => {
  const def: ToolDefinition = {
    name: "ping",
    description: "ping a host",
    parameters: {
      type: "object",
      properties: {
        host: { type: "string" },
        timeoutMs: { type: "integer" },
      },
      required: ["host"],
    },
  }
  const obj = z.object(toolDefinitionToZodShape(def))
  assert.equal(obj.safeParse({ host: "example.com" }).success, true)
  assert.equal(
    obj.safeParse({ host: "example.com", timeoutMs: 5000 }).success,
    true
  )
  assert.equal(obj.safeParse({}).success, false)
})

test("string enum properties round-trip through the JSON-schema conversion", () => {
  const def: ToolDefinition = {
    name: "set_mode",
    description: "switch the mode",
    parameters: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["read", "write", "admin"] },
      },
      required: ["mode"],
    },
  }
  const obj = z.object(toolDefinitionToZodShape(def))
  assert.equal(obj.safeParse({ mode: "admin" }).success, true)
  assert.equal(obj.safeParse({ mode: "bogus" }).success, false)
})

test("unknown property types fall back to z.any()", () => {
  const def: ToolDefinition = {
    name: "free_form",
    description: "anything goes",
    parameters: {
      type: "object",
      properties: {
        payload: { type: "unknown-future-type" as any },
      },
      required: [],
    },
  }
  const obj = z.object(toolDefinitionToZodShape(def))
  assert.equal(obj.safeParse({ payload: 42 }).success, true)
  assert.equal(obj.safeParse({ payload: { nested: true } }).success, true)
})
