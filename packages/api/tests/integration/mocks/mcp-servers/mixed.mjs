#!/usr/bin/env node
// Mixes text + image + resource(text) in one tool result, exercising
// multi-block normalization order preservation.
import { runMcpServer } from "./lib/mcp-stdio.mjs"
import { PNG_1X1_BASE64 } from "./lib/fixtures.mjs"

runMcpServer({
  name: "mock-mixed",
  version: "0.0.1",
  tools: [
    {
      name: "render_report",
      description:
        "Mixed content: header text, image, summary text, citation resource",
      inputSchema: { type: "object", properties: {}, required: [] },
      call: async () => ({
        content: [
          { type: "text", text: "Header" },
          { type: "image", data: PNG_1X1_BASE64, mimeType: "image/png" },
          { type: "text", text: "Summary line" },
          {
            type: "resource",
            resource: {
              uri: "test://citation",
              mimeType: "text/plain",
              text: "citation body",
            },
          },
        ],
        isError: false,
      }),
    },
  ],
})
