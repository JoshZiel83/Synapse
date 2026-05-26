// chrome-devtools-mcp provider — Phase 5 core.
//
// Wraps the official `chrome-devtools-mcp` server as a lazy-spawned stdio
// sidecar (via mcp-stdio-sidecar.ts) and re-projects its tool surface into
// 8 narrow Synapse exposures so the active-device picker can grant the
// minimum needed slice. Every invokeTool runs through:
//   1. BROWSER_TOOL_MAP lookup
//   2. exposure-enabled check
//   3. sanitizeBrowserToolArgs (file path / script / preserved / reload / reqid)
//   4. effective target resolution
//   5. provider-wide mutex (selected-page state is shared across all tools)
//   6. target URL discovery
//   7. operation-aware authz via sharedBrowserPolicyAllows
//   8. forward to sidecar
//   9. post-call enforcement: navigate_page remediation + list_pages filter +
//      ID-based get_console_message / get_network_request gating
//
// Plan §Phase 5, clarifications #7/#8/#13/#14/#15/#21/#22/#23/#26/#27/#28/#30/#33/#34.

import { satisfies as semverSatisfies } from "semver"
import {
  browserPolicyAllows,
  resolveUrlScope,
  type BrowserPolicy,
} from "@synapse/shared/access/policies"
import {
  BROWSER_EXPOSURE_STABLE_KEYS,
  BROWSER_EXPOSURE_TOOLS,
  BROWSER_TOOL_MAP,
  resolveEffectiveTarget,
  type BrowserExposureKey,
  type BrowserOperation,
  type EffectiveTarget,
} from "@synapse/device-protocol/browser-tools"
import type {
  DeviceCatalogExposure,
  DeviceCatalogTool,
  OperationEnvelope,
  RuntimeAuthorizationGrantSpec,
} from "@synapse/device-protocol"
import type {
  CatalogProvider,
  CatalogToolInvocationResult,
  RuntimeLogger,
} from "../types.js"
import { toolErrorResult } from "../mcp-host.js"
import {
  startMcpStdioSidecar,
  type McpClient,
  type McpStdioSidecarHandle,
} from "../mcp-stdio-sidecar.js"
import {
  parseListPagesResult,
  parseNavigationResult,
  parseSelectedPageUrl,
  type ChromePageSummary,
} from "./chrome-devtools-mcp.parsers.js"
import staticSchemas from "./chrome-devtools-mcp.static-input-schemas.json" with { type: "json" }

export const PROVIDER_KEY = "builtin.browser.chrome-devtools-mcp"
export const PINNED_VERSION = "0.7.0"
const SUPPORTED_NODE_RANGE = "^20.19.0 || ^22.12.0 || >=23"

const PATH_BLACKLIST = [
  "filePath",
  "requestFilePath",
  "responseFilePath",
  "outputDirPath",
  "path",
  "logFile",
] as const

const MCP_ARG_ALLOWLIST = new Set(["--viewport"])

type AllowFlag = "script" | "network" | "performance"

export interface ChromeDevtoolsMcpBuiltinOptions {
  displayName?: string
  /** Override the pinned spawn command. Tests inject `mcpClientFactory` instead. */
  mcpCommand?: { command: string; args: string[] }
  /** Extra args appended to the sidecar command — filtered through MCP_ARG_ALLOWLIST. */
  mcpExtraArgs?: string[]
  headless?: boolean
  isolatedProfile?: boolean
  userDataDir?: string
  executablePath?: string
  channel?: "stable" | "beta" | "dev" | "canary"
  /** High-risk attach mode (existing Chrome with user cookies). */
  browserUrl?: string
  /** High-risk attach mode alternative — websocket endpoint. */
  wsEndpoint?: string
  /** High-risk: route traffic through proxy. */
  proxyServer?: string
  /** High-risk: skip TLS verification. */
  acceptInsecureCerts?: boolean
  allowScript?: boolean
  allowNetwork?: boolean
  allowPerformance?: boolean
  /** Inject a fake MCP client; bypasses sidecar startup. Used by unit tests. */
  mcpClientFactory?: () => Promise<McpClient>
  logger?: RuntimeLogger
}

interface InternalState {
  status: "starting" | "online" | "degraded" | "offline"
  disabledReason?: string
  client: McpClient | null
  sidecarHandle: McpStdioSidecarHandle | null
  startupError: string | null
  /** chain mutex: every invokeTool awaits this then replaces it */
  mutex: Promise<void>
}

interface ExposurePlan {
  key: BrowserExposureKey
  stableKey: string
  enabled: boolean
  disabledReason?: string
}

// ─────────────────────────── helpers ───────────────────────────────────────

function defaultLogger(): RuntimeLogger {
  return {
    info: (msg, data) =>
      console.log(`[chrome-devtools-mcp] ${msg}`, data ?? ""),
    warn: (msg, data) =>
      console.warn(`[chrome-devtools-mcp] ${msg}`, data ?? ""),
    error: (msg, data) =>
      console.error(`[chrome-devtools-mcp] ${msg}`, data ?? ""),
  }
}

function buildExposurePlans(
  opts: ChromeDevtoolsMcpBuiltinOptions,
  nodeUnsupportedReason: string | null
): ExposurePlan[] {
  const allowFlagOpen: Record<AllowFlag, boolean> = {
    script: opts.allowScript === true,
    network: opts.allowNetwork === true,
    performance: opts.allowPerformance === true,
  }
  const keys = Object.keys(BROWSER_EXPOSURE_STABLE_KEYS) as BrowserExposureKey[]
  return keys.map((key) => {
    const stableKey = BROWSER_EXPOSURE_STABLE_KEYS[key]
    // extensions / webmcp are MVP-deferred — always disabled regardless of opts.
    if (key === "extensions") {
      return {
        key,
        stableKey,
        enabled: false,
        disabledReason: "browser-scope grant model not implemented in v1",
      }
    }
    if (key === "webmcp") {
      return {
        key,
        stableKey,
        enabled: false,
        disabledReason: "requires Chrome 149+ with feature flags",
      }
    }
    if (nodeUnsupportedReason) {
      return {
        key,
        stableKey,
        enabled: false,
        disabledReason: nodeUnsupportedReason,
      }
    }
    // The remaining 6 exposures: navigation/read/input are enabled-by-default;
    // network/performance/script require their allow flag.
    const tools = BROWSER_EXPOSURE_TOOLS[key]
    if (tools.length === 0) {
      return { key, stableKey, enabled: false }
    }
    const firstDescriptor = BROWSER_TOOL_MAP[tools[0]]
    if (firstDescriptor.enabledByDefault) {
      return { key, stableKey, enabled: true }
    }
    const flag = firstDescriptor.allowFlag
    if (flag && allowFlagOpen[flag]) {
      return { key, stableKey, enabled: true }
    }
    return {
      key,
      stableKey,
      enabled: false,
      disabledReason: flag
        ? `flip --browser-allow-${flag} to enable`
        : "disabled in v1",
    }
  })
}

function staticInputSchema(toolName: string): Record<string, unknown> {
  const map =
    (staticSchemas as { schemas?: Record<string, unknown> }).schemas ?? {}
  const s = map[toolName]
  if (s && typeof s === "object") return s as Record<string, unknown>
  return { type: "object" }
}

function buildCatalogTool(toolName: string): DeviceCatalogTool {
  const descriptor = BROWSER_TOOL_MAP[toolName]
  return {
    stable_key: `browser/${toolName}`,
    name: toolName,
    description: descriptor
      ? `chrome-devtools-mcp ${toolName} (${descriptor.operation}, ${descriptor.action})`
      : `chrome-devtools-mcp ${toolName}`,
    input_schema: staticInputSchema(toolName),
  }
}

function nodeVersionDisabledReason(): string | null {
  if (semverSatisfies(process.versions.node, SUPPORTED_NODE_RANGE)) {
    return null
  }
  return `node ${process.versions.node} does not satisfy chrome-devtools-mcp engine ${SUPPORTED_NODE_RANGE}`
}

function defaultSidecarCommand(
  opts: ChromeDevtoolsMcpBuiltinOptions,
  logger: RuntimeLogger
): { command: string; args: string[] } {
  if (opts.mcpCommand) return opts.mcpCommand
  // Try local node_modules/.bin first; npx is the absolute fallback.
  try {
    const localBin = new URL(
      "../../../../node_modules/.bin/chrome-devtools-mcp",
      import.meta.url
    )
    // Existence check happens at spawn time; if it fails we'll surface it
    // via onUnexpectedExit. We can't import("node:fs").existsSync here
    // because describeExposures wants to stay sync-friendly.
    return { command: localBin.pathname, args: [] }
  } catch {
    logger.warn(
      "local chrome-devtools-mcp not resolvable — falling back to npx"
    )
  }
  return {
    command: "npx",
    args: ["-y", `chrome-devtools-mcp@${PINNED_VERSION}`],
  }
}

function buildSafetyArgs(opts: ChromeDevtoolsMcpBuiltinOptions): string[] {
  const args: string[] = [
    "--no-usage-statistics",
    "--no-performance-crux",
    "--redact-network-headers=true",
    "--experimentalStructuredContent",
    `--category-network=${opts.allowNetwork === true}`,
    `--category-performance=${opts.allowPerformance === true}`,
    "--category-emulation=false",
    "--categoryExtensions=false",
    "--categoryExperimentalWebmcp=false",
  ]
  if (opts.userDataDir) {
    args.push(`--user-data-dir=${opts.userDataDir}`)
  } else if (opts.isolatedProfile !== false) {
    args.push("--isolated")
  }
  if (typeof opts.headless === "boolean") {
    args.push(`--headless=${opts.headless}`)
  }
  if (opts.executablePath) args.push(`--executable-path=${opts.executablePath}`)
  if (opts.channel) args.push(`--channel=${opts.channel}`)
  if (opts.browserUrl) args.push(`--browser-url=${opts.browserUrl}`)
  if (opts.wsEndpoint) args.push(`--ws-endpoint=${opts.wsEndpoint}`)
  if (opts.proxyServer) args.push(`--proxy-server=${opts.proxyServer}`)
  if (opts.acceptInsecureCerts) args.push("--accept-insecure-certs")
  return args
}

function filterExtraArgs(args: string[], logger: RuntimeLogger): string[] {
  const safe: string[] = []
  for (const raw of args) {
    const flagName = raw.includes("=") ? raw.slice(0, raw.indexOf("=")) : raw
    if (MCP_ARG_ALLOWLIST.has(flagName)) {
      safe.push(raw)
    } else {
      logger.warn(`dropping --browser-mcp-arg not in allowlist: ${flagName}`)
    }
  }
  return safe
}

function browserGrants(
  envelope: OperationEnvelope | undefined
): RuntimeAuthorizationGrantSpec[] {
  const specs = envelope?.runtime_authorization?.grant_specs ?? []
  return specs.filter(
    (s) => s.capability === "browser" && s.browser
  ) as RuntimeAuthorizationGrantSpec[]
}

function grantToPolicy(
  spec: RuntimeAuthorizationGrantSpec
): BrowserPolicy | null {
  const b = spec.browser
  if (!b) return null
  return {
    action: b.action,
    scopeType: b.scope_type,
    origin: b.origin,
    host: b.host,
    registrableDomain: b.registrable_domain,
    operations: b.operations as BrowserPolicy["operations"],
  }
}

function isWebScheme(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === "http:" || u.protocol === "https:"
  } catch {
    return false
  }
}

// ─────────────────────────── factory ───────────────────────────────────────

export function createChromeDevtoolsMcpBuiltin(
  opts: ChromeDevtoolsMcpBuiltinOptions = {}
): CatalogProvider {
  const logger = opts.logger ?? defaultLogger()
  const nodeDisabledReason = nodeVersionDisabledReason()
  const exposurePlans = buildExposurePlans(opts, nodeDisabledReason)
  const enabledStableKeys = new Set(
    exposurePlans.filter((p) => p.enabled).map((p) => p.stableKey)
  )

  // High-risk mode warnings — once per process.
  if (opts.browserUrl || opts.wsEndpoint) {
    logger.warn(
      "ATTACH MODE ENABLED — sidecar will control existing Chrome with user cookies"
    )
  }
  if (opts.proxyServer) {
    logger.warn(
      `PROXY MODE ENABLED — all browser traffic routed through ${opts.proxyServer}`
    )
  }
  if (opts.acceptInsecureCerts) {
    logger.warn(
      "INSECURE CERT MODE ENABLED — TLS verification disabled in sidecar"
    )
  }
  if (
    opts.isolatedProfile === false ||
    (opts.userDataDir && opts.userDataDir.length > 0)
  ) {
    logger.warn(
      "PERSISTENT PROFILE — sidecar may access cookies/storage from previous sessions"
    )
  }

  const state: InternalState = {
    status: nodeDisabledReason ? "degraded" : "starting",
    disabledReason: nodeDisabledReason ?? undefined,
    client: null,
    sidecarHandle: null,
    startupError: null,
    mutex: Promise.resolve(),
  }

  // ── sidecar lifecycle ─────────────────────────────────────────────────────

  async function ensureSidecar(): Promise<McpClient | null> {
    if (state.client) return state.client
    if (state.startupError) return null
    if (nodeDisabledReason) {
      state.startupError = nodeDisabledReason
      return null
    }
    try {
      if (opts.mcpClientFactory) {
        state.client = await opts.mcpClientFactory()
      } else {
        const base = defaultSidecarCommand(opts, logger)
        const safety = buildSafetyArgs(opts)
        const extras = filterExtraArgs(opts.mcpExtraArgs ?? [], logger)
        // Safety flags appended LAST so they override anything in extras
        // (chrome-devtools-mcp resolves repeated flags last-wins).
        const args = [...base.args, ...extras, ...safety]
        const handle = await startMcpStdioSidecar({
          command: base.command,
          args,
          env: {
            ...process.env,
            CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: "1",
          },
          onUnexpectedExit: (reason) => {
            state.status = "degraded"
            state.startupError = `sidecar_exited: ${reason}`
            logger.error("chrome-devtools-mcp sidecar exited", { reason })
          },
        })
        state.client = handle.client
        state.sidecarHandle = handle
      }
      await runDriftCheck(state.client, logger)
      state.status = state.status === "degraded" ? "degraded" : "online"
      return state.client
    } catch (err) {
      state.startupError = (err as Error).message
      state.status = "degraded"
      logger.error("chrome-devtools-mcp sidecar startup failed", {
        error: state.startupError,
      })
      return null
    }
  }

  async function runDriftCheck(
    client: McpClient,
    log: RuntimeLogger
  ): Promise<void> {
    try {
      const result = await client.listTools()
      const advertised = new Set(result.tools.map((t) => t.name))
      const requiredTools = new Set<string>()
      for (const plan of exposurePlans) {
        if (!plan.enabled) continue
        for (const t of BROWSER_EXPOSURE_TOOLS[plan.key]) {
          requiredTools.add(t)
        }
      }
      const missing = [...requiredTools].filter((t) => !advertised.has(t))
      if (missing.length > 0) {
        state.status = "degraded"
        state.disabledReason = `sidecar missing tools: ${missing.join(",")}`
        log.warn("chrome-devtools-mcp drift: sidecar missing required tools", {
          missing,
        })
      }
    } catch (err) {
      state.status = "degraded"
      log.warn("chrome-devtools-mcp drift check failed", {
        error: (err as Error).message,
      })
    }
  }

  // ── per-call mutex ────────────────────────────────────────────────────────

  async function withMutex<T>(fn: () => Promise<T>): Promise<T> {
    const prev = state.mutex
    let release!: () => void
    state.mutex = new Promise<void>((resolve) => {
      release = resolve
    })
    try {
      await prev
      return await fn()
    } finally {
      release()
    }
  }

  // ── sanitize ──────────────────────────────────────────────────────────────

  function sanitize(
    toolName: string,
    args: Record<string, unknown>
  ):
    | { ok: true; args: Record<string, unknown> }
    | { ok: false; result: CatalogToolInvocationResult } {
    for (const key of PATH_BLACKLIST) {
      if (args[key] !== undefined) {
        return {
          ok: false,
          result: toolErrorResult({
            code: "permission_denied",
            message:
              "browser tools may not access local filesystem in v1 (field rejected: " +
              key +
              ")",
          }),
        }
      }
    }
    if (args["initScript"] !== undefined) {
      return {
        ok: false,
        result: toolErrorResult({
          code: "permission_denied",
          message: "script injection not allowed in v1 (initScript)",
        }),
      }
    }
    if (
      (toolName === "list_console_messages" &&
        args["includePreservedMessages"] === true) ||
      (toolName === "list_network_requests" &&
        args["includePreservedRequests"] === true)
    ) {
      return {
        ok: false,
        result: toolErrorResult({
          code: "permission_denied",
          message: "preserved cross-navigation data not allowed in v1",
        }),
      }
    }
    if (toolName === "performance_start_trace" && args["reload"] === true) {
      return {
        ok: false,
        result: toolErrorResult({
          code: "permission_denied",
          message:
            "performance_start_trace with reload=true requires page.navigate grant (not supported in v1)",
        }),
      }
    }
    if (toolName === "get_network_request" && args["reqid"] === undefined) {
      return {
        ok: false,
        result: toolErrorResult({
          code: "invalid_request",
          message: "reqid is required in v1",
        }),
      }
    }
    return { ok: true, args }
  }

  // ── authz ─────────────────────────────────────────────────────────────────

  function checkScope(
    grants: RuntimeAuthorizationGrantSpec[],
    descriptor: { action: "read" | "write"; operation: BrowserOperation },
    url: string
  ): { ok: true } | { ok: false; reason: string } {
    const scope = resolveUrlScope(url)
    if (!scope.origin) {
      return { ok: false, reason: `url is not parseable: ${url}` }
    }
    for (const spec of grants) {
      const policy = grantToPolicy(spec)
      if (!policy) continue
      if (
        browserPolicyAllows(
          {
            action: policy.action,
            scopeType: policy.scopeType!,
            origin: policy.origin,
            host: policy.host,
            registrableDomain: policy.registrableDomain,
            operations: policy.operations,
          },
          {
            needed: descriptor.action,
            origin: scope.origin,
            host: scope.host,
            registrableDomain: scope.registrableDomain,
            neededOperations: [descriptor.operation],
          }
        )
      ) {
        return { ok: true }
      }
    }
    return {
      ok: false,
      reason: `no grant covers ${descriptor.operation} at ${scope.origin}`,
    }
  }

  // ── target resolution (mutex-required for all but argument_url) ──────────

  async function resolveTargetUrl(
    target: EffectiveTarget,
    client: McpClient
  ): Promise<
    | { ok: true; url: string }
    | { ok: false; result: CatalogToolInvocationResult }
  > {
    switch (target.kind) {
      case "argument_url":
        return { ok: true, url: target.url }
      case "current_page": {
        const listResult = await client.callTool({ name: "list_pages" })
        const url = parseSelectedPageUrl(listResult)
        if (!url) {
          return {
            ok: false,
            result: toolErrorResult({
              code: "invalid_request",
              message: "no active page in browser",
            }),
          }
        }
        return { ok: true, url }
      }
      case "page_id": {
        const listResult = await client.callTool({ name: "list_pages" })
        const parsed = parseListPagesResult(listResult)
        const page = parsed.pages.find((p) => p.pageId === target.pageId)
        if (!page) {
          return {
            ok: false,
            result: toolErrorResult({
              code: "invalid_request",
              message: `pageId ${target.pageId} not found`,
            }),
          }
        }
        return { ok: true, url: page.url }
      }
      case "all_pages":
        // handled separately by listPagesFiltered; should not be called.
        return {
          ok: false,
          result: toolErrorResult({
            code: "invalid_request",
            message: "internal: resolveTargetUrl called with all_pages",
          }),
        }
    }
  }

  // ── invokeTool ────────────────────────────────────────────────────────────

  async function invoke(
    input: Parameters<NonNullable<CatalogProvider["invokeTool"]>>[0]
  ): Promise<CatalogToolInvocationResult> {
    const toolName = input.toolName
    const descriptor = BROWSER_TOOL_MAP[toolName]
    if (!descriptor) {
      return toolErrorResult({
        code: "invalid_request",
        message: `unknown browser tool: ${toolName}`,
      })
    }

    // exposure-enabled check
    const plan = exposurePlans.find((p) => p.key === descriptor.exposure)
    if (!plan || !plan.enabled) {
      const reason = plan?.disabledReason ?? "exposure disabled"
      return toolErrorResult({
        code: "runtime_constraint",
        message: `capability disabled: ${reason}`,
      })
    }

    // sanitize
    const sanitized = sanitize(toolName, input.args)
    if (!sanitized.ok) return sanitized.result

    // effective target
    const eff = resolveEffectiveTarget(descriptor, sanitized.args)
    if (!eff.ok) {
      return toolErrorResult({
        code:
          eff.code === "navigate_page_type_mismatch"
            ? "invalid_request"
            : "invalid_request",
        message: eff.detail,
      })
    }

    // ALL operations enter mutex — selected-page state is shared across tools.
    return withMutex(() =>
      doInvoke(toolName, descriptor, sanitized.args, eff.target, input.envelope)
    )
  }

  async function doInvoke(
    toolName: string,
    descriptor: (typeof BROWSER_TOOL_MAP)[string],
    args: Record<string, unknown>,
    effective: EffectiveTarget,
    envelope: OperationEnvelope | undefined
  ): Promise<CatalogToolInvocationResult> {
    const client = await ensureSidecar()
    if (!client) {
      return toolErrorResult({
        code: "runtime_constraint",
        message: `sidecar unavailable: ${state.startupError ?? "unknown"}`,
      })
    }
    const grants = browserGrants(envelope)

    // ── all_pages special-case ───────────────────────────────────────────────
    if (effective.kind === "all_pages") {
      const listResult = await client.callTool({
        name: toolName,
        arguments: args,
      })
      return filterListPagesByGrants(listResult, grants)
    }

    // ── argument_url scheme check ────────────────────────────────────────────
    if (effective.kind === "argument_url" && !isWebScheme(effective.url)) {
      return toolErrorResult({
        code: "invalid_request",
        message: `url scheme not allowed: ${effective.url}`,
      })
    }

    // ── resolve target URL (current_page / page_id) ─────────────────────────
    const targetResolution = await resolveTargetUrl(effective, client)
    if (!targetResolution.ok) return targetResolution.result
    const targetUrl = targetResolution.url

    if (!isWebScheme(targetUrl)) {
      return toolErrorResult({
        code: "permission_denied",
        message: `page scheme not allowed: ${targetUrl}`,
      })
    }

    // ── authz ────────────────────────────────────────────────────────────────
    const scopeCheck = checkScope(grants, descriptor, targetUrl)
    if (!scopeCheck.ok) {
      const scope = resolveUrlScope(targetUrl)
      return toolErrorResult({
        code: "permission_denied",
        message: scopeCheck.reason,
        details: {
          currentUrl: targetUrl,
          neededOperations: [descriptor.operation],
          scopeSource:
            effective.kind === "argument_url"
              ? "args"
              : effective.kind === "page_id"
                ? "runtime_page_id"
                : "runtime_active_page",
          origin: scope.origin,
          suggestion:
            "Add a grant for this origin via Settings → Runtime Authorizations",
        },
      })
    }

    // ── get_console_message / get_network_request: ID gating ────────────────
    if (toolName === "get_console_message") {
      const idCheck = await checkConsoleId(client, args)
      if (!idCheck.ok) return idCheck.result
    } else if (toolName === "get_network_request") {
      const idCheck = await checkNetworkId(client, args)
      if (!idCheck.ok) return idCheck.result
    }

    // ── forward to sidecar ───────────────────────────────────────────────────
    const result = await client.callTool({
      name: toolName,
      arguments: args,
    })

    // ── post-call enforcement: navigation remediation ───────────────────────
    if (toolName === "navigate_page" || toolName === "new_page") {
      const nav = parseNavigationResult(result)
      const resolvedUrl = nav.resolvedUrl
      if (resolvedUrl) {
        if (!isWebScheme(resolvedUrl)) {
          await remediateUnauthorizedNav(
            client,
            toolName,
            nav.pageId,
            "non-http(s) resolved URL"
          )
          return toolErrorResult({
            code: "permission_denied",
            message: `navigated to non-http(s) scheme: ${resolvedUrl}`,
            details: { resolvedUrl, remediated: true },
          })
        }
        const postCheck = checkScope(grants, descriptor, resolvedUrl)
        if (!postCheck.ok) {
          await remediateUnauthorizedNav(
            client,
            toolName,
            nav.pageId,
            postCheck.reason
          )
          return toolErrorResult({
            code: "permission_denied",
            message: `navigation resolved outside authorized scope: ${postCheck.reason}`,
            details: { resolvedUrl, remediated: true },
          })
        }
      }
    }

    return {
      content: (result.content ?? []) as CatalogToolInvocationResult["content"],
      isError: result.isError,
      _meta: result._meta,
    }
  }

  // ── remediation ──────────────────────────────────────────────────────────

  async function remediateUnauthorizedNav(
    client: McpClient,
    toolName: string,
    pageId: number | undefined,
    reason: string
  ): Promise<void> {
    try {
      if (toolName === "new_page" && typeof pageId === "number") {
        try {
          await client.callTool({
            name: "close_page",
            arguments: { pageId },
          })
        } catch {
          // close_page fails on the last page; fall through to about:blank.
          await client.callTool({
            name: "navigate_page",
            arguments: { type: "url", url: "about:blank" },
          })
        }
      } else {
        await client.callTool({
          name: "navigate_page",
          arguments: { type: "url", url: "about:blank" },
        })
      }
    } catch (err) {
      logger.warn("remediation failed", {
        toolName,
        pageId,
        reason,
        error: (err as Error).message,
      })
    }
  }

  // ── all_pages filter ─────────────────────────────────────────────────────

  function filterListPagesByGrants(
    result: unknown,
    grants: RuntimeAuthorizationGrantSpec[]
  ): CatalogToolInvocationResult {
    const parsed = parseListPagesResult(
      result as Parameters<typeof parseListPagesResult>[0]
    )
    const allowed: ChromePageSummary[] = []
    for (const page of parsed.pages) {
      if (!isWebScheme(page.url)) continue // silently filter non-web pages
      const scope = checkScope(
        grants,
        { action: "read", operation: "page.read" },
        page.url
      )
      if (scope.ok) allowed.push(page)
    }
    return {
      content: [
        {
          type: "text",
          text:
            allowed.length === 0
              ? "no authorized pages"
              : allowed
                  .map(
                    (p) =>
                      `${p.pageId}: ${p.isActive ? "<selected> " : ""}${p.url}${p.title ? " — " + p.title : ""}`
                  )
                  .join("\n"),
        },
      ],
      _meta: {
        synapse_list_pages: { pages: allowed },
      },
    }
  }

  // ── ID gating for get_console_message / get_network_request ─────────────

  async function checkConsoleId(
    client: McpClient,
    args: Record<string, unknown>
  ): Promise<
    { ok: true } | { ok: false; result: CatalogToolInvocationResult }
  > {
    const targetId = args["msgid"]
    if (targetId === undefined) {
      return {
        ok: false,
        result: toolErrorResult({
          code: "invalid_request",
          message: "msgid is required",
        }),
      }
    }
    const list = await client.callTool({
      name: "list_console_messages",
      arguments: { includePreservedMessages: false },
    })
    const ids = extractIdsFromList(list, ["msgid", "id"])
    if (!ids.has(String(targetId))) {
      return {
        ok: false,
        result: toolErrorResult({
          code: "permission_denied",
          message: "message not associated with currently authorized page",
        }),
      }
    }
    return { ok: true }
  }

  async function checkNetworkId(
    client: McpClient,
    args: Record<string, unknown>
  ): Promise<
    { ok: true } | { ok: false; result: CatalogToolInvocationResult }
  > {
    const targetId = args["reqid"]
    if (targetId === undefined) {
      return {
        ok: false,
        result: toolErrorResult({
          code: "invalid_request",
          message: "reqid is required",
        }),
      }
    }
    const list = await client.callTool({
      name: "list_network_requests",
      arguments: { includePreservedRequests: false },
    })
    const ids = extractIdsFromList(list, ["reqid", "id"])
    if (!ids.has(String(targetId))) {
      return {
        ok: false,
        result: toolErrorResult({
          code: "permission_denied",
          message: "request not associated with currently authorized page",
        }),
      }
    }
    return { ok: true }
  }

  function extractIdsFromList(
    result: Awaited<ReturnType<McpClient["callTool"]>>,
    idKeys: string[]
  ): Set<string> {
    const ids = new Set<string>()
    const structured = result.structuredContent
    const list = Array.isArray(structured)
      ? structured
      : Array.isArray((structured as { items?: unknown } | undefined)?.items)
        ? (structured as { items: unknown[] }).items
        : []
    for (const item of list) {
      if (item && typeof item === "object") {
        for (const k of idKeys) {
          const v = (item as Record<string, unknown>)[k]
          if (v !== undefined) ids.add(String(v))
        }
      }
    }
    return ids
  }

  // ── CatalogProvider surface ──────────────────────────────────────────────

  return {
    providerKey: PROVIDER_KEY,
    async describeExposures(): Promise<DeviceCatalogExposure[]> {
      return exposurePlans.map((plan) => {
        const tools = BROWSER_EXPOSURE_TOOLS[plan.key]
        const metadata: Record<string, unknown> = {
          enabled: plan.enabled,
          schemaVersion: PINNED_VERSION,
        }
        if (plan.disabledReason) {
          metadata.disabledReason = plan.disabledReason
        }
        return {
          stable_key: plan.stableKey,
          display_name: `Browser — ${plan.key}`,
          transport: "builtin",
          builtin_kind: "browser",
          metadata,
          tools: tools.map(buildCatalogTool),
        }
      })
    },
    async invokeTool(input) {
      // Reject any tool we don't advertise in the catalog upfront so the
      // device-side composite key resolver (which dispatches by tool name +
      // stable_key) doesn't end up here for tools belonging to disabled
      // exposures.
      if (!enabledStableKeys.size && !nodeDisabledReason) {
        // No enabled exposure → everything is runtime_constraint.
        return toolErrorResult({
          code: "runtime_constraint",
          message: "no chrome-devtools-mcp exposures are enabled",
        })
      }
      return invoke(input)
    },
    async dispose() {
      if (state.sidecarHandle) {
        try {
          await state.client?.close()
        } catch {
          /* best-effort */
        }
        await state.sidecarHandle.exited
        state.sidecarHandle = null
      }
      state.client = null
    },
  }
}
