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
import { designActors } from "../fixtures/model-groups"
import type { DesignHandlers } from "./_types"

// Actors / org tree: detail, version history, the marketplace package catalog,
// install results, and the recursive org tree. These drive the actor directory,
// profile, and marketplace pages.
export const actorsHandlers = {
  // Curated actors — drive the Actor model-assignment board (and chat @-mentions
  // / actor directory). Must be a real array (chat .filter's it).
  getActors: async () => designActors,
  getActor: async () => mock(ActorViewSchema),
  getActorVersions: async () => mock(ActorVersionListViewSchema),
  getActorPackages: async () => mock(ActorPackageListViewSchema),
  getActorPackage: async () => mock(ActorPackageRecordViewSchema),
  installActorPackage: async () => mock(ActorPackageInstallResultViewSchema),
  getOrgTree: async () => mock(ActorTreeViewSchema),
  deleteActor: async () => mock(WorkspaceResourceSuccessViewSchema),
} satisfies DesignHandlers
