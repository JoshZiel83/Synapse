import { nowIsoInstant } from "@synapse/shared/datetime"
// Device Control Plane WSS handler (§7.1).
//
// Authentication flow:
//   1. WS connect → server sends `server.challenge` notification with a fresh
//      32-byte hex nonce.
//   2. Device responds with `device.hello` whose `signed_challenge` is the
//      base64-Ed25519 signature of the nonce, signed by its service private
//      key (loaded from the broker).
//   3. Server verifies the signature against the runtime_service_keys row
//      matching the claimed (device_id, service_id) pair. On success, a
//      runtime_control_plane_sessions row is INSERTed with status='active'
//      and runtime_services.current_session_id is bumped.
//   4. Server returns the envelope-signing pubkey + kid in the hello ack so
//      the runtime can populate its trusted_server_keys map without out-of-
//      band config.
//   5. Catalog sync + runtime sessions + tunnel registration are gated behind
//      requireAuthenticated.
//   6. On `device.tunnel.up`, the server registers the device's internalUrl
//      with DeviceTunnelRegistry so dispatchSyncTool can route to it. On
//      `device.tunnel.down` (or socket close), the registry entry is removed.

import { randomBytes, randomUUID } from "node:crypto"
import type { FastifyInstance, FastifyRequest } from "fastify"
import type { WebSocket } from "ws"
import { formatValidationDetails } from "../../infrastructure/validation-error.js"
import { wireRoute } from "../../infrastructure/http/route.js"
import {
  DeviceCatalogSyncParamsSchema,
  DeviceHelloParamsSchema,
  DeviceTunnelDownParamsSchema,
  DeviceTunnelUpParamsSchema,
  parseJsonRpcRequestFrame,
  type JsonRpcRequest,
} from "@synapse/device-protocol"
import type { KyselyDb } from "../../infrastructure/database/kysely.js"
import { persistCatalogSync } from "./catalog-sync.js"
import { authenticateDeviceHello } from "./control-plane-auth.js"
import { mintDeviceLogToken } from "../logs/device-token.js"
import { getEnvelopeServerPublicKey } from "./envelope-signer.js"
import { getDeviceTunnelRegistry } from "./tunnel-registry.js"
import {
  insertControlPlaneSession as insertControlPlaneSessionRow,
  issueTunnelPathToken,
  selectControlPlaneSessionDeviceId,
  closeControlPlaneSessionRows,
  getDeviceWorkspaceId,
  selectTunnelPathToken,
  updateRuntimeServiceTransport,
  hasLiveLocalSandboxMount,
} from "./repo.js"
import {
  persistDeviceEventEmit,
  persistRuntimeSessionClosed,
  persistRuntimeSessionOpened,
  persistTaskOutput,
  persistTaskReceived,
  persistTaskResult,
  persistTaskStarted,
  persistTaskStatus,
  persistVfsExposureUpsert,
  failInFlightDeviceTasksForDevice,
  type PersistResult,
} from "./control-plane-events.js"

function writeResult(
  socket: WebSocket,
  id: string | number | null | undefined,
  result: unknown
) {
  if (id === undefined || id === null) return // notification, no response
  socket.send(JSON.stringify({ jsonrpc: "2.0", id, result }))
}

function writeError(
  socket: WebSocket,
  id: string | number | null | undefined,
  code: number,
  message: string,
  data?: unknown
) {
  if (id === undefined || id === null) return
  socket.send(
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      error: { code, message, data },
    })
  )
}

function writeNotification(socket: WebSocket, method: string, params: unknown) {
  socket.send(JSON.stringify({ jsonrpc: "2.0", method, params }))
}

function writePersistResult(
  socket: WebSocket,
  id: string | number | null | undefined,
  result: PersistResult
) {
  if (result.ok) {
    writeResult(socket, id, { accepted: true, ...(result.payload ?? {}) })
  } else {
    writeError(socket, id, result.code, result.message)
  }
}

/**
 * Validate a device-supplied tunnel internal_url. Two enforcement layers:
 *
 *   1. SSRF gate — operator pins the trusted tunnel edge via
 *      SYNAPSE_DEVICE_TUNNEL_EDGE_URL (e.g. "http://tunnel-edge:7000").
 *      Without that env var we refuse to register any URL (fail closed),
 *      otherwise a compromised device could point the dispatcher at
 *      arbitrary internal addresses (cloud metadata, admin endpoints).
 *
 *   2. Token binding — the URL path must contain "/d/<token>" where
 *      <token> matches the per-service path token issued by the server at
 *      device.hello time and persisted on runtime_services.tunnel_path_token.
 *      Without this check, a compromised device could squat on another
 *      device's tunnel route by registering an internal_url that includes
 *      a peer's well-known path segment.
 */
/**
 * Validate a device-supplied tunnel internal_url before registering it in the
 * DeviceTunnelRegistry. Exported for unit tests; the control-plane handler is
 * the only production caller. Two accept paths:
 *  - frp edge: origin matches SYNAPSE_DEVICE_TUNNEL_EDGE_URL + /d/<token> bound
 *    to this service (production cloud/docker).
 *  - local loopback: strict literal 127.0.0.1/[::1] http URL, no path/creds,
 *    accepted ONLY for a device with a live local sandbox mount.
 */
export async function validateTunnelInternalUrl(args: {
  candidate: string
  runtimeServiceId: string
  /** Executor seam (the repo defaults to the global db); tests inject a
   *  testcontainer db, threaded down to the repo reads. */
  executor?: KyselyDb
}): Promise<
  { ok: true; reach: "direct" | "indirect" } | { ok: false; message: string }
> {
  const executor = args.executor
  let candidateUrl: URL
  try {
    candidateUrl = new URL(args.candidate)
  } catch {
    return { ok: false, message: "internal_url must be a valid http(s) URL" }
  }

  // A URL carrying credentials (user:pass@host) is never accepted — it can
  // smuggle auth into the dispatcher's fetch and muddies origin checks.
  if (candidateUrl.username || candidateUrl.password) {
    return {
      ok: false,
      message: "internal_url must not contain credentials",
    }
  }

  const trustedPrefix = process.env.SYNAPSE_DEVICE_TUNNEL_EDGE_URL?.trim()
  // The frp edge path: candidate must sit under the trusted edge origin and
  // carry a /d/<token> route bound to THIS service. This is the production
  // cloud/docker path.
  if (trustedPrefix) {
    let trustedUrl: URL | null = null
    try {
      trustedUrl = new URL(trustedPrefix)
    } catch {
      trustedUrl = null
    }
    if (trustedUrl && candidateUrl.origin === trustedUrl.origin) {
      const r = await validateFrpEdgeUrl({
        candidateUrl,
        runtimeServiceId: args.runtimeServiceId,
        executor,
      })
      // frp reverse tunnel = the runtime dials back; the API dials the edge.
      return r.ok ? { ok: true, reach: "indirect" } : r
    }
  }

  // The local-sandbox loopback path: a same-host device-runtime started by the
  // LOCAL sandbox backend exposes its MCP host directly on loopback (no frpc).
  // Accept it ONLY when the candidate is a strict literal-loopback http URL AND
  // this service belongs to a device with a LIVE local sandbox mount — so a
  // compromised cloud/remote device can never point the dispatcher at the API
  // host's own loopback (SSRF) by claiming a loopback endpoint.
  const r = await validateLocalLoopbackUrl({
    candidateUrl,
    runtimeServiceId: args.runtimeServiceId,
    hadTrustedPrefix: Boolean(trustedPrefix),
    executor,
  })
  // co-located loopback = the API dials the runtime directly (degenerate direct).
  return r.ok ? { ok: true, reach: "direct" } : r
}

/** frp edge: origin already matched the trusted edge; require /d/<token> bound
 *  to this service (the server issues the token in the device.hello ack). */
async function validateFrpEdgeUrl(args: {
  candidateUrl: URL
  runtimeServiceId: string
  executor: KyselyDb | undefined
}): Promise<{ ok: true } | { ok: false; message: string }> {
  const tokenMatch = /\/d\/([^/]+)/.exec(args.candidateUrl.pathname)
  if (!tokenMatch) {
    return {
      ok: false,
      message: "internal_url must include a /d/<token> path segment",
    }
  }
  const presentedToken = tokenMatch[1]!
  // The server issues tunnel_path_token in the device.hello ack and persists
  // it on the runtime_services row. Any mismatch means either the device is
  // out of sync (re-registered without re-reading the ack) or is attempting
  // to claim a peer's route — either way we reject.
  const expectedToken = await selectTunnelPathToken(
    args.runtimeServiceId,
    args.executor
  )
  if (!expectedToken) {
    return {
      ok: false,
      message:
        "runtime_services row has no tunnel_path_token; reconnect to receive a fresh token via device.hello",
    }
  }
  if (presentedToken !== expectedToken) {
    return {
      ok: false,
      message:
        "internal_url tunnel path token does not match the token bound to this device_service",
    }
  }
  return { ok: true }
}

/** Hostnames we accept as direct loopback for the local sandbox backend.
 *  Strict literals only — NOT "localhost" (which can resolve to a non-loopback
 *  address via /etc/hosts) and NOT any private/metadata IP. */
const LOCAL_LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "::1"])

/** Local-sandbox loopback: accept http://127.0.0.1:<port> (or [::1]) only when
 *  the service maps to a device with a LIVE local sandbox mount. */
async function validateLocalLoopbackUrl(args: {
  candidateUrl: URL
  runtimeServiceId: string
  hadTrustedPrefix: boolean
  executor: KyselyDb | undefined
}): Promise<{ ok: true } | { ok: false; message: string }> {
  const { candidateUrl } = args
  if (candidateUrl.protocol !== "http:") {
    return {
      ok: false,
      message:
        "local sandbox loopback internal_url must use http (got " +
        `${candidateUrl.protocol})`,
    }
  }
  // URL.hostname strips brackets from IPv6; rebuild the bracketed form so the
  // literal set matches what a URL like http://[::1]:port yields.
  const host = candidateUrl.hostname
  const isLoopback =
    LOCAL_LOOPBACK_HOSTS.has(host) || LOCAL_LOOPBACK_HOSTS.has(`[${host}]`)
  if (!isLoopback) {
    return {
      ok: false,
      message: args.hadTrustedPrefix
        ? `internal_url origin ${candidateUrl.origin} is neither the trusted tunnel edge nor a local-sandbox loopback`
        : "SYNAPSE_DEVICE_TUNNEL_EDGE_URL not configured and internal_url is not a local-sandbox loopback — refusing to register",
    }
  }
  // The loopback path must be empty/root — a loopback URL carries no /d/<token>
  // route and shouldn't smuggle a path either.
  if (candidateUrl.pathname && candidateUrl.pathname !== "/") {
    return {
      ok: false,
      message: "local sandbox loopback internal_url must not carry a path",
    }
  }
  // Bind the loopback grant to a LIVE local sandbox: the service's runtime must be a
  // resident local sandbox (a sandboxes row adapter='local', mode='resident', state
  // NOT closed/failed) — resolved from the sandboxes row, not any file_mount (P3).
  const liveLocalMount = await hasLiveLocalSandboxMount(
    args.runtimeServiceId,
    args.executor
  )
  if (!liveLocalMount) {
    return {
      ok: false,
      message:
        "loopback internal_url is only accepted for a device with a live local sandbox mount",
    }
  }
  return { ok: true }
}

interface ConnectionState {
  challengeNonce: string
  helloSeen: boolean
  authenticatedDeviceId: string | null
  authenticatedServiceId: string | null
  authenticatedWorkspaceId: string | null
  sessionId: string | null
  registeredTunnelServiceId: string | null
}

function jsonRpcCodeForAuthFailure(code: string): number {
  switch (code) {
    case "device_not_found":
    case "service_not_found":
      return -32004
    case "service_key_missing":
    case "service_revoked":
      return -32005
    case "signature_invalid":
    case "unsupported_key":
      return -32003
    default:
      return -32603
  }
}

async function insertControlPlaneSession(args: {
  deviceId: string
  serviceId: string
  clientVersion: string | null
  remoteAddr: string | null
}): Promise<string> {
  const sessionId = randomUUID()
  await insertControlPlaneSessionRow({
    sessionId,
    deviceId: args.deviceId,
    serviceId: args.serviceId,
    clientVersion: args.clientVersion,
    remoteAddr: args.remoteAddr,
  })
  return sessionId
}

/**
 * Lookup-or-issue the per-service tunnel path token. The token is committed
 * before we hand it to the device in the hello ack so a concurrent
 * device.tunnel.up sees the same value. Concurrency-safe via a single
 * UPDATE ... WHERE tunnel_path_token IS NULL; if a peer beat us to it we
 * read whatever is already persisted.
 */
async function ensureTunnelPathToken(serviceId: string): Promise<string> {
  const fresh = randomBytes(32).toString("hex")
  const token = await issueTunnelPathToken(serviceId, fresh)
  if (!token) {
    throw new Error(
      `runtime_services ${serviceId} disappeared while issuing tunnel_path_token`
    )
  }
  return token
}

async function closeControlPlaneSession(
  sessionId: string,
  reason: string
): Promise<void> {
  try {
    const deviceId = await selectControlPlaneSessionDeviceId(sessionId)
    await closeControlPlaneSessionRows(sessionId, reason)
    // Task unification (design §3.6): fail in-flight device_tool tasks so the
    // waiting agent is woken instead of hanging when the device drops.
    if (deviceId) {
      await failInFlightDeviceTasksForDevice(deviceId).catch(() => undefined)
    }
  } catch {
    /* best effort; DB unavailability shouldn't block socket teardown */
  }
}

export function registerDeviceControlPlaneRoutes(app: FastifyInstance): void {
  // WIRE — device control-plane WebSocket (JSON-RPC 2.0 handshake). The
  // handler owns the socket and sends bare frames; never a { data } envelope.
  wireRoute(
    app,
    "GET",
    "/api/v1/devices/control-plane",
    { options: { websocket: true } },
    // fastify-websocket invokes this with (socket, request) when
    // websocket:true; the wireRoute handler type is (request, reply) so the
    // socket-first arity is bridged via the register() cast.
    ((socket: WebSocket, request: FastifyRequest) => {
      const state: ConnectionState = {
        challengeNonce: randomBytes(32).toString("hex"),
        helloSeen: false,
        authenticatedDeviceId: null,
        authenticatedServiceId: null,
        authenticatedWorkspaceId: null,
        sessionId: null,
        registeredTunnelServiceId: null,
      }

      writeNotification(socket, "server.challenge", {
        nonce: state.challengeNonce,
      })

      const requireAuthenticated = (req: JsonRpcRequest): boolean => {
        if (state.authenticatedDeviceId && state.authenticatedServiceId) {
          return true
        }
        writeError(
          socket,
          req.id ?? null,
          -32003,
          "device.hello must succeed before any other method"
        )
        return false
      }

      socket.on("message", (raw) => {
        const frame = parseJsonRpcRequestFrame(String(raw))
        if (!frame.ok) {
          if (frame.error === "parse_error") {
            writeError(socket, null, -32700, "Parse error")
            return
          }
          writeError(socket, null, -32600, "Invalid request")
          return
        }
        const req = frame.request
        switch (req.method) {
          case "device.hello": {
            if (state.helloSeen) {
              writeError(
                socket,
                req.id ?? null,
                -32001,
                "device.hello already received on this connection"
              )
              return
            }
            const parsed = DeviceHelloParamsSchema.safeParse(req.params)
            if (!parsed.success) {
              writeError(
                socket,
                req.id ?? null,
                -32602,
                "Invalid device.hello params",
                formatValidationDetails(parsed.error)
              )
              return
            }
            state.helloSeen = true
            authenticateDeviceHello({
              deviceId: parsed.data.device_id,
              serviceId: parsed.data.service_id,
              signedChallenge: parsed.data.signed_challenge,
              challengeNonce: state.challengeNonce,
            })
              .then(async (result) => {
                if (!result.ok) {
                  writeError(
                    socket,
                    req.id ?? null,
                    jsonRpcCodeForAuthFailure(result.code),
                    result.message,
                    { code: result.code }
                  )
                  try {
                    socket.close(4003, result.code)
                  } catch {
                    /* ignore */
                  }
                  return
                }
                state.authenticatedDeviceId = result.deviceId
                state.authenticatedServiceId = result.serviceId
                // Cache the device's workspace_id so per-message event
                // persistence (runtime_events) doesn't have to re-query it.
                try {
                  state.authenticatedWorkspaceId = await getDeviceWorkspaceId(
                    result.deviceId
                  )
                } catch {
                  /* workspace lookup is best-effort; event.emit will
                   * surface a structured error if it tries to write without
                   * it. */
                }
                // Persist the CP session so runtime-authorization requests
                // can find an active session and not reject themselves.
                try {
                  state.sessionId = await insertControlPlaneSession({
                    deviceId: result.deviceId,
                    serviceId: result.serviceId,
                    clientVersion: parsed.data.client_version ?? null,
                    remoteAddr: request.ip ?? null,
                  })
                } catch (err) {
                  writeError(
                    socket,
                    req.id ?? null,
                    -32603,
                    `session insert failed: ${(err as Error).message}`
                  )
                  try {
                    socket.close(1011, "session insert failed")
                  } catch {
                    /* ignore */
                  }
                  return
                }
                // Hand the device our envelope-signing pubkey + kid so it
                // can populate trusted_server_keys without out-of-band
                // config. If the env var isn't set, ship null so the
                // operator notices on the dashboard.
                let serverEnvelopeKey: {
                  signatureKid: string
                  publicKeyPem: string
                } | null = null
                try {
                  serverEnvelopeKey = getEnvelopeServerPublicKey()
                } catch {
                  serverEnvelopeKey = null
                }
                // Issue (or read) the per-service tunnel path token so the
                // device can plug it into its frp endpoint URL. Without
                // this, device.tunnel.up would either skip the binding
                // check or look up a NULL token — both unsafe.
                let tunnelPathToken: string | null = null
                try {
                  tunnelPathToken = await ensureTunnelPathToken(
                    result.serviceId
                  )
                } catch {
                  /* swallow — operator will see device.tunnel.up rejection
                   * with the structured "no tunnel_path_token" message */
                }
                writeResult(socket, req.id ?? null, {
                  accepted: true,
                  server_time: nowIsoInstant(),
                  service_key_id: result.serviceKeyId,
                  pubkey_fingerprint: result.pubkeyFingerprint,
                  control_plane_session_id: state.sessionId,
                  envelope_signing: serverEnvelopeKey
                    ? {
                        kid: serverEnvelopeKey.signatureKid,
                        public_key_pem: serverEnvelopeKey.publicKeyPem,
                      }
                    : null,
                  tunnel: tunnelPathToken
                    ? { path_token: tunnelPathToken }
                    : null,
                  // Short-lived bearer token for the device to ship logs to
                  // POST /api/v1/logs. Null (omitted use) when log ingest is not
                  // configured (SYNAPSE_LOG_INGEST_SECRET unset).
                  log_ingest_token: mintDeviceLogToken(
                    result.deviceId,
                    result.serviceId,
                    Date.now()
                  ),
                })
              })
              .catch((err) => {
                writeError(
                  socket,
                  req.id ?? null,
                  -32603,
                  `auth lookup failed: ${(err as Error).message}`
                )
              })
            return
          }
          case "device.catalog.sync": {
            if (!requireAuthenticated(req)) return
            const parsedCatalog = DeviceCatalogSyncParamsSchema.safeParse(
              req.params
            )
            if (!parsedCatalog.success) {
              writeError(
                socket,
                req.id ?? null,
                -32602,
                "Invalid device.catalog.sync params",
                formatValidationDetails(parsedCatalog.error)
              )
              return
            }
            persistCatalogSync({
              deviceId: state.authenticatedDeviceId!,
              serviceId: state.authenticatedServiceId!,
              exposures: parsedCatalog.data.exposures,
            })
              .then((result) => {
                writeResult(socket, req.id ?? null, {
                  accepted: true,
                  ...result,
                })
              })
              .catch((err) => {
                writeError(
                  socket,
                  req.id ?? null,
                  -32603,
                  `catalog persist failed: ${(err as Error).message}`
                )
              })
            return
          }
          case "device.tunnel.up": {
            if (!requireAuthenticated(req)) return
            const parsedTunnel = DeviceTunnelUpParamsSchema.safeParse(
              req.params
            )
            if (!parsedTunnel.success) {
              writeError(
                socket,
                req.id ?? null,
                -32602,
                "Invalid device.tunnel.up params",
                formatValidationDetails(parsedTunnel.error)
              )
              return
            }
            // SSRF + token-binding gates: an authenticated device must not
            // be able to point the dispatcher at arbitrary URLs and must
            // present the server-issued tunnel_path_token for its own
            // service so peer devices can't squat on its route.
            validateTunnelInternalUrl({
              candidate: parsedTunnel.data.internal_url,
              runtimeServiceId: state.authenticatedServiceId!,
            })
              .then(async (validation) => {
                if (!validation.ok) {
                  writeError(
                    socket,
                    req.id ?? null,
                    -32005,
                    `device.tunnel.up rejected: ${validation.message}`
                  )
                  return
                }
                // Stamp the registering CP session so a stale socket's later close
                // cannot evict this entry (compare-and-delete, §3.3).
                getDeviceTunnelRegistry().register({
                  runtimeServiceId: state.authenticatedServiceId!,
                  internalUrl: parsedTunnel.data.internal_url,
                  sessionId: state.sessionId ?? undefined,
                })
                state.registeredTunnelServiceId = state.authenticatedServiceId
                // Record the reachability the validator actually accepted so the
                // transport column is truthful (frp → indirect, loopback → direct).
                await updateRuntimeServiceTransport(
                  state.authenticatedServiceId!,
                  validation.reach
                ).catch(() => {})
                writeResult(socket, req.id ?? null, { registered: true })
              })
              .catch((err) =>
                writeError(
                  socket,
                  req.id ?? null,
                  -32603,
                  `tunnel validation failed: ${(err as Error).message}`
                )
              )
            return
          }
          case "device.tunnel.down": {
            if (!requireAuthenticated(req)) return
            const parsedTunnel = DeviceTunnelDownParamsSchema.safeParse(
              req.params ?? {}
            )
            if (!parsedTunnel.success) {
              writeError(
                socket,
                req.id ?? null,
                -32602,
                "Invalid device.tunnel.down params",
                formatValidationDetails(parsedTunnel.error)
              )
              return
            }
            if (state.registeredTunnelServiceId) {
              // compare-and-delete: only THIS session may retire its own entry.
              getDeviceTunnelRegistry().unregister(
                state.registeredTunnelServiceId,
                state.sessionId ?? undefined
              )
              state.registeredTunnelServiceId = null
            }
            writeResult(socket, req.id ?? null, { unregistered: true })
            return
          }
          case "device.catalog.delta":
          case "device.service.status": {
            if (!requireAuthenticated(req)) return
            // v3.0 skeleton: ack only (catalog delta + service status
            // streaming aren't yet wired into the projection invalidation
            // hooks). Scoped for a follow-up.
            writeResult(socket, req.id ?? null, {
              accepted: true,
              method: req.method,
              device_id: state.authenticatedDeviceId,
              service_id: state.authenticatedServiceId,
            })
            return
          }
          case "device.runtime_session.opened": {
            if (!requireAuthenticated(req)) return
            persistRuntimeSessionOpened(
              state.authenticatedDeviceId!,
              state.authenticatedServiceId!,
              req.params
            )
              .then((r) => writePersistResult(socket, req.id ?? null, r))
              .catch((err) =>
                writeError(
                  socket,
                  req.id ?? null,
                  -32603,
                  (err as Error).message
                )
              )
            return
          }
          case "device.runtime_session.closed": {
            if (!requireAuthenticated(req)) return
            persistRuntimeSessionClosed(
              state.authenticatedDeviceId!,
              state.authenticatedServiceId!,
              req.params
            )
              .then((r) => writePersistResult(socket, req.id ?? null, r))
              .catch((err) =>
                writeError(
                  socket,
                  req.id ?? null,
                  -32603,
                  (err as Error).message
                )
              )
            return
          }
          case "device.task.received": {
            if (!requireAuthenticated(req)) return
            persistTaskReceived(
              state.authenticatedDeviceId!,
              state.authenticatedServiceId!,
              req.params
            )
              .then((r) => writePersistResult(socket, req.id ?? null, r))
              .catch((err) =>
                writeError(
                  socket,
                  req.id ?? null,
                  -32603,
                  (err as Error).message
                )
              )
            return
          }
          case "device.task.started": {
            if (!requireAuthenticated(req)) return
            persistTaskStarted(
              state.authenticatedDeviceId!,
              state.authenticatedServiceId!,
              req.params
            )
              .then((r) => writePersistResult(socket, req.id ?? null, r))
              .catch((err) =>
                writeError(
                  socket,
                  req.id ?? null,
                  -32603,
                  (err as Error).message
                )
              )
            return
          }
          case "device.task.output": {
            if (!requireAuthenticated(req)) return
            persistTaskOutput(
              state.authenticatedDeviceId!,
              state.authenticatedServiceId!,
              req.params
            )
              .then((r) => writePersistResult(socket, req.id ?? null, r))
              .catch((err) =>
                writeError(
                  socket,
                  req.id ?? null,
                  -32603,
                  (err as Error).message
                )
              )
            return
          }
          case "device.task.status": {
            if (!requireAuthenticated(req)) return
            persistTaskStatus(
              state.authenticatedDeviceId!,
              state.authenticatedServiceId!,
              req.params
            )
              .then((r) => writePersistResult(socket, req.id ?? null, r))
              .catch((err) =>
                writeError(
                  socket,
                  req.id ?? null,
                  -32603,
                  (err as Error).message
                )
              )
            return
          }
          case "device.task.result": {
            if (!requireAuthenticated(req)) return
            persistTaskResult(
              state.authenticatedDeviceId!,
              state.authenticatedServiceId!,
              req.params
            )
              .then((r) => writePersistResult(socket, req.id ?? null, r))
              .catch((err) =>
                writeError(
                  socket,
                  req.id ?? null,
                  -32603,
                  (err as Error).message
                )
              )
            return
          }
          case "device.event.emit": {
            if (!requireAuthenticated(req)) return
            if (!state.authenticatedWorkspaceId) {
              writeError(
                socket,
                req.id ?? null,
                -32603,
                "device.event.emit needs workspace context; auth did not resolve workspace_id"
              )
              return
            }
            persistDeviceEventEmit(state.authenticatedWorkspaceId, req.params)
              .then((r) => writePersistResult(socket, req.id ?? null, r))
              .catch((err) =>
                writeError(
                  socket,
                  req.id ?? null,
                  -32603,
                  (err as Error).message
                )
              )
            return
          }
          case "device.vfs.exposure.upsert": {
            if (!requireAuthenticated(req)) return
            persistVfsExposureUpsert(state.authenticatedDeviceId!, req.params)
              .then((r) => writePersistResult(socket, req.id ?? null, r))
              .catch((err) =>
                writeError(
                  socket,
                  req.id ?? null,
                  -32603,
                  (err as Error).message
                )
              )
            return
          }
          default: {
            writeError(
              socket,
              req.id ?? null,
              -32601,
              `Method not found: ${req.method}`
            )
          }
        }
      })

      socket.on("close", () => {
        if (state.registeredTunnelServiceId) {
          // compare-and-delete on THIS socket's session: a half-open old socket's
          // deferred close must not evict a live entry a newer socket re-registered
          // for the same service (the stale-close race, §3.3). state.sessionId is
          // still set here — the session close below nulls it afterwards.
          getDeviceTunnelRegistry().unregister(
            state.registeredTunnelServiceId,
            state.sessionId ?? undefined
          )
          state.registeredTunnelServiceId = null
        }
        if (state.sessionId) {
          void closeControlPlaneSession(state.sessionId, "socket_close")
          state.sessionId = null
        }
      })
    }) as never
  )
}
