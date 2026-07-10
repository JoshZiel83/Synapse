// In-process catalog manager + MCP host.
//
// **INTERIM IMPLEMENTATION — not the v3 data-plane terminus.** This is a
// hand-rolled JSON-RPC-over-HTTP server bound to 127.0.0.1:0, paired with
// the equally hand-rolled API-side dispatcher in
// `packages/api/src/modules/devices/dispatch.ts`. Both stand in for a
// Streamable-HTTP-based MCP transport (`@modelcontextprotocol/sdk`'s
// `McpServer` + `StreamableHttpClientTransport`) which we will swap to
// in a dedicated follow-up PR — see `docs/device-runtime-v3.md` §13 PR
// #N1 (Tool Data Plane → MCP SDK Streamable HTTP). Today's surface is
// just enough to validate envelope signing, target-id routing, and the
// runtime-authorization grant flow end-to-end without taking a hard dep
// on the upstream SDK; the wire shape is intentionally MCP-compatible so
// the swap is mechanical (drop in McpServer, keep the catalog + envelope
// glue).
//
// MCP error-code preservation decision (§14 open item): we choose option
// (b) — embed code in `CallToolResult._meta.synapse_error`. This lets the
// host surface structured Synapse errors without leaving the high-level
// CallTool contract.

import { createServer, type Server } from "node:http"
import { timingSafeEqual } from "node:crypto"
import type { AddressInfo } from "node:net"
import {
  DeviceCatalogExposure,
  DeviceCatalogTool,
  OperationEnvelope,
  OperationEnvelopeSchema,
  SynapseError,
} from "@synapse/device-protocol"
import type {
  CatalogProvider,
  CatalogToolInvocationResult,
  EnvelopeVerifier,
  McpHost,
} from "./types.js"
import { hashArguments } from "./envelope.js"
import { runWithTraceparent, traceparentFromMeta } from "./trace-context.js"
import {
  parseMcpHostRequestBody,
  type McpHostJsonRpcRequest,
} from "./mcp-host-codec.js"

type ExtractEnvelopeResult =
  | { kind: "missing" }
  | { kind: "invalid" }
  | { kind: "ok"; envelope: OperationEnvelope }

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
        runtime_exposure_id: string
        tools: Record<
          string,
          { runtime_tool_id: string; runtime_tool_revision_id: string }
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
  /**
   * Per-runtime inbound bearer for a DIRECT (network-reachable) data plane (§3.4
   * layer 2). When set, EVERY request (initialize / tools/list / tools/call) must
   * carry `Authorization: Bearer <this>` — closing the unauthenticated-enumeration
   * gap that is harmless under loopback/frp isolation but fatal off-box. When unset
   * the host may bind ONLY to loopback (fail-closed bind, §3.4 review fix G):
   * binding a non-loopback address without this configured throws at startup, so a
   * misconfigured template can never come "online" serving unauthenticated tools.
   * The API derives it as HMAC(server_secret, runtime_id) and injects it via env;
   * the host merely compares — it never derives.
   */
  requiredInboundAuth?: string
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
  // after each device.catalog.sync ack. Keyed by the server-assigned
  // runtime_tool_id (a globally unique UUID) so multiple exposures that
  // happen to ship same-named tools (search/read/bash) don't collide on
  // dispatch. The value carries the composite (exposure_stable_key,
  // tool_name) that maps back to the local provider's tool definition.
  const toolTargetIndex = new Map<
    string,
    {
      exposureStableKey: string
      toolName: string
      runtimeExposureId: string
      runtimeToolRevisionId: string
    }
  >()
  let server: Server | null = null
  let listenPort = 0

  function compositeToolKey(exposureStableKey: string, toolName: string) {
    return `${exposureStableKey}::${toolName}`
  }

  async function buildToolIndex(): Promise<Map<string, ToolEntry>> {
    // Keyed by `${exposure_stable_key}::${tool_name}` composite. Without
    // the exposure component, two providers (e.g. a filesystem mcp_plugin
    // and a code-search mcp_plugin) that both register `tool.name = "read"`
    // would clobber each other — the last writer would silently win and
    // every dispatch would route to it regardless of the envelope target.
    const index = new Map<string, ToolEntry>()
    for (const provider of providers.values()) {
      const exposures = await provider.describeExposures()
      for (const exposure of exposures) {
        for (const tool of exposure.tools) {
          index.set(compositeToolKey(exposure.stable_key, tool.name), {
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
    const envelopeResult = extractEnvelope(params._meta)
    let verifiedEnvelope: OperationEnvelope | undefined
    // Envelope verification gates every tool call. Without a verifier
    // configured, this is a v3-skeleton loopback smoke test (no envelope
    // means no enforcement); ANY production wiring MUST pass an
    // envelopeVerifier so missing/unsigned calls are rejected.
    if (opts.envelopeVerifier) {
      if (envelopeResult.kind === "missing") {
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
      if (envelopeResult.kind === "invalid") {
        const synapseError: SynapseError = {
          code: "invalid_request",
          message:
            "tools/call rejected: _meta.synapse_operation envelope failed schema validation",
        }
        return {
          content: [{ type: "text", text: synapseError.message }],
          isError: true,
          _meta: { synapse_error: synapseError },
        }
      }
      verifiedEnvelope = envelopeResult.envelope
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
        verifiedEnvelope,
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
      // Envelope target check (fail-closed). The signature proves the
      // server signed an envelope for SOME tool — it says nothing about
      // whether that tool lives on THIS device. We require an authoritative
      // catalog-sync ack to have populated toolTargetIndex; if it hasn't
      // (e.g. the WSS came up but device.catalog.sync hasn't completed
      // yet), refuse rather than wave the dispatch through.
      if (toolTargetIndex.size === 0) {
        const synapseError: SynapseError = {
          code: "permission_denied",
          message:
            "tools/call rejected: device catalog not yet synced — runtime will reject every envelope until device.catalog.sync ack populates the target index",
        }
        return {
          content: [{ type: "text", text: synapseError.message }],
          isError: true,
          _meta: { synapse_error: synapseError },
        }
      }
      // Route by envelope.runtime_tool_id — a globally unique server-issued
      // UUID. Bare params.name routing collapses two providers that ship
      // same-named tools (search/read/bash) so we can't use it as the
      // primary key.
      const expectedTarget = toolTargetIndex.get(
        verifiedEnvelope.runtime_tool_id
      )
      if (!expectedTarget) {
        const synapseError: SynapseError = {
          code: "permission_denied",
          message: `envelope runtime_tool_id ${verifiedEnvelope.runtime_tool_id} is not in this device's synced catalog`,
        }
        return {
          content: [{ type: "text", text: synapseError.message }],
          isError: true,
          _meta: { synapse_error: synapseError },
        }
      }
      if (
        verifiedEnvelope.runtime_exposure_id !==
          expectedTarget.runtimeExposureId ||
        verifiedEnvelope.runtime_tool_revision_id !==
          expectedTarget.runtimeToolRevisionId
      ) {
        const synapseError: SynapseError = {
          code: "permission_denied",
          message:
            "envelope target ids (exposure/tool/revision) do not match this device's catalog",
        }
        return {
          content: [{ type: "text", text: synapseError.message }],
          isError: true,
          _meta: { synapse_error: synapseError },
        }
      }
      // Defense in depth: the MCP `params.name` the caller supplied must
      // match the tool the envelope actually targets. Without this check a
      // forged tools/call could carry a valid envelope for tool A but
      // params.name=B and we'd resolve A in the target index but call B's
      // provider below.
      if (params.name !== expectedTarget.toolName) {
        const synapseError: SynapseError = {
          code: "invalid_request",
          message: `params.name (${params.name}) does not match the envelope's targeted tool (${expectedTarget.toolName})`,
        }
        return {
          content: [{ type: "text", text: synapseError.message }],
          isError: true,
          _meta: { synapse_error: synapseError },
        }
      }
    }
    const index = await buildToolIndex()
    // Route by the same composite (exposure_stable_key, tool_name) that the
    // local index is keyed under. When envelope verification is on we have
    // expectedTarget; otherwise (skeleton/test runs) fall back to a
    // single-exposure scan over params.name (unique within v3-skeleton
    // catalogs that ship one builtin per provider).
    let entry: ToolEntry | undefined
    if (opts.envelopeVerifier && verifiedEnvelope) {
      const expectedTarget = toolTargetIndex.get(
        verifiedEnvelope.runtime_tool_id
      )!
      entry = index.get(
        compositeToolKey(
          expectedTarget.exposureStableKey,
          expectedTarget.toolName
        )
      )
    } else {
      for (const candidate of index.values()) {
        if (candidate.tool.name === params.name) {
          entry = candidate
          break
        }
      }
    }
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
        envelope: verifiedEnvelope,
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

  function extractEnvelope(meta: unknown): ExtractEnvelopeResult {
    if (!meta || typeof meta !== "object") return { kind: "missing" }
    const raw = (meta as Record<string, unknown>)["synapse_operation"]
    if (!raw || typeof raw !== "object") return { kind: "missing" }
    const parsed = OperationEnvelopeSchema.safeParse(raw)
    if (!parsed.success) return { kind: "invalid" }
    return { kind: "ok", envelope: parsed.data }
  }

  async function handleJsonRpc(request: McpHostJsonRpcRequest): Promise<{
    id: string | number | null
    result?: unknown
    error?: { code: number; message: string }
  }> {
    const { id } = request
    switch (request.method) {
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
          request.params && typeof request.params === "object"
            ? (request.params as {
                name: unknown
                arguments?: unknown
                _meta?: unknown
              })
            : { name: undefined }
        // Run the dispatch (and its sidecar RPCs) inside the api-injected
        // traceparent so cua/fs-helper spans continue the same trace (P7).
        const result = await runWithTraceparent(
          traceparentFromMeta(params._meta),
          () => dispatchCallTool(params)
        )
        return { id, result }
      }
      default: {
        return {
          id,
          error: {
            code: -32601,
            message: `method not found: ${request.method}`,
          },
        }
      }
    }
  }

  // Constant-time inbound-bearer check (§3.4 layer 2). Returns true when no bearer
  // is required (loopback/indirect isolation — path unchanged, zero cost); otherwise
  // the request MUST present exactly `Authorization: Bearer <requiredInboundAuth>`.
  // Gates initialize / tools/list / tools/call alike, BEFORE body parse.
  function inboundAuthOk(authorization: string | undefined): boolean {
    const required = opts.requiredInboundAuth
    if (!required) return true
    if (!authorization) return false
    const m = /^Bearer (.+)$/.exec(authorization)
    if (!m) return false
    const presented = Buffer.from(m[1], "utf8")
    const expected = Buffer.from(required, "utf8")
    if (presented.length !== expected.length) return false
    return timingSafeEqual(presented, expected)
  }

  async function startServer(): Promise<void> {
    if (server) return
    const host = opts.host ?? "127.0.0.1"
    const port = opts.port ?? 0
    // Fail-closed bind (§3.4 review fix G): a non-loopback bind without a required
    // inbound bearer would serve unauthenticated initialize/tools/list off-box.
    // Refuse at startup, mirroring the frp readiness fail-hard — a misconfigured
    // template (e.g. 0.0.0.0 bind with an unset bearer env) can never come online.
    const LOOPBACK_BIND = new Set(["127.0.0.1", "::1", "localhost"])
    if (!LOOPBACK_BIND.has(host) && !opts.requiredInboundAuth) {
      throw new Error(
        `refusing to bind MCP host to non-loopback ${host} without requiredInboundAuth (§3.4): ` +
          `would serve unauthenticated tools off-box`
      )
    }
    server = createServer((req, res) => {
      if (req.method !== "POST" || req.url !== "/mcp") {
        res.statusCode = 404
        res.setHeader("content-type", "application/json")
        res.end(
          JSON.stringify({ error: { code: -32601, message: "not found" } })
        )
        return
      }
      if (!inboundAuthOk(req.headers.authorization)) {
        res.statusCode = 401
        res.setHeader("content-type", "application/json")
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: {
              code: -32001,
              message: "unauthorized: missing or invalid inbound bearer",
            },
          })
        )
        return
      }
      const chunks: Buffer[] = []
      req.on("data", (c: Buffer) => chunks.push(c))
      req.on("end", () => {
        ;(async () => {
          const parsed = parseMcpHostRequestBody(
            Buffer.concat(chunks).toString("utf8")
          )
          if (!parsed.ok) {
            res.statusCode = parsed.error.httpStatus
            res.setHeader("content-type", "application/json")
            res.end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: parsed.error.id,
                error: {
                  code: parsed.error.code,
                  message: parsed.error.message,
                },
              })
            )
            return
          }
          const envelope = await handleJsonRpc(parsed.request)
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
    await new Promise<void>((resolve) => server!.close(() => resolve()))
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
      for (const [exposureStableKey, exposure] of Object.entries(map)) {
        for (const [toolName, ids] of Object.entries(exposure.tools)) {
          // Keyed by runtime_tool_id (globally unique server UUID), not
          // toolName — two exposures with same-named tools must each
          // route correctly.
          toolTargetIndex.set(ids.runtime_tool_id, {
            exposureStableKey,
            toolName,
            runtimeExposureId: exposure.runtime_exposure_id,
            runtimeToolRevisionId: ids.runtime_tool_revision_id,
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
export function toolErrorResult(
  err: SynapseError
): CatalogToolInvocationResult {
  return {
    content: [{ type: "text" as const, text: err.message }],
    isError: true,
    _meta: { synapse_error: err },
  }
}
