#!/usr/bin/env node
import { runMcpServer } from "./lib/mcp-stdio.mjs"
import { JPEG_8X8_BASE64 } from "./lib/fixtures.mjs"

runMcpServer({
  name: "mock-resource-blob",
  version: "0.0.1",
  tools: [
    {
      name: "fetch_binary_resource",
      description:
        "Returns a resource containing a base64 blob with explicit name + metadata",
      inputSchema: { type: "object", properties: {}, required: [] },
      call: async () => ({
        content: [
          {
            type: "resource",
            resource: {
              uri: "test://chart.jpg",
              mimeType: "image/jpeg",
              name: "chart.jpg",
              blob: JPEG_8X8_BASE64,
              metadata: { source: "mock-resource-blob", chartId: "alpha" },
            },
          },
        ],
        isError: false,
      }),
    },
  ],
})
