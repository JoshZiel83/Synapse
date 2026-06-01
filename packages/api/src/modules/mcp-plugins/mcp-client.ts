import { ToolDefinition } from "@synapse/shared"

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
    const lines = text.split("\n")
    let lastData = ""

    for (const line of lines) {
      if (line.startsWith("data:")) {
        // SSE spec: space after colon is optional
        const payload = line.slice(5)
        lastData = payload.startsWith(" ") ? payload.slice(1) : payload
      }
    }

    if (!lastData) {
      throw new Error("No data in SSE response")
    }

    try {
      const json = JSON.parse(lastData) as JsonRpcResponse
      if (json.error) {
        throw new Error(
          `MCP RPC error ${json.error.code}: ${json.error.message}`
        )
      }
      return json.result
    } catch (e) {
      if (e instanceof SyntaxError) {
        // If we can't parse as JSON-RPC, return the raw text content
        return lastData
      }
      throw e
    }
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
