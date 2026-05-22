#!/usr/bin/env node
import { runMcpServer } from "./lib/mcp-stdio.mjs"

runMcpServer({
  name: "mock-structured",
  version: "0.0.1",
  tools: [
    {
      name: "lookup",
      description:
        "Returns a tool result with structuredContent JSON alongside text",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
      call: async (input) => ({
        content: [{ type: "text", text: `Lookup for id=${input.id}` }],
        structuredContent: {
          id: input.id,
          payload: { score: 0.87, label: "match" },
          tags: ["alpha", "beta"],
        },
        isError: false,
      }),
    },
  ],
})
