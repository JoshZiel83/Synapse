#!/usr/bin/env node
import { runMcpServer } from "./lib/mcp-stdio.mjs"
import { PNG_1X1_BASE64 } from "./lib/fixtures.mjs"

runMcpServer({
  name: "mock-image-base64",
  version: "0.0.1",
  tools: [
    {
      name: "render_image",
      description:
        "Returns a 1x1 PNG as MCP-standard {type:image, data, mimeType}",
      inputSchema: { type: "object", properties: {}, required: [] },
      call: async () => ({
        content: [
          { type: "image", data: PNG_1X1_BASE64, mimeType: "image/png" },
        ],
        isError: false,
      }),
    },
  ],
})
