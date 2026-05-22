#!/usr/bin/env node
import { runMcpServer } from "./lib/mcp-stdio.mjs"

runMcpServer({
  name: "mock-error",
  version: "0.0.1",
  tools: [
    {
      name: "always_fails",
      description: "Returns isError:true with an error text block",
      inputSchema: { type: "object", properties: {}, required: [] },
      call: async () => ({
        content: [
          {
            type: "text",
            text: "The requested operation failed: network unreachable",
          },
        ],
        isError: true,
      }),
    },
  ],
})
