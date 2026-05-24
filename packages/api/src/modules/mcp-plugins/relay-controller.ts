// relay-controller.ts — DEPRECATED stub (PR #17 of device-runtime v3).
//
// All v2 relay REST routes have been removed. The replacement is the
// device subsystem under packages/api/src/modules/devices/ (mounted as
// devicesModule in api/src/index.ts). registerRelayRoutes is a no-op so
// existing imports keep compiling.

import type { FastifyInstance } from "fastify"

export function registerRelayRoutes(_app: FastifyInstance): void {
  // Intentionally empty. v2 relay endpoints are gone; the v3 device REST
  // surface lives under /api/v1/workspaces/:workspaceId/devices/* and is
  // registered by devicesModule (see modules/devices/controller.ts).
}
