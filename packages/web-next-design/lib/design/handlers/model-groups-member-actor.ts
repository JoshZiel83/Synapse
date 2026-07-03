import {
  designModelGroupList,
  designActorAssignments,
  findModelGroup,
} from "../fixtures/model-groups"
import type { DesignHandlers } from "./_types"

// Model-groups settings surface for the workspace-member ("me") routes plus the
// actor failover-chain assignment endpoints. Curated fixtures (real bindings)
// replace the random faker output. Actor assignment is wired in Phase 2.
const meGroups = () => designModelGroupList("workspace_member")
const meById = (id?: string) =>
  (id ? findModelGroup(id) : undefined) ?? meGroups()[0]

export const modelGroupsMemberActorHandlers = {
  getWorkspaceMemberModelGroups: async () => meGroups(),
  createWorkspaceMemberModelGroup: async () => meGroups()[0],
  getWorkspaceMemberModelGroup: async (_ws: string, id: string) => meById(id),
  updateWorkspaceMemberModelGroup: async (_ws: string, id: string) =>
    meById(id),
  getWorkspaceMemberModelGroupGrants: async (_ws: string, id: string) =>
    meById(id).grants,
  issueWorkspaceMemberModelGroupGrant: async (_ws: string, id: string) =>
    meById(id).grants[0] ?? designModelGroupList("workspace")[1].grants[0],
  addWorkspaceMemberModelItem: async (_ws: string, id: string) =>
    meById(id).items[0],
  updateWorkspaceMemberModelItem: async (_ws: string, id: string) =>
    meById(id).items[0],
  getWorkspaceMemberItemVersions: async () => [],
  getActorModelGroups: async (_ws: string, actorId: string) =>
    designActorAssignments[actorId] ?? [],
  getVisibleActorModelGroups: async () => designModelGroupList("workspace"),
  // Echo the full-replace chain back as assignment views.
  setActorModelGroups: async (
    _ws: string,
    actorId: string,
    groups: { groupId: string; priority: number }[]
  ) =>
    groups.map((g) => {
      const grp = findModelGroup(g.groupId)
      return {
        actorId,
        groupId: g.groupId,
        priority: g.priority,
        createdAt: null,
        groupName: grp?.name ?? g.groupId,
        routingStrategy: grp?.routingStrategy ?? ("priority_failover" as const),
        isDefault: grp?.isDefault ?? false,
        workspaceId: grp?.workspaceId ?? null,
        ownerType: grp?.ownerType ?? ("workspace" as const),
        ownerWorkspaceMemberId: grp?.ownerWorkspaceMemberId ?? null,
      }
    }),
} satisfies DesignHandlers
