/**
 * Map Synapse ToolDefinition[] → an AI-SDK ToolSet for generateText.
 *
 * Each tool uses the LOSSLESS raw JSON Schema (tool.rawInputSchema) via the
 * jsonSchema() helper, falling back to the lossy `parameters` projection. `execute`
 * is OMITTED on every tool, so generateText returns the raw tool calls WITHOUT
 * running them — Synapse's own agent loop + executor handle execution and feed
 * results back as tool ModelMessages on the next call. We never use the SDK's
 * Agent/ToolLoopAgent (single step only).
 */
import { tool, jsonSchema, type ToolSet } from "ai"
import type { JSONSchema7 } from "@ai-sdk/provider"
import type { ToolDefinition } from "@synapse/shared"

const EMPTY_OBJECT_SCHEMA: JSONSchema7 = {
  type: "object",
  properties: {},
  additionalProperties: false,
}

export function buildAiTools(defs: ToolDefinition[]): ToolSet {
  const set: ToolSet = {}
  for (const def of defs) {
    const schema = (def.rawInputSchema ??
      def.parameters ??
      EMPTY_OBJECT_SCHEMA) as JSONSchema7
    set[def.name] = tool({
      description: def.description,
      // jsonSchema() forwards the schema verbatim (no zod, no $ref deref). We
      // do NOT pass a validate fn — Synapse validates tool input itself.
      inputSchema: jsonSchema(schema),
      // execute intentionally omitted — Synapse executes tools out-of-band.
    })
  }
  return set
}
