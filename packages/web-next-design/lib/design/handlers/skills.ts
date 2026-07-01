import {
  SkillMarketplaceListViewSchema,
  SkillMarketplaceItemViewSchema,
  InstalledSkillListViewSchema,
  InstalledSkillItemViewSchema,
  WorkspaceResourceSuccessViewSchema,
} from "@synapse/shared/schemas"
import { mock } from "../faker-setup"
import type { DesignHandlers } from "./_types"

// Skills marketplace + installed-skill lifecycle. The marketplace list/detail
// feeds the browse pages; publish/import/refresh and the install/upgrade/update
// flows all resolve to the same item envelopes, so the mocks reuse the shared
// view schemas. uninstall returns the generic workspace-resource success view.
export const skillsHandlers = {
  getSkillMarketplace: async () => mock(SkillMarketplaceListViewSchema),
  getSkillMarketplaceItem: async () => mock(SkillMarketplaceItemViewSchema),
  publishMarketplaceSkill: async () => mock(SkillMarketplaceItemViewSchema),
  importMarketplaceSkill: async () => mock(SkillMarketplaceItemViewSchema),
  refreshMarketplaceSkill: async () => mock(SkillMarketplaceItemViewSchema),
  createWorkspaceSkill: async () => mock(InstalledSkillItemViewSchema),
  getInstalledSkills: async () => mock(InstalledSkillListViewSchema),
  getInstalledSkill: async () => mock(InstalledSkillItemViewSchema),
  installSkill: async () => mock(InstalledSkillItemViewSchema),
  updateInstalledSkill: async () => mock(InstalledSkillItemViewSchema),
  upgradeInstalledSkill: async () => mock(InstalledSkillItemViewSchema),
  uninstallInstalledSkill: async () => mock(WorkspaceResourceSuccessViewSchema),
} satisfies DesignHandlers
