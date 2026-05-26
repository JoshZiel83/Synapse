// Provider unit tests — fake McpClient is injected so no sidecar is spawned.
// Live e2e is gated on SYNAPSE_BROWSER_MCP_LIVE_TEST and lives at the bottom.

import test from "node:test"
import assert from "node:assert/strict"
import { createServer, type Server } from "node:http"
import {
  createChromeDevtoolsMcpBuiltin,
  PINNED_VERSION,
} from "./chrome-devtools-mcp.js"
import { signOperationEnvelope } from "@synapse/device-protocol"
import type { McpCallToolResult, McpClient } from "../mcp-stdio-sidecar.js"
import type {
  BrowserOperation,
  OperationEnvelope,
} from "@synapse/device-protocol"
import { generateKeyPairSync } from "node:crypto"

// ────────────────────────────── helpers ─────────────────────────────────────

interface FakeCallLog {
  name: string
  arguments: Record<string, unknown> | undefined
}

interface FakeClientOptions {
  listToolsResponse?: () => Promise<{
    tools: { name: string; description?: string; inputSchema?: unknown }[]
  }>
  handlers?: Record<
    string,
    (args: Record<string, unknown> | undefined) => Promise<McpCallToolResult>
  >
}

function makeFakeClient(opts: FakeClientOptions = {}): McpClient & {
  log: FakeCallLog[]
} {
  const log: FakeCallLog[] = []
  const handlers = opts.handlers ?? {}
  const defaultList: { tools: { name: string }[] } = {
    tools: Object.keys(handlers).map((name) => ({ name })),
  }
  const client: McpClient & { log: FakeCallLog[] } = {
    log,
    async listTools() {
      if (opts.listToolsResponse) return opts.listToolsResponse()
      return defaultList
    },
    async callTool({ name, arguments: args }) {
      log.push({ name, arguments: args })
      const handler = handlers[name]
      if (handler) return handler(args)
      return {
        content: [{ type: "text", text: `unhandled fake: ${name}` }],
        isError: true,
      }
    },
    async close() {},
  }
  return client
}

// Build an envelope-shaped object with the given browser grants. Tests do not
// run envelope-signature verification here (the provider only reads
// runtime_authorization.grant_specs), but we use signOperationEnvelope to keep
// the shape realistic.
function envWithGrants(
  grants: Array<{
    action: "read" | "write"
    scope_type: "origin" | "host" | "domain"
    origin?: string
    host?: string
    registrable_domain?: string
    operations?: BrowserOperation[]
  }>
): OperationEnvelope {
  // Generate a throwaway Ed25519 key to satisfy signOperationEnvelope.
  const { privateKey } = generateKeyPairSync("ed25519")
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string
  return signOperationEnvelope(
    {
      operation_id: "00000000-0000-0000-0000-000000000001",
      attempt_id: "00000000-0000-0000-0000-000000000002",
      device_runtime_session_id: "00000000-0000-0000-0000-000000000003",
      device_capability_id: "00000000-0000-0000-0000-000000000004",
      device_exposure_id: "00000000-0000-0000-0000-000000000005",
      device_tool_id: "00000000-0000-0000-0000-000000000006",
      device_tool_revision_id: "00000000-0000-0000-0000-000000000007",
      input_hash: "sha256:0",
      task_mode: "sync",
      runtime_authorization: {
        grant_ids: grants.map(
          (_, i) => "00000000-0000-0000-0000-" + String(i).padStart(12, "0")
        ),
        grant_scope: "workspace",
        grant_specs: grants.map((g) => ({
          capability: "browser",
          browser: g,
        })),
      },
      issued_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      signature_kid: "test-kid",
    },
    pem
  )
}

// ──────────────────────────── tests ─────────────────────────────────────────

test("describeExposures advertises 8 exposures (3 enabled, 5 disabled)", async () => {
  const provider = createChromeDevtoolsMcpBuiltin({
    mcpClientFactory: async () => makeFakeClient(),
  })
  const exposures = await provider.describeExposures()
  assert.equal(exposures.length, 8)
  const enabled = exposures.filter((e) => e.metadata?.enabled === true)
  const disabled = exposures.filter((e) => e.metadata?.enabled === false)
  assert.equal(enabled.length, 3)
  assert.equal(disabled.length, 5)
  const enabledKeys = enabled.map((e) => e.stable_key).sort()
  assert.deepEqual(enabledKeys, [
    "builtin/browser/input",
    "builtin/browser/navigation",
    "builtin/browser/read",
  ])
  const webmcp = exposures.find(
    (e) => e.stable_key === "builtin/browser/webmcp"
  )
  assert.ok(webmcp)
  assert.equal(webmcp?.tools.length, 0)
  const extensions = exposures.find(
    (e) => e.stable_key === "builtin/browser/extensions"
  )
  assert.ok(extensions)
  assert.equal(extensions?.tools.length, 0)
})

test("click without grant returns permission_denied", async () => {
  const client = makeFakeClient({
    handlers: {
      list_pages: async () => ({
        structuredContent: [
          { pageId: 0, url: "https://example.com", isActive: true },
        ],
      }),
      click: async () => ({ content: [{ type: "text", text: "clicked" }] }),
    },
  })
  const provider = createChromeDevtoolsMcpBuiltin({
    mcpClientFactory: async () => client,
  })
  const result = await provider.invokeTool!({
    toolName: "click",
    args: { uid: "btn" },
  })
  assert.equal(result.isError, true)
  assert.match(
    (
      (result._meta?.synapse_error as { message?: string })?.message ?? ""
    ).toString(),
    /no grant covers page\.input/
  )
  // sidecar should NOT have received the click
  assert.deepEqual(
    client.log.map((c) => c.name),
    ["list_pages"]
  )
})

test("click with page.read-only grant denies page.input", async () => {
  const client = makeFakeClient({
    handlers: {
      list_pages: async () => ({
        structuredContent: [
          { pageId: 0, url: "https://example.com", isActive: true },
        ],
      }),
      click: async () => ({ content: [{ type: "text", text: "clicked" }] }),
    },
  })
  const provider = createChromeDevtoolsMcpBuiltin({
    mcpClientFactory: async () => client,
  })
  const envelope = envWithGrants([
    {
      action: "write",
      scope_type: "origin",
      origin: "https://example.com",
      operations: ["page.read"],
    },
  ])
  const result = await provider.invokeTool!({
    toolName: "click",
    args: { uid: "btn" },
    envelope,
  })
  assert.equal(result.isError, true)
  assert.equal(client.log.filter((c) => c.name === "click").length, 0)
})

test("click with matching page.input grant forwards to sidecar", async () => {
  const client = makeFakeClient({
    handlers: {
      list_pages: async () => ({
        structuredContent: [
          { pageId: 0, url: "https://example.com", isActive: true },
        ],
      }),
      click: async () => ({ content: [{ type: "text", text: "clicked" }] }),
    },
  })
  const provider = createChromeDevtoolsMcpBuiltin({
    mcpClientFactory: async () => client,
  })
  const envelope = envWithGrants([
    {
      action: "write",
      scope_type: "origin",
      origin: "https://example.com",
      operations: ["page.input"],
    },
  ])
  const result = await provider.invokeTool!({
    toolName: "click",
    args: { uid: "btn" },
    envelope,
  })
  assert.equal(result.isError ?? false, false)
  assert.ok(client.log.some((c) => c.name === "click"))
})

test("legacy grant without operations denies any operation (fail-closed)", async () => {
  const client = makeFakeClient({
    handlers: {
      list_pages: async () => ({
        structuredContent: [
          { pageId: 0, url: "https://example.com", isActive: true },
        ],
      }),
      take_snapshot: async () => ({ content: [{ type: "text", text: "ok" }] }),
    },
  })
  const provider = createChromeDevtoolsMcpBuiltin({
    mcpClientFactory: async () => client,
  })
  const envelope = envWithGrants([
    // No `operations` field at all.
    {
      action: "write",
      scope_type: "origin",
      origin: "https://example.com",
    },
  ])
  const result = await provider.invokeTool!({
    toolName: "take_snapshot",
    args: {},
    envelope,
  })
  assert.equal(result.isError, true)
})

test("navigate_page resolving to unauthorized origin triggers remediation", async () => {
  let navigated = false
  const client = makeFakeClient({
    handlers: {
      navigate_page: async (args) => {
        if (args?.url === "about:blank") {
          navigated = true
          return { content: [{ type: "text", text: "ok" }] }
        }
        return {
          structuredContent: {
            resolvedUrl: "https://blocked.com/landing",
            pageId: 1,
            success: true,
          },
        }
      },
    },
  })
  const provider = createChromeDevtoolsMcpBuiltin({
    mcpClientFactory: async () => client,
  })
  const envelope = envWithGrants([
    {
      action: "write",
      scope_type: "origin",
      origin: "https://allowed.com",
      operations: ["page.navigate"],
    },
  ])
  const result = await provider.invokeTool!({
    toolName: "navigate_page",
    args: { type: "url", url: "https://allowed.com" },
    envelope,
  })
  assert.equal(result.isError, true)
  assert.ok(navigated)
})

test("new_page falling outside grant triggers close_page remediation", async () => {
  let closed = false
  const client = makeFakeClient({
    handlers: {
      new_page: async () => ({
        structuredContent: {
          resolvedUrl: "https://blocked.com",
          pageId: 7,
          success: true,
        },
      }),
      close_page: async (args) => {
        if (args?.pageId === 7) closed = true
        return { content: [{ type: "text", text: "closed" }] }
      },
    },
  })
  const provider = createChromeDevtoolsMcpBuiltin({
    mcpClientFactory: async () => client,
  })
  const envelope = envWithGrants([
    {
      action: "write",
      scope_type: "origin",
      origin: "https://allowed.com",
      operations: ["page.navigate"],
    },
  ])
  const result = await provider.invokeTool!({
    toolName: "new_page",
    args: { url: "https://allowed.com" },
    envelope,
  })
  assert.equal(result.isError, true)
  assert.equal(closed, true)
})

test("list_pages filters unauthorized + non-web-scheme pages silently", async () => {
  const client = makeFakeClient({
    handlers: {
      list_pages: async () => ({
        structuredContent: [
          { pageId: 0, url: "https://allowed.com", isActive: true },
          { pageId: 1, url: "https://blocked.com" },
          { pageId: 2, url: "about:blank" },
          { pageId: 3, url: "chrome://newtab" },
        ],
      }),
    },
  })
  const provider = createChromeDevtoolsMcpBuiltin({
    mcpClientFactory: async () => client,
  })
  const envelope = envWithGrants([
    {
      action: "read",
      scope_type: "origin",
      origin: "https://allowed.com",
      operations: ["page.read"],
    },
  ])
  const result = await provider.invokeTool!({
    toolName: "list_pages",
    args: {},
    envelope,
  })
  const meta = result._meta?.synapse_list_pages as
    | { pages?: Array<{ url: string }> }
    | undefined
  assert.equal(meta?.pages?.length, 1)
  assert.equal(meta?.pages?.[0]?.url, "https://allowed.com")
})

test("close_page with pageId looks up URL via list_pages before authz", async () => {
  let closed = false
  const client = makeFakeClient({
    handlers: {
      list_pages: async () => ({
        structuredContent: [
          { pageId: 5, url: "https://allowed.com", isActive: false },
          { pageId: 6, url: "https://blocked.com", isActive: true },
        ],
      }),
      close_page: async (args) => {
        if (args?.pageId === 5) closed = true
        return { content: [{ type: "text", text: "closed" }] }
      },
    },
  })
  const provider = createChromeDevtoolsMcpBuiltin({
    mcpClientFactory: async () => client,
  })
  const envelope = envWithGrants([
    {
      action: "write",
      scope_type: "origin",
      origin: "https://allowed.com",
      operations: ["page.navigate"],
    },
  ])
  const r = await provider.invokeTool!({
    toolName: "close_page",
    args: { pageId: 5 },
    envelope,
  })
  assert.equal(r.isError ?? false, false)
  assert.equal(closed, true)
})

test("evaluate_script disabled by default returns runtime_constraint", async () => {
  const provider = createChromeDevtoolsMcpBuiltin({
    mcpClientFactory: async () => makeFakeClient(),
  })
  const result = await provider.invokeTool!({
    toolName: "evaluate_script",
    args: { function: "() => 1" },
  })
  assert.equal(result.isError, true)
  assert.match(
    (
      (result._meta?.synapse_error as { message?: string })?.message ?? ""
    ).toString(),
    /disabled/
  )
})

test("evaluate_script with allowScript + matching script.evaluate grant forwards", async () => {
  const client = makeFakeClient({
    handlers: {
      list_pages: async () => ({
        structuredContent: [
          { pageId: 0, url: "https://example.com", isActive: true },
        ],
      }),
      evaluate_script: async () => ({
        content: [{ type: "text", text: "1" }],
      }),
    },
  })
  const provider = createChromeDevtoolsMcpBuiltin({
    allowScript: true,
    mcpClientFactory: async () => client,
  })
  const envelope = envWithGrants([
    {
      action: "write",
      scope_type: "origin",
      origin: "https://example.com",
      operations: ["script.evaluate"],
    },
  ])
  const r = await provider.invokeTool!({
    toolName: "evaluate_script",
    args: { function: "() => 1" },
    envelope,
  })
  assert.equal(r.isError ?? false, false)
})

test("file path blacklist rejects take_screenshot({filePath})", async () => {
  const provider = createChromeDevtoolsMcpBuiltin({
    mcpClientFactory: async () => makeFakeClient(),
  })
  const r = await provider.invokeTool!({
    toolName: "take_screenshot",
    args: { filePath: "/tmp/x.png" },
  })
  assert.equal(r.isError, true)
  assert.match(
    (
      (r._meta?.synapse_error as { message?: string })?.message ?? ""
    ).toString(),
    /local filesystem/
  )
})

test("preserved console messages rejected", async () => {
  const provider = createChromeDevtoolsMcpBuiltin({
    mcpClientFactory: async () => makeFakeClient(),
  })
  const r = await provider.invokeTool!({
    toolName: "list_console_messages",
    args: { includePreservedMessages: true },
  })
  assert.equal(r.isError, true)
})

test("get_network_request without reqid is invalid_request", async () => {
  const provider = createChromeDevtoolsMcpBuiltin({
    allowNetwork: true,
    mcpClientFactory: async () => makeFakeClient(),
  })
  const r = await provider.invokeTool!({
    toolName: "get_network_request",
    args: {},
  })
  assert.equal(r.isError, true)
  assert.match(
    (
      (r._meta?.synapse_error as { message?: string })?.message ?? ""
    ).toString(),
    /reqid is required/
  )
})

test("performance_start_trace with reload=true denies", async () => {
  const provider = createChromeDevtoolsMcpBuiltin({
    allowPerformance: true,
    mcpClientFactory: async () => makeFakeClient(),
  })
  const r = await provider.invokeTool!({
    toolName: "performance_start_trace",
    args: { reload: true },
  })
  assert.equal(r.isError, true)
})

test("install_extension is not in BROWSER_TOOL_MAP — unknown tool", async () => {
  const provider = createChromeDevtoolsMcpBuiltin({
    mcpClientFactory: async () => makeFakeClient(),
  })
  const r = await provider.invokeTool!({
    toolName: "install_extension",
    args: { path: "/x" },
  })
  assert.equal(r.isError, true)
  assert.match(
    (
      (r._meta?.synapse_error as { message?: string })?.message ?? ""
    ).toString(),
    /unknown browser tool/
  )
})

test("navigate_page argument_url with file: scheme rejected", async () => {
  const provider = createChromeDevtoolsMcpBuiltin({
    mcpClientFactory: async () => makeFakeClient(),
  })
  const envelope = envWithGrants([
    {
      action: "write",
      scope_type: "origin",
      origin: "https://example.com",
      operations: ["page.navigate"],
    },
  ])
  const r = await provider.invokeTool!({
    toolName: "navigate_page",
    args: { type: "url", url: "file:///etc/passwd" },
    envelope,
  })
  assert.equal(r.isError, true)
})

test("provider-wide mutex serializes overlapping calls", async () => {
  // Inject artificial latency in list_pages to expose any concurrency.
  let inFlight = 0
  let maxInFlight = 0
  const client = makeFakeClient({
    handlers: {
      list_pages: async () => {
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise((r) => setTimeout(r, 30))
        inFlight--
        return {
          structuredContent: [
            { pageId: 0, url: "https://allowed.com", isActive: true },
          ],
        }
      },
      take_snapshot: async () => ({
        content: [{ type: "text", text: "snap" }],
      }),
    },
  })
  const provider = createChromeDevtoolsMcpBuiltin({
    mcpClientFactory: async () => client,
  })
  const envelope = envWithGrants([
    {
      action: "read",
      scope_type: "origin",
      origin: "https://allowed.com",
      operations: ["page.read"],
    },
  ])
  await Promise.all([
    provider.invokeTool!({
      toolName: "take_snapshot",
      args: {},
      envelope,
    }),
    provider.invokeTool!({
      toolName: "take_snapshot",
      args: {},
      envelope,
    }),
    provider.invokeTool!({
      toolName: "take_snapshot",
      args: {},
      envelope,
    }),
  ])
  assert.equal(maxInFlight, 1)
})

// ─────────────────────── live e2e (gated) ──────────────────────────────────

const LIVE = process.env.SYNAPSE_BROWSER_MCP_LIVE_TEST === "1"
test(
  "live e2e — real pinned sidecar against local http server",
  { skip: !LIVE },
  async () => {
    const server: Server = createServer((_, res) => {
      res.writeHead(200, { "Content-Type": "text/html" })
      res.end("<html><body>hello</body></html>")
    })
    const port = await new Promise<number>((resolve) => {
      server.listen(0, () => {
        const addr = server.address()
        if (typeof addr !== "object" || !addr) throw new Error("no addr")
        resolve(addr.port)
      })
    })
    try {
      const provider = createChromeDevtoolsMcpBuiltin({
        headless: true,
      })
      const envelope = envWithGrants([
        {
          action: "write",
          scope_type: "origin",
          origin: `http://127.0.0.1:${port}`,
          operations: ["page.read", "page.navigate", "screenshot.capture"],
        },
      ])
      const newPage = await provider.invokeTool!({
        toolName: "new_page",
        args: { url: `http://127.0.0.1:${port}/` },
        envelope,
      })
      assert.equal(newPage.isError ?? false, false)
      const snap = await provider.invokeTool!({
        toolName: "take_snapshot",
        args: {},
        envelope,
      })
      assert.equal(snap.isError ?? false, false)
      await provider.dispose?.()
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  }
)

// ─────────────────────── version-consistency sanity ─────────────────────────

test("PINNED_VERSION matches optionalDependencies entry in package.json", async () => {
  const { readFileSync } = await import("node:fs")
  const { fileURLToPath } = await import("node:url")
  const { dirname, resolve } = await import("node:path")
  const here = dirname(fileURLToPath(import.meta.url))
  const pkgPath = resolve(here, "..", "..", "package.json")
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
    optionalDependencies?: Record<string, string>
  }
  assert.equal(
    pkg.optionalDependencies?.["chrome-devtools-mcp"],
    PINNED_VERSION,
    "package.json optionalDependencies must mirror PINNED_VERSION"
  )
})
