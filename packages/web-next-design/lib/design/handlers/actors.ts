import {
  ActorViewSchema,
  ActorVersionListViewSchema,
  ActorPackageListViewSchema,
  ActorPackageRecordViewSchema,
  ActorPackageInstallResultViewSchema,
  ActorTreeViewSchema,
  WorkspaceResourceSuccessViewSchema,
} from "@synapse/shared/schemas"
import { mock } from "../faker-setup"
import type { DesignHandlers } from "./_types"

// Actors / org tree: detail, version history, the marketplace package catalog,
// install results, and the recursive org tree. These drive the actor directory,
// profile, and marketplace pages.
export const actorsHandlers = {
  // getActors returns the hand-written Actor[] (no matching schema). The chat
  // loads it for @-mentions and calls .filter on it, so it must be an array,
  // not the catch-all's undefined. Empty is fine — conversation participants
  // already drive mentions.
  getActors: async () => [],
  getActor: async () => mock(ActorViewSchema),
  getActorVersions: async () => mock(ActorVersionListViewSchema),
  getActorPackages: async () => mock(ActorPackageListViewSchema),
  getActorPackage: async () => mock(ActorPackageRecordViewSchema),
  installActorPackage: async () => mock(ActorPackageInstallResultViewSchema),
  getOrgTree: async () => mock(ActorTreeViewSchema),
  deleteActor: async () => mock(WorkspaceResourceSuccessViewSchema),
} satisfies DesignHandlers
