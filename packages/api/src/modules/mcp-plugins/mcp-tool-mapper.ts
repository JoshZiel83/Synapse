import type { ToolDefinition } from "@synapse/shared"

/**
 * Shared MCP `tools/list` → `ToolDefinition` mapper.
 *
 * Used by both the stdio client and the remote (http/sse) client so the two
 * transports map tool schemas identically.
 *
 * IMPORTANT (schema fidelity): the legacy `ToolDefinition.parameters` shape is
 * lossy — it only keeps `type`/`description`/`enum` and a single level of array
 * `items`. Rich JSON Schemas (nested objects, oneOf/anyOf, format, min/max,
 * defaults, $ref, deep arrays) would be silently truncated, and LLM providers
 * forward `parameters` verbatim as the tool's JSON Schema. To avoid corrupting
 * the tool contract we ALSO store the server's raw `inputSchema` verbatim in
 * `rawInputSchema`; downstream consumers prefer it and fall back to
 * `parameters` only when it's absent.
 */

type RawTool = {
  name: string
  description?: string
  inputSchema?: {
    type?: string
    properties?: Record<
      string,
      {
        type?: string
        description?: string
        enum?: string[]
        items?: { type?: string; enum?: string[] }
      }
    >
    required?: string[]
  } & Record<string, unknown>
}

export function mapToolDefinitions(tools: RawTool[]): ToolDefinition[] {
  return tools.map((tool) => {
    const properties: Record<
      string,
      ToolDefinition["parameters"]["properties"][string]
    > = {}

    for (const [key, value] of Object.entries(
      tool.inputSchema?.properties || {}
    )) {
      properties[key] = {
        type: value.type || "string",
        description: value.description || "",
        ...(value.enum ? { enum: value.enum } : {}),
        ...(value.items
          ? {
              items: {
                type: value.items.type || "string",
                ...(value.items.enum ? { enum: value.items.enum } : {}),
              },
            }
          : {}),
      }
    }

    const rawInputSchema =
      tool.inputSchema && typeof tool.inputSchema === "object"
        ? (tool.inputSchema as Record<string, unknown>)
        : undefined

    return {
      name: tool.name,
      description: tool.description || "",
      parameters: {
        type: "object" as const,
        properties,
        required: tool.inputSchema?.required || [],
      },
      // Preserve the full upstream JSON Schema losslessly.
      ...(rawInputSchema ? { rawInputSchema } : {}),
    }
  })
}
