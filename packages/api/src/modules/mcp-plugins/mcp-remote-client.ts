import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import { ToolDefinition } from "@synapse/shared"
import { mapToolDefinitions } from "./mcp-tool-mapper.js"

export type RemoteMcpProtocol = "streamable-http" | "sse"

/**
 * Remote MCP client backed by the official @modelcontextprotocol/sdk.
 *
 * Replaces the hand-rolled McpHttpClient. Supports both Streamable HTTP and the
 * legacy two-endpoint SSE transport (the latter is required by servers like
 * AMiner that only expose a `/sse` GET stream + POST messages endpoint, which
 * the old single-POST client could not speak).
 *
 * Auth headers are passed through `requestInit.headers`: the SDK merges them
 * into BOTH the initial SSE GET stream and the subsequent POST requests (see
 * SSEClientTransport._commonHeaders), so callers only set them once here.
 * `EventSourceInit` has no `headers` field, so we deliberately do NOT use
 * `eventSourceInit` for auth.
 *
 * Lifecycle: `connect()` runs the MCP initialize handshake automatically — do
 * not call initialize manually. `shutdown()` branches by transport: Streamable
 * HTTP gets a best-effort `terminateSession()` (which throws on non-405) inside
 * a try/finally that always `close()`s; SSE only has `close()`.
 */
export class McpRemoteClient {
  private readonly client = new Client(
    { name: "synapse-mcp-client", version: "1.0.0" },
    { capabilities: {} }
  )

  private readonly transport: StreamableHTTPClientTransport | SSEClientTransport
  private readonly protocol: RemoteMcpProtocol
  private connected = false

  constructor(
    url: string,
    headers: Record<string, string>,
    protocol: RemoteMcpProtocol = "streamable-http"
  ) {
    this.protocol = protocol
    const parsedUrl = new URL(url)
    const requestInit: RequestInit = { headers }
    if (protocol === "sse") {
      this.transport = new SSEClientTransport(parsedUrl, { requestInit })
    } else {
      this.transport = new StreamableHTTPClientTransport(parsedUrl, {
        requestInit,
      })
    }
  }

  async initialize(): Promise<{
    capabilities: Record<string, unknown>
    serverInfo: Record<string, unknown>
  }> {
    // connect() performs the MCP initialize + notifications/initialized flow.
    await this.client.connect(this.transport)
    this.connected = true
    return {
      capabilities: (this.client.getServerCapabilities() || {}) as Record<
        string,
        unknown
      >,
      serverInfo: (this.client.getServerVersion() || {}) as Record<
        string,
        unknown
      >,
    }
  }

  async listTools(): Promise<ToolDefinition[]> {
    const result = await this.client.listTools()
    return mapToolDefinitions(result.tools || [])
  }

  async callTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<unknown> {
    // Returns the MCP {content, isError?, structuredContent?} envelope, which
    // normalizeMcpToolResult understands directly.
    return this.client.callTool({ name, arguments: args })
  }

  async shutdown(): Promise<void> {
    if (!this.connected) return
    this.connected = false
    try {
      if (this.transport instanceof StreamableHTTPClientTransport) {
        // Best-effort: terminateSession() throws on non-405; never let it skip
        // the close() below.
        await this.transport.terminateSession().catch(() => {})
      }
    } finally {
      await this.client.close().catch(() => {})
    }
  }
}
