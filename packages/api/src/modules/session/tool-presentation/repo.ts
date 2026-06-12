// session/tool-presentation/repo.ts — DB read for the tool-presentation
// resolver. The only file in this sub-module permitted to touch the db client
// (guard r8); resolver.ts is pure (snapshot → descriptor) and calls this for
// the one live installation→manifest lookup it needs. round-6 P1-6.

import { db } from "../../../infrastructure/database/kysely.js"
import { livePluginInstallations } from "../../soft-delete/live-reads.js"

/**
 * The current tool manifest for a plugin installation, via the live
 * (soft-delete-aware) installation → catalog version → manifest join. Returns
 * the raw manifest value (an array of entry objects) or null when the
 * installation/version is gone; the resolver interprets the entries.
 */
export async function selectPluginToolManifest(
  installationId: string
): Promise<unknown | null> {
  const row = await livePluginInstallations(db)
    .innerJoin(
      "pluginPackageVersionSpecs as spec",
      "spec.catalogVersionId",
      "pluginInstallationsLive.catalogVersionId"
    )
    .select(["spec.toolManifest as toolManifest"])
    .where("pluginInstallationsLive.id", "=", installationId)
    .executeTakeFirst()
  return row ? row.toolManifest : null
}
