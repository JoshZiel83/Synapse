#!/usr/bin/env node
import { runMcpServer } from "./lib/mcp-stdio.mjs"

runMcpServer({
  name: "mock-text-only",
  version: "0.0.1",
  tools: [
    {
      name: "echo",
      description: "Returns the input message as a single text block",
      inputSchema: {
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"],
      },
      call: async (input) => ({
        content: [{ type: "text", text: input.message || "" }],
        isError: false,
      }),
    },
    {
      name: "multi_text",
      description: "Returns two text blocks",
      inputSchema: { type: "object", properties: {}, required: [] },
      call: async () => ({
        content: [
          { type: "text", text: "first text block" },
          { type: "text", text: "second text block" },
        ],
        isError: false,
      }),
    },
  ],
})
