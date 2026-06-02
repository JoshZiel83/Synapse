import { ToolDefinition } from "@synapse/shared"
import { createParser } from "eventsource-parser"

interface JsonRpcRequest {
  jsonrpc: "2.0"
  id: number
  method: string
  params?: Record<string, unknown>
}

interface JsonRpcResponse {
  jsonrpc: "2.0"
  id: number
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

/**
 * Parse a fully-buffered MCP Streamable-HTTP SSE body and return the result of
 * the JSON-RPC message whose id matches `expectedId`. Exported for testing.
 *
 * Correctly handles: multi-line (folded) data within one event, multiple
 * events in the stream, CRLF/optional-space framing (via eventsource-parser),
 * and a final event that the server did NOT terminate with a blank line (we
 * append a terminator since the body is complete). Throws on a JSON-RPC error
 * matching our id, or if there were no data events at all.
 */
export function parseMcpSsePayload(text: string, expectedId: number): unknown {
  const events: string[] = []
  const parser = createParser({
    onEvent: (event) => {
      events.push(event.data)
    },
  })
  // Append a terminator so a final un-terminated `data:` event still flushes.
  parser.feed(text.endsWith("\n") ? `${text}\n` : `${text}\n\n`)

  let fallback: unknown
  let sawData = false
  let sawJsonRpc = false
  for (const data of events) {
    if (!data) continue
    sawData = true
    let json: JsonRpcResponse
    try {
      json = JSON.parse(data) as JsonRpcResponse
    } catch {
      // Non-JSON event payload — remember as a last-resort raw fallback.
      fallback = data
      continue
    }
    // A JSON-RPC frame carries jsonrpc/id; track that we saw at least one so we
    // can tell "no JSON-RPC at all" (legacy server → use raw fallback) apart
    // from "JSON-RPC but none matched our id" (protocol mismatch → throw).
    if (
      json &&
      typeof json === "object" &&
      ("jsonrpc" in json || "id" in json || "result" in json || "error" in json)
    ) {
      sawJsonRpc = true
    }
    if (json.id !== expectedId) continue
    if (json.error) {
      throw new Error(`MCP RPC error ${json.error.code}: ${json.error.message}`)
    }
    return json.result
  }

  if (!sawData) {
    throw new Error("No data in SSE response")
  }
  // We received JSON-RPC frames but none carried our request id — a mismatched
  // or out-of-order response. Surfacing this as an error prevents it from
  // silently degrading to an empty tool list / empty tool result.
  if (sawJsonRpc) {
    throw new Error(
      `MCP SSE response had no JSON-RPC message matching request id ${expectedId}`
    )
  }
  // Only non-JSON-RPC (legacy/raw) payloads were seen — best-effort passthrough.
  return fallback ?? ""
}

export class McpHttpClient {
  private endpoint: string
  private headers: Record<string, string>
  private sessionId: string | null = null
  private requestId = 0
  private initialized = false
  private shutdownRequested = false
  private activeRequests = new Set<AbortController>()

  constructor(endpoint: string, headers?: Record<string, string>) {
    this.endpoint = endpoint
    this.headers = headers || {}
  }

  private nextId(): number {
    return ++this.requestId
  }

  /**
   * Send a JSON-RPC notification (no id, no response expected).
   */
  private async sendNotification(
    method: string,
    params?: Record<string, unknown>
  ): Promise<void> {
    const notification: {
      jsonrpc: "2.0"
      method: string
      params?: Record<string, unknown>
    } = {
      jsonrpc: "2.0",
      method,
      ...(params !== undefined ? { params } : {}),
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...this.headers,
    }

    if (this.sessionId) {
      headers["Mcp-Session-Id"] = this.sessionId
    }

    // Fire-and-forget: notifications don't expect a response
    await fetch(this.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(notification),
    }).catch(() => {})
  }

  private async sendRequest(
    method: string,
    params?: Record<string, unknown>
  ): Promise<unknown> {
    if (this.shutdownRequested) {
      throw new Error("MCP HTTP client is shutting down")
    }

    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: this.nextId(),
      method,
      ...(params !== undefined ? { params } : {}),
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...this.headers,
    }

    if (this.sessionId) {
      headers["Mcp-Session-Id"] = this.sessionId
    }

    const controller = new AbortController()
    this.activeRequests.add(controller)

    try {
      const response = await fetch(this.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(request),
        signal: AbortSignal.any([
          AbortSignal.timeout(30000),
          controller.signal,
        ]),
      })

      // Track session ID from response
      const newSessionId = response.headers.get("Mcp-Session-Id")
      if (newSessionId) {
        this.sessionId = newSessionId
      }

      if (!response.ok) {
        const body = await response.text().catch(() => "")
        throw new Error(`MCP HTTP error ${response.status}: ${body}`)
      }

      const contentType = response.headers.get("Content-Type") || ""

      // Handle SSE streaming response
      if (contentType.includes("text/event-stream")) {
        return await this.parseSSEResponse(response, request.id)
      }

      // Handle regular JSON response
      const json = (await response.json()) as JsonRpcResponse

      if (json.error) {
        throw new Error(
          `MCP RPC error ${json.error.code}: ${json.error.message}`
        )
      }

      return json.result
    } catch (error: any) {
      if (controller.signal.aborted && this.shutdownRequested) {
        throw new Error(
          "MCP HTTP request aborted because the server is shutting down"
        )
      }
      throw error
    } finally {
      this.activeRequests.delete(controller)
    }
  }

  private async parseSSEResponse(
    response: Response,
    expectedId: number
  ): Promise<unknown> {
    const text = await response.text()
    return parseMcpSsePayload(text, expectedId)
  }

  async initialize(): Promise<{
    capabilities: Record<string, unknown>
    serverInfo: Record<string, unknown>
  }> {
    const result = (await this.sendRequest("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: {
        name: "synapse-mcp-client",
        version: "1.0.0",
      },
    })) as {
      capabilities: Record<string, unknown>
      serverInfo: Record<string, unknown>
    }

    // Send initialized notification (JSON-RPC notification: no id, no response)
    await this.sendNotification("notifications/initialized")

    this.initialized = true
    return result
  }

  async shutdown(): Promise<void> {
    if (!this.initialized) return
    try {
      this.shutdownRequested = true
      for (const controller of this.activeRequests) {
        controller.abort()
      }

      // For HTTP transport, we can send a DELETE to terminate the session
      if (this.sessionId) {
        const headers: Record<string, string> = {
          ...this.headers,
          "Mcp-Session-Id": this.sessionId,
        }
        await fetch(this.endpoint, {
          method: "DELETE",
          headers,
          signal: AbortSignal.timeout(3000),
        }).catch(() => {}) // Best-effort
      }
    } finally {
      this.initialized = false
      this.sessionId = null
      this.activeRequests.clear()
    }
  }

  async listTools(): Promise<ToolDefinition[]> {
    const result = (await this.sendRequest("tools/list")) as {
      tools: Array<{
        name: string
        description?: string
        inputSchema?: {
          type?: string
          properties?: Record<
            string,
            { type: string; description?: string; enum?: string[] }
          >
          required?: string[]
        }
      }>
    }

    if (!result?.tools) return []

    return result.tools.map((tool) => {
      const props: Record<
        string,
        { type: string; description: string; enum?: string[] }
      > = {}
      if (tool.inputSchema?.properties) {
        for (const [key, val] of Object.entries(tool.inputSchema.properties)) {
          props[key] = {
            type: val.type || "string",
            description: val.description || "",
            ...(val.enum ? { enum: val.enum } : {}),
          }
        }
      }

      return {
        name: tool.name,
        description: tool.description || "",
        parameters: {
          type: "object" as const,
          properties: props,
          required: tool.inputSchema?.required || [],
        },
      }
    })
  }

  async callTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<unknown> {
    const result = await this.sendRequest("tools/call", {
      name,
      arguments: args,
    })

    return result ?? ""
  }

  isInitialized(): boolean {
    return this.initialized
  }

  getSessionId(): string | null {
    return this.sessionId
  }
}
