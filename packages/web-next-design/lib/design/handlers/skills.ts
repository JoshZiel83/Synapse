import {
  SkillMarketplaceItemViewSchema,
  InstalledSkillItemViewSchema,
  WorkspaceResourceSuccessViewSchema,
} from "@synapse/shared/schemas"
import { mock } from "../faker-setup"
import {
  designInstalledSkills,
  designMarketplaceSkills,
  findInstalledSkill,
  findMarketSkill,
} from "../fixtures/skills"
import type { DesignHandlers } from "./_types"

// Skills marketplace + installed-skill lifecycle. Curated fixtures (real AI-agent
// skill modules, Chinese) replace the random faker output that filled the old
// table with lorem + "Unknown" dates; mutations echo a coherent item.
export const skillsHandlers = {
  getSkillMarketplace: async () => ({ skills: designMarketplaceSkills }),
  getSkillMarketplaceItem: async (_ws: string, id: string) => ({
    skill: findMarketSkill(id) ?? designMarketplaceSkills[0],
  }),
  publishMarketplaceSkill: async () => mock(SkillMarketplaceItemViewSchema),
  importMarketplaceSkill: async () => mock(SkillMarketplaceItemViewSchema),
  refreshMarketplaceSkill: async () => mock(SkillMarketplaceItemViewSchema),
  createWorkspaceSkill: async () => ({ skill: designInstalledSkills[0] }),
  getInstalledSkills: async () => ({ skills: designInstalledSkills }),
  getInstalledSkill: async (_ws: string, id: string) => ({
    skill: findInstalledSkill(id) ?? designInstalledSkills[0],
  }),
  installSkill: async () => ({ skill: designInstalledSkills[0] }),
  updateInstalledSkill: async (_ws: string, id: string) => ({
    skill: findInstalledSkill(id) ?? designInstalledSkills[0],
  }),
  upgradeInstalledSkill: async () => ({ skill: designInstalledSkills[0] }),
  uninstallInstalledSkill: async () => mock(WorkspaceResourceSuccessViewSchema),
} satisfies DesignHandlers
