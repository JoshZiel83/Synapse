import test from "node:test"
import assert from "node:assert/strict"
import type { MarketplacePluginView } from "@synapse/shared"
import { assertIsoInstant } from "@synapse/shared/datetime"
import { PluginInstallationDetailViewSchema } from "@synapse/shared/schemas"
import {
  presentPluginInstallationDetail,
  type PluginInstallationDetailRecord,
} from "./presenter.js"

test("presentPluginInstallationDetail output parses PluginInstallationDetailViewSchema", () => {
  const plugin: MarketplacePluginView = {
    id: "plugin-1",
    orgId: "org-1",
    slug: "demo-plugin",
    displayName: "Demo Plugin",
    description: "Demo description",
    longDescription: "Long description",
    displayNameI18n: { en: "Demo Plugin" },
    descriptionI18n: { en: "Demo description" },
    longDescriptionI18n: { en: "Long description" },
    summaryI18n: { en: "Summary" },
    defaultLocale: "en",
    defaultConversationTypeMask: 15,
    supportedReuseScopes: ["conversation"],
    defaultReuseScope: "conversation",
    lifecycleScope: "conversation",
    configSchema: {
      type: "object",
      properties: {
        apiKey: { type: "string", sensitive: true },
        region: { type: "string" },
      },
    },
    configFields: [
      {
        key: "apiKey",
        titleI18n: { en: "API key" },
        type: "secret",
        required: true,
        secret: true,
      },
      {
        key: "region",
        titleI18n: { en: "Region" },
        type: "text",
      },
    ],
    authBindings: [],
    installFlow: { steps: [] },
    toolsManifest: [],
    categories: [],
    categorySlugs: [],
    version: "1.0.0",
    transport: "builtin",
    entryPoint: "",
    iconUrl: null,
    defaultConfig: {},
    tags: [],
    isActive: true,
    isBuiltin: true,
    downloadCount: 0,
    createdAt: assertIsoInstant("2026-06-13T00:00:00.000Z"),
    updatedAt: assertIsoInstant("2026-06-13T00:00:00.000Z"),
    validationRules: [],
    setupSteps: [],
    orgSlug: "synapse",
    orgDisplayName: "Synapse",
    publisher: {
      id: "org-1",
      slug: "synapse",
      displayName: "Synapse",
      description: "Synapse publisher",
      isVerified: true,
    },
    requiresHandshake: false,
    authorization: { requiredPermissions: [] },
    metadata: {},
  }

  const record: PluginInstallationDetailRecord = {
    row: {
      installationId: "install-1",
      rootWorkspaceId: "workspace-1",
      catalogItemId: "plugin-1",
      catalogVersionId: "version-1",
      rootDisplayName: "Demo Plugin",
      configData: { apiKey: "secret-value", region: "iad" },
      approvedRuntimePermissions: [],
      reuseScope: "conversation",
      rootConversationTypeMaskOverride: null,
      rootStatus: "active",
      rootOwnerWorkspaceMemberId: "member-1",
      installationCreatedAt: new Date("2026-06-13T00:00:00.000Z"),
      installationUpdatedAt: new Date("2026-06-13T00:00:00.000Z"),
      sourceCatalogItemId: "plugin-1",
      sourceCatalogVersionId: "version-1",
      sourceSyncMode: "manual_merge",
    },
    plugin,
    workspaceConversationTypeMask: 15,
  }

  const parsed = PluginInstallationDetailViewSchema.safeParse(
    presentPluginInstallationDetail(record)
  )
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues))
  assert.equal(parsed.data.configData.region, "iad")
  assert.equal(parsed.data.configData.apiKey, undefined)
  assert.equal(parsed.data.configState[0]?.key, "apiKey")
})
