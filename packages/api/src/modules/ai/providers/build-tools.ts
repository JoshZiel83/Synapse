/**
 * Map Synapse ToolDefinition[] → an AI-SDK ToolSet for generateText.
 *
 * Each tool uses the LOSSLESS raw JSON Schema (tool.rawInputSchema) via the
 * jsonSchema() helper, falling back to the lossy `parameters` projection. `execute`
 * is OMITTED on every tool, so generateText returns the raw tool calls WITHOUT
 * running them — Synapse's own agent loop + executor handle execution and feed
 * results back as tool ModelMessages on the next call. We never use the SDK's
 * Agent/ToolLoopAgent (single step only).
 *
 * Anthropic SERVER tools (web_search/web_fetch) are provider-defined tools and
 * ARE executed server-side by Anthropic — they are merged in by buildServerTools
 * when a candidate enables them (features.serverTools), keyed on providerKind.
 */
import { tool, jsonSchema, type ToolSet } from "ai"
import { anthropic } from "@ai-sdk/anthropic"
import type { JSONSchema7 } from "@ai-sdk/provider"
import {
  MODEL_SERVER_TOOL,
  type AnthropicBuiltinTool,
  type ToolDefinition,
} from "@synapse/shared"
import type { ProviderKind } from "./registry.js"

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

/**
 * Provider-defined SERVER tools for a candidate. Only Anthropic exposes these
 * today (web_search / web_fetch run inside Anthropic's API). Returns an empty
 * object for other provider kinds or when no server tools are enabled, so the
 * caller can spread it unconditionally.
 */
export function buildServerTools(
  providerKind: ProviderKind,
  serverTools: AnthropicBuiltinTool[] | undefined
): ToolSet {
  if (
    providerKind !== "anthropic" ||
    !serverTools ||
    serverTools.length === 0
  ) {
    return {}
  }
  const set: ToolSet = {}
  for (const name of serverTools) {
    if (name === MODEL_SERVER_TOOL.WEB_SEARCH) {
      set.web_search = anthropic.tools.webSearch_20250305()
    } else if (name === MODEL_SERVER_TOOL.WEB_FETCH) {
      set.web_fetch = anthropic.tools.webFetch_20250910()
    }
  }
  return set
}
