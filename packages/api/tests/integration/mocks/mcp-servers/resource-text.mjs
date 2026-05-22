#!/usr/bin/env node
import { runMcpServer } from "./lib/mcp-stdio.mjs"

runMcpServer({
  name: "mock-resource-text",
  version: "0.0.1",
  tools: [
    {
      name: "fetch_resource",
      description: "Returns a resource that contains inline text",
      inputSchema: { type: "object", properties: {}, required: [] },
      call: async () => ({
        content: [
          {
            type: "resource",
            resource: {
              uri: "test://greeting",
              mimeType: "text/plain",
              text: "Hello from the resource-text mock",
            },
          },
        ],
        isError: false,
      }),
    },
  ],
})
