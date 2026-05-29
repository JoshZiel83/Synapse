#!/usr/bin/env node
// Tiny MCP echo server for device-runtime mcp-stdio-sidecar tests. Pure JS
// to avoid the tsx/ts-node detour when node spawns this binary directly.
// Plan §Phase 4.

import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js"

const server = new Server(
  { name: "fake-mcp-echo", version: "0.0.1" },
  { capabilities: { tools: {} } }
)

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "echo",
        description: "Echoes the provided 'text' arg back as content.",
        inputSchema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        },
      },
    ],
  }
})

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params?.name
  if (name !== "echo") {
    return {
      isError: true,
      content: [{ type: "text", text: `unknown tool: ${name}` }],
    }
  }
  const text = req.params?.arguments?.text ?? ""
  return {
    content: [{ type: "text", text: `echo: ${text}` }],
  }
})

const transport = new StdioServerTransport()
await server.connect(transport)
