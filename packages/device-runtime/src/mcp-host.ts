// In-process catalog manager + MCP host. v3.0 implementation is a minimal
// JSON-RPC over HTTP server bound to 127.0.0.1:0; the frp tunnel adapter
// fronts it so the API side can reach `tools/list` and `tools/call` through
// a Streamable HTTP transport without taking a hard dep on the upstream
// `@modelcontextprotocol/sdk` McpServer wrapper.
//
// MCP error-code preservation decision (§14 open item): we choose option (b)
// — embed code in `CallToolResult._meta.synapse_error`. This lets the host
// surface structured Synapse errors without leaving the high-level CallTool
// contract.

import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import type {
  DeviceCatalogExposure,
  DeviceCatalogTool,
  OperationEnvelope,
  SynapseError,
} from "@synapse/device-protocol"
import type {
  CatalogProvider,
  CatalogToolInvocationResult,
  EnvelopeVerifier,
  McpHost,
} from "./types.js"
import { hashArguments } from "./envelope.js"

export interface InMemoryMcpHostHandle extends McpHost {
  getCatalogSnapshot(): Promise<DeviceCatalogExposure[]>
  /**
   * Push a freshly delivered server public key (e.g. learned from the
   * device.hello ack envelope_signing block) into the verifier's trusted
   * map. Without this, runtimes that don't pre-configure trusted keys via
   * env would never see a server key and always reject tools/call.
   */
  addServerPublicKey(kid: string, publicKeyPem: string): void
  /**
   * Absorb the server-assigned catalog IDs returned by device.catalog.sync
   * so dispatchCallTool can reject any envelope whose target IDs don't
   * match a tool we actually own. Without this check the device-side
   * envelope verifier only proves the envelope was signed — not that it
   * was meant for this device's catalog.
   */
  setCatalogTargetIds(
    map: Record<
      string,
      {
        device_exposure_id: string
        tools: Record<
          string,
          { device_tool_id: string; device_tool_revision_id: string }
        >
      }
    >
  ): void
}

export interface InMemoryMcpHostOptions {
  /** Optional hostname / port override. Defaults to 127.0.0.1 + random port. */
  host?: string
  port?: number
  /**
   * Required when running outside loopback-only smoke tests: every tools/call
   * envelope must verify against this verifier + the serverPublicKeys map
   * before the provider is invoked. If absent, the host falls back to a
   * "no verification" mode (signed-but-not-checked) which is fine for
   * tests that exercise the host in isolation but unsafe for production.
   */
  envelopeVerifier?: EnvelopeVerifier
  serverPublicKeys?: ReadonlyMap<string, string>
}

interface ToolEntry {
  exposureKey: string
  tool: DeviceCatalogTool
  provider: CatalogProvider
}

export function createInMemoryMcpHost(
  opts: InMemoryMcpHostOptions = {}
): InMemoryMcpHostHandle {
  const providers = new Map<string, CatalogProvider>()
  // Live trusted-server-keys map: seeded from opts.serverPublicKeys (if
  // provided) and mutated at runtime via addServerPublicKey() when the
  // device.hello ack delivers fresh keys. The verifier reads through this
  // map on every call so the envelope verification surface always sees the
  // current state.
  const trustedServerKeys = new Map<string, string>(
    opts.serverPublicKeys ? Array.from(opts.serverPublicKeys.entries()) : []
  )
  // Server-assigned catalog target IDs, populated by setCatalogTargetIds()
  // after each device.catalog.sync ack. Keyed by tool name (the same name
  // dispatchCallTool resolves on) so the envelope target check is O(1).
  const toolTargetIndex = new Map<
    string,
    {
      device_exposure_id: string
      device_tool_id: string
      device_tool_revision_id: string
    }
  >()
  let server: Server | null = null
  let listenPort = 0

  async function buildToolIndex(): Promise<Map<string, ToolEntry>> {
    const index = new Map<string, ToolEntry>()
    for (const provider of providers.values()) {
      const exposures = await provider.describeExposures()
      for (const exposure of exposures) {
        for (const tool of exposure.tools) {
          index.set(tool.name, {
            exposureKey: exposure.stable_key,
            tool,
            provider,
          })
        }
      }
    }
    return index
  }

  async function listAllTools(): Promise<DeviceCatalogTool[]> {
    const out: DeviceCatalogTool[] = []
    for (const entry of (await buildToolIndex()).values()) {
      out.push(entry.tool)
    }
    return out
  }

  async function dispatchCallTool(params: {
    name: unknown
    arguments?: unknown
    _meta?: unknown
  }): Promise<CatalogToolInvocationResult> {
    if (typeof params.name !== "string") {
      const synapseError: SynapseError = {
        code: "invalid_request",
        message: "tools/call params.name must be a string",
      }
      return {
        content: [{ type: "text", text: synapseError.message }],
        isError: true,
        _meta: { synapse_error: synapseError },
      }
    }
    const args =
      params.arguments && typeof params.arguments === "object"
        ? (params.arguments as Record<string, unknown>)
        : {}
    const envelope = extractEnvelope(params._meta)
    // Envelope verification gates every tool call. Without a verifier
    // configured, this is a v3-skeleton loopback smoke test (no envelope
    // means no enforcement); ANY production wiring MUST pass an
    // envelopeVerifier so missing/unsigned calls are rejected.
    if (opts.envelopeVerifier) {
      if (!envelope) {
        const synapseError: SynapseError = {
          code: "permission_denied",
          message:
            "tools/call requires _meta.synapse_operation envelope; the server must sign every dispatch",
        }
        return {
          content: [{ type: "text", text: synapseError.message }],
          isError: true,
          _meta: { synapse_error: synapseError },
        }
      }
      if (trustedServerKeys.size === 0) {
        // No keys yet (e.g. hello hasn't completed): refuse rather than
        // silently letting unauthenticated calls through.
        const synapseError: SynapseError = {
          code: "permission_denied",
          message:
            "tools/call rejected: runtime has no trusted server signing keys yet",
        }
        return {
          content: [{ type: "text", text: synapseError.message }],
          isError: true,
          _meta: { synapse_error: synapseError },
        }
      }
      const verifyResult = await opts.envelopeVerifier.verify(
        envelope,
        hashArguments(args),
        trustedServerKeys
      )
      if (!verifyResult.ok) {
        const synapseError: SynapseError = {
          code: verifyResult.code,
          message: verifyResult.message,
        }
        return {
          content: [{ type: "text", text: synapseError.message }],
          isError: true,
          _meta: { synapse_error: synapseError },
        }
      }
      // Envelope target check: the signature proves the SERVER signed an
      // envelope for SOME tool, but says nothing about whether that tool
      // lives on this device. Cross-reference the envelope's target ids
      // against the assigned-id map we got from device.catalog.sync. A
      // mismatch means either we're being asked to run a peer's tool or
      // the catalog hasn't synced yet — in both cases we refuse.
      if (toolTargetIndex.size > 0) {
        const expected = toolTargetIndex.get(params.name)
        if (!expected) {
          const synapseError: SynapseError = {
            code: "invalid_request",
            message: `tool ${params.name} is not in this device's synced catalog`,
          }
          return {
            content: [{ type: "text", text: synapseError.message }],
            isError: true,
            _meta: { synapse_error: synapseError },
          }
        }
        if (
          envelope.device_exposure_id !== expected.device_exposure_id ||
          envelope.device_tool_id !== expected.device_tool_id ||
          envelope.device_tool_revision_id !==
            expected.device_tool_revision_id
        ) {
          const synapseError: SynapseError = {
            code: "permission_denied",
            message:
              "envelope target ids (capability/exposure/tool/revision) do not match this device's catalog",
          }
          return {
            content: [{ type: "text", text: synapseError.message }],
            isError: true,
            _meta: { synapse_error: synapseError },
          }
        }
      }
    }
    const index = await buildToolIndex()
    const entry = index.get(params.name)
    if (!entry) {
      const synapseError: SynapseError = {
        code: "invalid_request",
        message: `unknown tool ${params.name}`,
      }
      return {
        content: [{ type: "text", text: synapseError.message }],
        isError: true,
        _meta: { synapse_error: synapseError },
      }
    }
    if (!entry.provider.invokeTool) {
      const synapseError: SynapseError = {
        code: "runtime_constraint",
        message: `tool ${params.name} has no executable handler in v3.0 skeleton`,
      }
      return {
        content: [{ type: "text", text: synapseError.message }],
        isError: true,
        _meta: { synapse_error: synapseError },
      }
    }
    try {
      return await entry.provider.invokeTool({
        toolName: params.name,
        args,
        envelope,
      })
    } catch (err) {
      const synapseError: SynapseError = {
        code: "runtime_constraint",
        message: `tool ${params.name} threw: ${(err as Error).message}`,
      }
      return {
        content: [{ type: "text", text: synapseError.message }],
        isError: true,
        _meta: { synapse_error: synapseError },
      }
    }
  }

  function extractEnvelope(meta: unknown): OperationEnvelope | undefined {
    if (!meta || typeof meta !== "object") return undefined
    const raw = (meta as Record<string, unknown>)["synapse_operation"]
    if (!raw || typeof raw !== "object") return undefined
    return raw as OperationEnvelope
  }

  async function handleJsonRpc(body: {
    id?: string | number | null
    method?: unknown
    params?: unknown
  }): Promise<{ id: string | number | null; result?: unknown; error?: { code: number; message: string } }> {
    const id = (body.id ?? null) as string | number | null
    if (typeof body.method !== "string") {
      return { id, error: { code: -32600, message: "method required" } }
    }
    switch (body.method) {
      case "initialize": {
        return {
          id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: {
              name: "@synapse/device-runtime",
              version: "0.1.0",
            },
          },
        }
      }
      case "tools/list": {
        return { id, result: { tools: await listAllTools() } }
      }
      case "tools/call": {
        const params =
          body.params && typeof body.params === "object"
            ? (body.params as { name: unknown; arguments?: unknown; _meta?: unknown })
            : { name: undefined }
        const result = await dispatchCallTool(params)
        return { id, result }
      }
      default: {
        return {
          id,
          error: { code: -32601, message: `method not found: ${body.method}` },
        }
      }
    }
  }

  async function startServer(): Promise<void> {
    if (server) return
    const host = opts.host ?? "127.0.0.1"
    const port = opts.port ?? 0
    server = createServer((req, res) => {
      if (req.method !== "POST" || req.url !== "/mcp") {
        res.statusCode = 404
        res.setHeader("content-type", "application/json")
        res.end(JSON.stringify({ error: { code: -32601, message: "not found" } }))
        return
      }
      const chunks: Buffer[] = []
      req.on("data", (c: Buffer) => chunks.push(c))
      req.on("end", () => {
        ;(async () => {
          let body: unknown
          try {
            body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")
          } catch {
            res.statusCode = 400
            res.setHeader("content-type", "application/json")
            res.end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: null,
                error: { code: -32700, message: "parse error" },
              })
            )
            return
          }
          const envelope = await handleJsonRpc(
            body as { id?: string | number | null; method?: unknown; params?: unknown }
          )
          res.statusCode = 200
          res.setHeader("content-type", "application/json")
          res.end(JSON.stringify({ jsonrpc: "2.0", ...envelope }))
        })().catch((err) => {
          res.statusCode = 500
          res.setHeader("content-type", "application/json")
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: null,
              error: { code: -32603, message: (err as Error).message },
            })
          )
        })
      })
    })
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject)
      server!.listen(port, host, () => {
        const addr = server!.address() as AddressInfo
        listenPort = addr.port
        resolve()
      })
    })
  }

  async function stopServer(): Promise<void> {
    if (!server) return
    await new Promise<void>((resolve) =>
      server!.close(() => resolve())
    )
    server = null
    listenPort = 0
  }

  return {
    get localPort() {
      return listenPort
    },
    async start() {
      await startServer()
    },
    async stop() {
      await stopServer()
    },
    addServerPublicKey(kid: string, publicKeyPem: string) {
      trustedServerKeys.set(kid, publicKeyPem)
    },
    setCatalogTargetIds(map) {
      // Replace, not merge — every catalog.sync ack is authoritative.
      // Stale tools should disappear from the target index immediately
      // so a dispatch for a removed tool fails closed.
      toolTargetIndex.clear()
      for (const exposure of Object.values(map)) {
        for (const [toolName, ids] of Object.entries(exposure.tools)) {
          toolTargetIndex.set(toolName, {
            device_exposure_id: exposure.device_exposure_id,
            device_tool_id: ids.device_tool_id,
            device_tool_revision_id: ids.device_tool_revision_id,
          })
        }
      }
    },
    async registerCatalog(provider: CatalogProvider) {
      providers.set(provider.providerKey, provider)
    },
    async unregisterCatalog(providerKey: string) {
      providers.delete(providerKey)
    },
    async getCatalogSnapshot() {
      const all: DeviceCatalogExposure[] = []
      for (const provider of providers.values()) {
        const exposures = await provider.describeExposures()
        all.push(...exposures)
      }
      return all
    },
  }
}

/**
 * Helper for builtin tool handlers to surface a structured error via the
 * `_meta.synapse_error` field of the MCP CallToolResult so the API side can
 * recover the v3 device-side error code (§4.5).
 */
export function toolErrorResult(err: SynapseError): CatalogToolInvocationResult {
  return {
    content: [{ type: "text" as const, text: err.message }],
    isError: true,
    _meta: { synapse_error: err },
  }
}
