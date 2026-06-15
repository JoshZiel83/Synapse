import test from "node:test"
import assert from "node:assert/strict"
import {
  normalizeInstallationConfigData,
  normalizeInstallationConfigRow,
  normalizeInstallationRow,
  normalizeJsonArray,
  normalizeNullablePluginConnectionPublicPayload,
  normalizePluginCatalogRow,
  normalizePluginInstallationAuthConfigRow,
  normalizePluginAuthSpecRow,
  normalizeVisiblePluginRow,
  type PluginCatalogDbRow,
} from "./repo.js"

const createdAt = new Date("2026-06-14T00:00:00.000Z")
const updatedAt = new Date("2026-06-14T00:01:00.000Z")

test("normalizeInstallationConfigData parses object JSON only", () => {
  assert.deepEqual(normalizeInstallationConfigData({ region: "iad" }), {
    region: "iad",
  })
  assert.deepEqual(normalizeInstallationConfigData('{"region":"iad"}'), {
    region: "iad",
  })
  assert.deepEqual(normalizeInstallationConfigData('["not","object"]'), {})
})

test("normalizeInstallationRow decodes configData at repo exit", () => {
  assert.deepEqual(
    normalizeInstallationRow({
      installationId: "install-1",
      rootWorkspaceId: "workspace-1",
      catalogItemId: "plugin-1",
      catalogVersionId: "version-1",
      rootDisplayName: "Demo Plugin",
      configData: '{"apiKey":"secret","region":"iad"}',
      approvedRuntimePermissions: ["tool.execute"],
      reuseScope: "conversation",
      rootConversationTypeMaskOverride: null,
      rootStatus: "active",
      rootOwnerWorkspaceMemberId: "member-1",
      installationCreatedAt: createdAt,
      installationUpdatedAt: updatedAt,
      sourceCatalogItemId: "plugin-1",
      sourceCatalogVersionId: "version-1",
      sourceSyncMode: "manual_merge",
    }).configData,
    { apiKey: "secret", region: "iad" }
  )
})

test("normalizeNullablePluginConnectionPublicPayload decodes public payload at repo exit", () => {
  assert.deepEqual(
    normalizeNullablePluginConnectionPublicPayload(
      '{"scopes":["drive:read"],"brand":"feishu"}'
    ),
    { scopes: ["drive:read"], brand: "feishu" }
  )
  assert.deepEqual(
    normalizeNullablePluginConnectionPublicPayload({
      scopes: ["docx:read"],
    }),
    { scopes: ["docx:read"] }
  )
  assert.equal(normalizeNullablePluginConnectionPublicPayload(null), null)
  assert.equal(normalizeNullablePluginConnectionPublicPayload(undefined), null)
  assert.deepEqual(normalizeNullablePluginConnectionPublicPayload("[1,2]"), {})
})

test("normalizeInstallationConfigRow decodes config resolver JSON fields", () => {
  const row = normalizeInstallationConfigRow({
    catalogItemId: "plugin-1",
    configData: '{"apiKey":"secret"}',
    defaultConfig: '{"region":"iad"}',
    configSchema: '{"type":"object"}',
  })

  assert.deepEqual(row.configData, { apiKey: "secret" })
  assert.deepEqual(row.defaultConfig, { region: "iad" })
  assert.deepEqual(row.configSchema, { type: "object" })
})

test("normalizePluginInstallationAuthConfigRow decodes auth config JSON fields", () => {
  const row = normalizePluginInstallationAuthConfigRow({
    catalogItemId: "plugin-1",
    catalogVersionId: "version-1",
    configData: '{"clientId":"client-1"}',
    defaultConfig: '{"region":"iad"}',
  })

  assert.deepEqual(row.configData, { clientId: "client-1" })
  assert.deepEqual(row.defaultConfig, { region: "iad" })
})

test("normalizePluginAuthSpecRow decodes auth spec config and bindings", () => {
  const row = normalizePluginAuthSpecRow({
    catalogItemId: "plugin-1",
    catalogVersionId: "version-1",
    defaultConfig: '{"region":"iad"}',
    authBindings:
      '[{"key":"oauth","displayNameI18n":{"en":"OAuth"},"driver":"oauth2_authorization_code_pkce","inputs":{}}]',
  })

  assert.deepEqual(row.defaultConfig, { region: "iad" })
  assert.equal(row.authBindings[0]?.key, "oauth")
  assert.equal(row.authBindings[0]?.driver, "oauth2_authorization_code_pkce")
})

test("normalizeJsonArray returns an empty array for non-array JSON", () => {
  assert.deepEqual(normalizeJsonArray('{"not":"array"}'), [])
  assert.deepEqual(normalizeJsonArray(null), [])
})

test("normalizePluginCatalogRow decodes catalog JSON fields at repo exit", () => {
  const row = normalizePluginCatalogRow({
    itemMetadata: '{"displayNameI18n":{"en":"Demo"}}',
    versionMetadata: '{"channel":"stable"}',
    specToolManifest: '[{"name":"search"}]',
    specConfigSchema: '{"type":"object"}',
    specDefaultConfig: '{"region":"iad"}',
    specInstallFlow: '{"steps":[]}',
    specAuthBindings:
      '[{"key":"oauth","driver":"oauth2_authorization_code_pkce"}]',
    specSupportedReuseScopes: '["conversation","workspace"]',
    specMetadata: '{"configFields":[]}',
    categoriesJson: '[{"slug":"productivity"}]',
    runtimePermissionsJson: '[{"permissionKey":"tool.execute"}]',
  } as PluginCatalogDbRow)

  assert.deepEqual(row.itemMetadata, { displayNameI18n: { en: "Demo" } })
  assert.deepEqual(row.versionMetadata, { channel: "stable" })
  assert.deepEqual(row.specToolManifest[0], { name: "search" })
  assert.deepEqual(row.specConfigSchema, { type: "object" })
  assert.deepEqual(row.specDefaultConfig, { region: "iad" })
  assert.deepEqual(row.specInstallFlow, { steps: [] })
  assert.equal(row.specAuthBindings[0]?.key, "oauth")
  assert.deepEqual(row.specSupportedReuseScopes, ["conversation", "workspace"])
  assert.deepEqual(row.specMetadata, { configFields: [] })
  assert.equal(row.categoriesJson[0]?.slug, "productivity")
  assert.equal(row.runtimePermissionsJson[0]?.permissionKey, "tool.execute")
})

test("normalizeVisiblePluginRow decodes tool manifest at repo exit", () => {
  const row = normalizeVisiblePluginRow({
    installationId: "install-1",
    ownerWorkspaceId: "workspace-1",
    installationStatus: "active",
    catalogItemId: "plugin-1",
    itemSlug: "demo-plugin",
    publisherSlug: "synapse",
    transport: "builtin",
    entryPoint: "",
    toolManifest:
      '[{"name":"search","description":"Search docs","inputSchema":{"type":"object","properties":{"q":{"type":"string"}},"required":["q"]}}]',
    reuseScope: "conversation",
    conversationTypeMaskOverride: null,
  })

  assert.equal(row.toolManifest[0]?.name, "search")
  assert.deepEqual(row.toolManifest[0]?.inputSchema?.required, ["q"])
})
