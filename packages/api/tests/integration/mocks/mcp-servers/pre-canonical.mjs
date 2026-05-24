#!/usr/bin/env node
// Some clients emit blocks already in Synapse canonical form (because their
// implementation imports @synapse/shared, e.g. a Synapse-built MCP server).
// The normalizer should pass these through unchanged.
import { runMcpServer } from "./lib/mcp-stdio.mjs"

runMcpServer({
  name: "mock-pre-canonical",
  version: "0.0.1",
  tools: [
    {
      name: "return_canonical",
      description:
        "Returns blocks already in Synapse canonical {type:file_ref,...} shape",
      inputSchema: { type: "object", properties: {}, required: [] },
      call: async () => ({
        content: [
          { type: "text", text: "Pre-canonical attachment" },
          {
            type: "file_ref",
            fileId: "00000000-0000-4000-8000-000000000000",
            url: "/files/00000000-0000-4000-8000-000000000000",
            mimeType: "application/pdf",
            originalName: "report.pdf",
            sizeBytes: 1024,
            category: "document",
          },
        ],
        isError: false,
      }),
    },
  ],
})
