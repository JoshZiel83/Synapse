// Minimal MCP stdio server framework — newline-delimited JSON-RPC 2.0.
// Used by integration tests to spawn a controllable MCP server that an
// MCP stdio client can connect to via stdio transport.
//
// Usage:
//   import { runMcpServer } from "./lib/mcp-stdio.mjs"
//   runMcpServer({
//     name: "mock-image-base64",
//     version: "0.0.1",
//     tools: [
//       {
//         name: "make_image",
//         description: "Returns a base64 image",
//         inputSchema: { type: "object", properties: {}, required: [] },
//         call: async (_input) => ({
//           content: [{ type: "image", data: "<base64>", mimeType: "image/png" }],
//           isError: false,
//         }),
//       },
//     ],
//   })

import { createInterface } from "node:readline"

function writeMessage(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n")
}

function logErr(...args) {
  // MCP stdio servers MUST keep stdout clean (JSON-RPC only). Use stderr.
  process.stderr.write("[mcp-mock] " + args.join(" ") + "\n")
}

export function runMcpServer({
  name,
  version,
  tools,
  protocolVersion = "2024-11-05",
}) {
  const toolsByName = new Map()
  for (const tool of tools) {
    toolsByName.set(tool.name, tool)
  }

  const rl = createInterface({ input: process.stdin })

  rl.on("line", async (line) => {
    if (!line.trim()) return
    let msg
    try {
      msg = JSON.parse(line)
    } catch (err) {
      logErr("Failed to parse incoming line:", err.message)
      return
    }

    // Notifications have no id and expect no response.
    if (msg.id === undefined || msg.id === null) {
      // notifications/initialized, etc — ignore.
      return
    }

    try {
      const result = await dispatch(msg.method, msg.params, {
        toolsByName,
        name,
        version,
        protocolVersion,
      })
      writeMessage({ jsonrpc: "2.0", id: msg.id, result })
    } catch (err) {
      writeMessage({
        jsonrpc: "2.0",
        id: msg.id,
        error: {
          code: err?.code || -32000,
          message: err?.message || String(err),
        },
      })
    }
  })

  rl.on("close", () => {
    process.exit(0)
  })

  // Make sure stderr knows we booted.
  logErr(`Server ${name}@${version} ready, waiting on stdin...`)
}

async function dispatch(method, params, ctx) {
  switch (method) {
    case "initialize":
      return {
        protocolVersion: ctx.protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: ctx.name, version: ctx.version },
      }

    case "tools/list":
      return {
        tools: Array.from(ctx.toolsByName.values()).map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema || {
            type: "object",
            properties: {},
            required: [],
          },
        })),
      }

    case "tools/call": {
      const tool = ctx.toolsByName.get(params?.name)
      if (!tool) {
        throw Object.assign(new Error(`Unknown tool: ${params?.name}`), {
          code: -32601,
        })
      }
      const result = await tool.call(params.arguments || {})
      // MCP tools/call result shape: { content, isError?, structuredContent? }
      return {
        content: result.content || [],
        isError: result.isError === true,
        ...(result.structuredContent !== undefined
          ? { structuredContent: result.structuredContent }
          : {}),
      }
    }

    default:
      throw Object.assign(new Error(`Method not implemented: ${method}`), {
        code: -32601,
      })
  }
}
