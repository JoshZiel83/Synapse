import { McpRemoteClient } from "../../../mcp-remote-client.js"
import { ToolDefinition } from "@synapse/shared"

async function withMcpClient<T>(
  endpoint: string,
  apiKey: string,
  fn: (client: McpRemoteClient) => Promise<T>
): Promise<T> {
  // zread is a Streamable HTTP MCP endpoint; connect() runs initialize.
  const client = new McpRemoteClient(
    endpoint,
    { Authorization: `Bearer ${apiKey}` },
    "streamable-http"
  )
  await client.initialize()
  try {
    return await fn(client)
  } finally {
    await client.shutdown().catch(() => {})
  }
}

export async function discoverTools(
  endpoint: string,
  apiKey: string,
  fallback: ToolDefinition[]
): Promise<ToolDefinition[]> {
  try {
    const tools = await withMcpClient(endpoint, apiKey, (client) =>
      client.listTools()
    )
    return tools.length > 0 ? tools : fallback
  } catch {
    return fallback
  }
}

export async function callMcpTool(
  endpoint: string,
  apiKey: string,
  toolName: string,
  input: Record<string, unknown>
): Promise<unknown> {
  return withMcpClient(endpoint, apiKey, (client) =>
    client.callTool(toolName, input)
  )
}

export function extractMcpTextResult(result: unknown): string {
  if (typeof result === "string") return result
  if (!result || typeof result !== "object") return String(result ?? "")

  const candidate = result as Record<string, unknown>
  if (typeof candidate.content === "string") return candidate.content
  if (Array.isArray(candidate.content)) {
    return candidate.content
      .map((item) => {
        if (
          item &&
          typeof item === "object" &&
          typeof (item as Record<string, unknown>).text === "string"
        ) {
          return String((item as Record<string, unknown>).text)
        }
        return ""
      })
      .filter(Boolean)
      .join("\n")
  }

  return JSON.stringify(result)
}
