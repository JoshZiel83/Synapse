#!/usr/bin/env node
// Server emits {type:"image", source:{type:"url", url:"..."}}.
// Synapse normalizer must download from the URL and store as file_ref.
// The URL is read from env IMAGE_SOURCE_URL set by the test harness so
// the test controls where the image is served from.
import { runMcpServer } from "./lib/mcp-stdio.mjs"

const url = process.env.IMAGE_SOURCE_URL
if (!url) {
  process.stderr.write("[mock-image-url] IMAGE_SOURCE_URL env not set\n")
  process.exit(1)
}

runMcpServer({
  name: "mock-image-url",
  version: "0.0.1",
  tools: [
    {
      name: "fetch_image",
      description: "Returns an image block whose source is a URL",
      inputSchema: { type: "object", properties: {}, required: [] },
      call: async () => ({
        content: [{ type: "image", source: { type: "url", url } }],
        isError: false,
      }),
    },
  ],
})
