// relay-manager.ts — DEPRECATED stubs (PR #17 of device-runtime v3).
//
// The v2 relay dispatch hot path (~4500 LOC across this file) is **gone**.
// Every export below is a no-op or throwing stub preserved only so existing
// importers continue to compile while the dispatch path is fully migrated to
// the device runtime (@synapse/device-runtime + packages/api/src/modules/
// devices/dispatch.ts).
//
// Behavior: any tool dispatch routed through these stubs returns
// `runtime_constraint` so the chat runtime surfaces the deprecation cleanly.
// See packages/api/src/modules/mcp-plugins/DEPRECATED-RELAY.md for the
// replacement map.

import type { FastifyInstance } from "fastify"
import type {
  RelayCatalogToolSnapshot,
  RelayHiddenToolBinding,
  ToolResultOrigin,
} from "@synapse/shared"
import type {
  RelayAuthorizationGrantSpec,
  RelayAuthorizationGrantScope,
} from "@synapse/shared/types"

export interface RelayAuthorizationEnvelope {
  grantIds?: string[]
  grantScope?: RelayAuthorizationGrantScope
  grantSpecs?: RelayAuthorizationGrantSpec[]
  retryNonce?: string
}

// ───────────────────────────── deprecation error ────────────────────────────

function deprecated(name: string): never {
  const err = new Error(
    `relay v2 deprecated: ${name} — pair devices through @synapse/device-runtime and dispatch via modules/devices/dispatch.ts (see DEPRECATED-RELAY.md)`
  ) as Error & { code: string }
  err.code = "runtime_constraint"
  throw err
}

// ───────────────────────────── types preserved for compat ───────────────────

export interface RelayCallParams {
  conversationId?: string
  sessionId?: string
  requestedByWorkspaceMemberId?: string
  requestedByActorId?: string
  relayCapabilityId: string
  deviceId: string
  exposureId: string
  visibleToolName: string
  binding: RelayHiddenToolBinding
  args: Record<string, unknown>
  runtimeSessionId: string
  authorization?: RelayAuthorizationEnvelope
}

export interface RelayAsyncCallParams extends RelayCallParams {
  workspaceId: string
  conversationId: string
  sessionId: string
  requestedByActorId: string
  sourceToolCallId: string
  sourceToolName: string
  turnId?: string
  requestedByWorkspaceMemberId?: string
  deliveryPolicy: string
  serverInvokeOptions?: Record<string, unknown>
}

export interface RelayExposureCatalog {
  deviceId: string
  deviceDisplayName: string
  exposureId: string
  exposureStableKey: string
  exposureDisplayName: string
  transport: string
  runtimeStatus:
    | "discovered"
    | "healthy"
    | "degraded"
    | "failed"
    | "quarantined"
    | "offline"
  metadata: Record<string, unknown>
  tools: RelayCatalogToolSnapshot[]
}

// ───────────────────────────── stubbed lifecycle ────────────────────────────

export function handleRelayConnection(
  _socket: unknown,
  _req: unknown,
  _app: FastifyInstance
): void {
  // Devices no longer connect through relay v2. The new control-plane WSS at
  // /api/v1/devices/control-plane handles all device traffic.
}

export async function initRelayManager(): Promise<void> {
  // No relay registry to bring up.
}

export async function shutdownAllRelays(): Promise<void> {
  // Nothing to shut down.
}

export function disconnectRelay(_relayId: string): void {
  // No relay connections to terminate.
}

export function isRelayConnected(_relayId: string): boolean {
  return false
}

// ───────────────────────────── stubbed dispatch ─────────────────────────────

export async function callRelayTool(
  _params: RelayCallParams
): Promise<unknown> {
  deprecated("callRelayTool")
}

export async function enqueueRelayToolTask(
  _params: RelayAsyncCallParams
): Promise<{ operationId: string; taskId: string }> {
  deprecated("enqueueRelayToolTask")
}

export async function cancelRelayToolTask(
  _taskId: string,
  _reason?: string
): Promise<{ status: "cancelled" | "noop" } | null> {
  return { status: "noop" }
}

export async function loadRelayExposureCatalogSnapshot(
  _deviceId: string,
  _exposureId: string
): Promise<RelayExposureCatalog | null> {
  return null
}

export async function getConnectedRelaySessionId(
  _deviceId: string
): Promise<string | null> {
  return null
}

export async function openRelayRuntimeSession(_params: {
  deviceId: string
  exposureId: string
  exposureStableKey: string
}): Promise<string> {
  deprecated("openRelayRuntimeSession")
}

export async function closeRelayRuntimeSession(_params: {
  deviceId: string
  runtimeSessionId: string
}): Promise<void> {
  // no-op
}

export async function resolveRelayToolAuthorization(params: {
  workspaceId: string
  relayDeviceId: string
  relayCapabilityId: string
  relayExposureId: string
  conversationId?: string | null
  actorId?: string | null
  relayToolStableKey?: string
  relayToolName: string
  toolArguments: Record<string, unknown>
  runtimeSessionId: string
  exposureMetadata: Record<string, unknown>
  authorization?: RelayAuthorizationEnvelope
}): Promise<{
  authorization?: RelayAuthorizationEnvelope
  authorizationPlan?: unknown
}> {
  return { authorization: params.authorization }
}

// Marker symbol some callers compare against.
export const RELAY_RUNTIME_NODE_ID = "deprecated-relay-runtime"
export type {
  ToolResultOrigin,
  RelayAuthorizationGrantSpec,
  RelayAuthorizationGrantScope,
  RelayHiddenToolBinding,
}
