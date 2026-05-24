#!/usr/bin/env node
// Anthropic-style image block: {type:"image", source:{type:"base64", media_type, data}}
// Some MCP-bridge servers emit this shape; the normalizer must handle it.
import { runMcpServer } from "./lib/mcp-stdio.mjs"
import { PNG_1X1_BASE64 } from "./lib/fixtures.mjs"

runMcpServer({
  name: "mock-image-source-base64",
  version: "0.0.1",
  tools: [
    {
      name: "render_image",
      description: "Returns a PNG using Anthropic-style source.base64 shape",
      inputSchema: { type: "object", properties: {}, required: [] },
      call: async () => ({
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: PNG_1X1_BASE64,
            },
          },
        ],
        isError: false,
      }),
    },
  ],
})
