import { designModelGroupList, findModelGroup } from "../fixtures/model-groups"
import type { DesignHandlers } from "./_types"

// Model-group CRUD for the workspace + platform surfaces. Curated fixtures
// (real Claude/GPT/GLM/DeepSeek bindings) replace the random faker output that
// rendered lorem names + negative priority/weight. Creates/updates echo a
// coherent group/item; the sandbox is stateless so nothing persists.
const wsGroups = () => designModelGroupList("workspace")
const platGroups = () => designModelGroupList("platform")
const byId = (id?: string, fallback = wsGroups()[0]) =>
  (id ? findModelGroup(id) : undefined) ?? fallback

export const modelGroupsWsPlatformHandlers = {
  getModelGroups: async () => wsGroups(),
  createModelGroup: async () => wsGroups()[0],
  getModelGroup: async (_ws: string, id: string) => byId(id),
  updateModelGroup: async (_ws: string, id: string) => byId(id),
  getModelGroupGrants: async (_ws: string, id: string) => byId(id).grants,
  issueModelGroupGrant: async (_ws: string, id: string) =>
    byId(id).grants[0] ?? wsGroups()[1].grants[0],
  addModelItem: async (_ws: string, id: string) => byId(id).items[0],
  updateModelItem: async (_ws: string, id: string) => byId(id).items[0],
  getItemVersions: async () => [],
  getPlatformModelGroups: async () => platGroups(),
  createPlatformModelGroup: async () => platGroups()[0],
  getPlatformModelGroup: async (id: string) => byId(id, platGroups()[0]),
  updatePlatformModelGroup: async (id: string) => byId(id, platGroups()[0]),
  getPlatformModelGroupGrants: async (id: string) =>
    byId(id, platGroups()[0]).grants,
  issuePlatformModelGroupGrant: async (id: string) =>
    byId(id, platGroups()[0]).grants[0] ?? wsGroups()[1].grants[0],
  addPlatformModelItem: async (id: string) =>
    byId(id, platGroups()[0]).items[0],
  updatePlatformModelItem: async (id: string) =>
    byId(id, platGroups()[0]).items[0],
  getPlatformItemVersions: async () => [],
} satisfies DesignHandlers
