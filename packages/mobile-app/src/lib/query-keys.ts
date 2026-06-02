/**
 * Centralized React Query key factory (mobile).
 *
 * Mirrors the web factory: every workspace-scoped resource roots its key at
 * `qk.workspace(workspaceId)` so a workspace switch / logout can prune cleanly.
 * The chat realtime store (ChatRuntime) is intentionally NOT managed by React
 * Query — only request/response screen data lives here.
 */
export const qk = {
  all: ["synapse"] as const,

  workspace: (workspaceId: string) =>
    [...qk.all, "workspace", workspaceId] as const,

  contactHub: (workspaceId: string) =>
    [...qk.workspace(workspaceId), "contact-hub"] as const,
  friendRequests: (workspaceId: string) =>
    [...qk.workspace(workspaceId), "friend-requests"] as const,
  actorAccessRequests: (workspaceId: string) =>
    [...qk.workspace(workspaceId), "actor-access-requests"] as const,
  actors: (workspaceId: string) =>
    [...qk.workspace(workspaceId), "actors"] as const,
  chiefActorPreference: (workspaceId: string) =>
    [...qk.workspace(workspaceId), "chief-actor-preference"] as const,
  identitySearch: (workspaceId: string, query: string) =>
    [...qk.workspace(workspaceId), "identity-search", query] as const,
} as const

export type QueryKeyFactory = typeof qk
