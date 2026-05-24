#!/usr/bin/env node
import { runMcpServer } from "./lib/mcp-stdio.mjs"
import { WAV_SILENCE_100MS_BASE64 } from "./lib/fixtures.mjs"

runMcpServer({
  name: "mock-audio",
  version: "0.0.1",
  tools: [
    {
      name: "synth_audio",
      description: "Returns a tiny WAV as MCP {type:audio, data, mimeType}",
      inputSchema: { type: "object", properties: {}, required: [] },
      call: async () => ({
        content: [
          {
            type: "audio",
            data: WAV_SILENCE_100MS_BASE64,
            mimeType: "audio/wav",
          },
        ],
        isError: false,
      }),
    },
  ],
})
