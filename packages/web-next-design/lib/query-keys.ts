import type { AuditLogListQuery } from "@synapse/shared/schemas"

/**
 * Centralized React Query key factory.
 *
 * Every workspace-scoped resource roots its key at `qk.workspace(workspaceId)`
 * so a single `removeQueries({ queryKey: qk.workspace(id) })` prunes an entire
 * workspace subtree on workspace switch, and `queryClient.clear()` on logout wipes
 * everything. Keys are auth-scoped implicitly: all cached data belongs to the
 * current session, which is why logout clears the whole cache rather than
 * embedding the user id in every key.
 *
 * Add one entry per resource here instead of inlining string-array keys at call
 * sites, so invalidation targets stay consistent.
 */
export const qk = {
  all: ["synapse"] as const,

  workspace: (workspaceId: string) =>
    [...qk.all, "workspace", workspaceId] as const,

  // ----- workspace-scoped resources -----
  devices: (workspaceId: string) =>
    [...qk.workspace(workspaceId), "devices"] as const,
  device: (workspaceId: string, deviceId: string) =>
    [...qk.workspace(workspaceId), "devices", deviceId] as const,

  auditLogs: (workspaceId: string, query?: AuditLogListQuery) =>
    [...qk.workspace(workspaceId), "audit-logs", query ?? {}] as const,

  remoteAgents: (workspaceId: string) =>
    [...qk.workspace(workspaceId), "remote-agents"] as const,
  remoteAgentMachines: (workspaceId: string) =>
    [...qk.workspace(workspaceId), "remote-agent-machines"] as const,

  automationEventSources: (workspaceId: string) =>
    [...qk.workspace(workspaceId), "automation-event-sources"] as const,
  installations: (workspaceId: string, params?: string) =>
    [...qk.workspace(workspaceId), "mcp-installations", params ?? ""] as const,

  contactHub: (workspaceId: string) =>
    [...qk.workspace(workspaceId), "contact-hub"] as const,

  memoriesBrowser: (workspaceId: string) =>
    [...qk.workspace(workspaceId), "memories-browser"] as const,

  automations: (workspaceId: string) =>
    [...qk.workspace(workspaceId), "automations"] as const,
} as const

export type QueryKeyFactory = typeof qk
