import test from "node:test"
import assert from "node:assert/strict"
import crypto from "node:crypto"
import {
  MARKETPLACE_REQUIREMENT_KIND,
  MARKETPLACE_REQUIREMENT_STATUS,
  MCP_VALIDATION_RULE_KIND,
  PLUGIN_AUTH_BINDING_DRIVER_KIND,
  PLUGIN_AUTH_CHALLENGE_KIND,
  PLUGIN_AUTH_CHALLENGE_OPEN_MODE,
  PLUGIN_AUTH_DERIVED_VALUE_NAME,
  PLUGIN_AUTH_SESSION_PHASE,
  PLUGIN_AUTH_SESSION_STATUS,
  PLUGIN_AUTH_VALUE_SOURCE_KIND,
  PLUGIN_CONFIG_FIELD_TYPE,
  PLUGIN_INSTALLATION_STATUS,
  PLUGIN_INSTALL_ACTION_KIND,
  PLUGIN_INSTALL_STEP_KIND,
  PLUGIN_INSTALL_STEP_SCOPE,
  MARKETPLACE_SYNC_MODE,
} from "@synapse/shared"
import {
  McpMarketplaceListQuerySchema,
  McpPluginEventAuditLogListQuerySchema,
  McpPluginInstallationListQuerySchema,
  McpPluginToolCallAuditLogListQuerySchema,
  McpValidationRuleSchema,
  MarketplaceRequirementCheckSchema,
  PluginAuthChallengeViewSchema,
  PluginAuthBindingDefinitionSchema,
  PluginAuthSessionViewSchema,
  PluginAuthValueSourceSchema,
  PluginConfigFieldDefinitionSchema,
  PluginInstallationDetailViewSchema,
  PluginInstallActionSchema,
  PluginInstallStepSchema,
  PluginInstallPlanEnvelopeSchema,
  PluginInstallPlanInputSchema,
  StartPluginAuthInputSchema,
} from "@synapse/shared/schemas"

function uuid() {
  return crypto.randomUUID()
}

test("PluginInstallPlanInputSchema parses the no-body install-plan request", () => {
  assert.deepEqual(PluginInstallPlanInputSchema.parse({}), {})
  assert.deepEqual(PluginInstallPlanInputSchema.parse({ ignored: true }), {})
})

test("PluginInstallPlanEnvelopeSchema validates install-plan responses", () => {
  assert.equal(
    PluginInstallPlanEnvelopeSchema.safeParse({
      plan: {
        packageId: uuid(),
        revisionId: null,
        workspaceId: uuid(),
        checks: [],
        grantPlan: {
          requiresGrant: false,
          requiredPermissions: [],
        },
      },
    }).success,
    true
  )
})

test("PluginInstallPlanEnvelopeSchema validates check and grant-plan structure", () => {
  const parsed = PluginInstallPlanEnvelopeSchema.parse({
    plan: {
      packageId: uuid(),
      revisionId: uuid(),
      workspaceId: uuid(),
      checks: [
        {
          requirementId: uuid(),
          requirementKind: MARKETPLACE_REQUIREMENT_KIND.REQUIRED,
          status: MARKETPLACE_REQUIREMENT_STATUS.MISSING_REQUIRED,
          message: "Install the dependency first.",
          matchedInstanceIds: [],
          missingPublisherSlug: "synapse",
          missingPackageSlug: "browser",
        },
      ],
      grantPlan: {
        requiresGrant: true,
        requiredPermissions: ["tool.execute"],
        suggestedAccessTargetType: "workspace",
        reason: "Plugin tools need workspace access.",
      },
    },
  })
  assert.equal(
    parsed.plan.checks[0]?.requirementKind,
    MARKETPLACE_REQUIREMENT_KIND.REQUIRED
  )
  assert.equal(parsed.plan.grantPlan.suggestedAccessTargetType, "workspace")
})

test("PluginInstallPlanEnvelopeSchema rejects unknown install-plan shapes", () => {
  assert.equal(
    PluginInstallPlanEnvelopeSchema.safeParse({
      plan: {
        packageId: uuid(),
        revisionId: null,
        workspaceId: uuid(),
        checks: [
          {
            requirementId: uuid(),
            requirementKind: MARKETPLACE_REQUIREMENT_KIND.REQUIRED,
            status: "unknown_status",
            message: "bad",
            matchedInstanceIds: [],
          },
        ],
        grantPlan: {
          requiresGrant: true,
          requiredPermissions: [],
          suggestedAccessTargetType: "device",
        },
      },
    }).success,
    false
  )
  assert.equal(
    PluginInstallPlanEnvelopeSchema.safeParse({
      plan: {
        packageId: uuid(),
        revisionId: null,
        workspaceId: uuid(),
        checks: [],
        grantPlan: {
          requiresGrant: false,
          requiredPermissions: [],
          extra: true,
        },
      },
    }).success,
    false
  )
})

test("plugin install/auth flow schemas validate finite action and challenge enums", () => {
  assert.ok(
    PluginInstallActionSchema.safeParse({
      kind: PLUGIN_INSTALL_ACTION_KIND.AUTH_START,
      bindingKey: "oauth",
      buttonLabelI18n: { en: "Authorize" },
    }).success
  )
  assert.equal(
    PluginInstallActionSchema.safeParse({
      kind: "start_oauth",
      bindingKey: "oauth",
    }).success,
    false
  )

  assert.ok(
    PluginAuthChallengeViewSchema.safeParse({
      kind: PLUGIN_AUTH_CHALLENGE_KIND.REDIRECT,
      url: "https://example.test/oauth",
      openMode: PLUGIN_AUTH_CHALLENGE_OPEN_MODE.POPUP,
      metadata: {},
    }).success
  )
  assert.equal(
    PluginAuthChallengeViewSchema.safeParse({
      kind: "device_code",
      url: "https://example.test/oauth",
    }).success,
    false
  )
  assert.equal(
    PluginAuthChallengeViewSchema.safeParse({
      kind: PLUGIN_AUTH_CHALLENGE_KIND.REDIRECT,
      url: "https://example.test/oauth",
      openMode: "new_tab",
    }).success,
    false
  )
})

test("MCP plugin app schemas reject unknown finite enum values", () => {
  assert.ok(
    PluginConfigFieldDefinitionSchema.shape.type.safeParse(
      PLUGIN_CONFIG_FIELD_TYPE.TEXT
    ).success
  )
  assert.equal(
    PluginConfigFieldDefinitionSchema.shape.type.safeParse("json").success,
    false
  )

  assert.ok(
    PluginInstallStepSchema.shape.kind.safeParse(
      PLUGIN_INSTALL_STEP_KIND.REUSE_SCOPE
    ).success
  )
  assert.equal(
    PluginInstallStepSchema.shape.kind.safeParse("attachment_scope").success,
    false
  )
  assert.ok(
    PluginInstallStepSchema.shape.scope.safeParse(
      PLUGIN_INSTALL_STEP_SCOPE.PLUGIN
    ).success
  )
  assert.equal(
    PluginInstallStepSchema.shape.scope.safeParse("global").success,
    false
  )

  assert.ok(
    PluginAuthValueSourceSchema.shape.source.safeParse(
      PLUGIN_AUTH_VALUE_SOURCE_KIND.DERIVED
    ).success
  )
  assert.equal(
    PluginAuthValueSourceSchema.shape.source.safeParse("secret_ref").success,
    false
  )
  assert.ok(
    PluginAuthValueSourceSchema.shape.name.safeParse(
      PLUGIN_AUTH_DERIVED_VALUE_NAME.OAUTH_CALLBACK_URL
    ).success
  )
  assert.equal(
    PluginAuthValueSourceSchema.shape.name.safeParse("redirect_uri").success,
    false
  )

  assert.ok(
    PluginAuthBindingDefinitionSchema.shape.driver.safeParse(
      PLUGIN_AUTH_BINDING_DRIVER_KIND.FEISHU_CLI_SETUP
    ).success
  )
  assert.equal(
    PluginAuthBindingDefinitionSchema.shape.driver.safeParse("device_code")
      .success,
    false
  )

  assert.ok(
    McpValidationRuleSchema.shape.rule.safeParse(
      MCP_VALIDATION_RULE_KIND.MIN_LENGTH
    ).success
  )
  assert.equal(
    McpValidationRuleSchema.shape.rule.safeParse("json_schema").success,
    false
  )

  assert.ok(
    PluginInstallationDetailViewSchema.shape.status.safeParse(
      PLUGIN_INSTALLATION_STATUS.ACTIVE
    ).success
  )
  assert.equal(
    PluginInstallationDetailViewSchema.shape.status.safeParse("deleted")
      .success,
    false
  )
  assert.ok(
    PluginInstallationDetailViewSchema.shape.sourceSyncMode.safeParse(
      MARKETPLACE_SYNC_MODE.FOLLOW_UPSTREAM
    ).success
  )
  assert.equal(
    PluginInstallationDetailViewSchema.shape.sourceSyncMode.safeParse("auto")
      .success,
    false
  )

  assert.ok(
    PluginAuthSessionViewSchema.shape.driver.safeParse(
      PLUGIN_AUTH_BINDING_DRIVER_KIND.OAUTH2_AUTHORIZATION_CODE_PKCE
    ).success
  )
  assert.equal(
    PluginAuthSessionViewSchema.shape.driver.safeParse("saml").success,
    false
  )
  assert.ok(
    PluginAuthSessionViewSchema.shape.status.safeParse(
      PLUGIN_AUTH_SESSION_STATUS.PENDING
    ).success
  )
  assert.equal(
    PluginAuthSessionViewSchema.shape.status.safeParse("waiting").success,
    false
  )
  assert.ok(
    PluginAuthSessionViewSchema.shape.phase.safeParse(
      PLUGIN_AUTH_SESSION_PHASE.PENDING_SCAN
    ).success
  )
  assert.equal(
    PluginAuthSessionViewSchema.shape.phase.safeParse("waiting_for_scan")
      .success,
    false
  )

  assert.ok(
    MarketplaceRequirementCheckSchema.shape.requirementKind.safeParse(
      MARKETPLACE_REQUIREMENT_KIND.REQUIRED
    ).success
  )
  assert.equal(
    MarketplaceRequirementCheckSchema.shape.requirementKind.safeParse("blocks")
      .success,
    false
  )
  assert.ok(
    MarketplaceRequirementCheckSchema.shape.status.safeParse(
      MARKETPLACE_REQUIREMENT_STATUS.CONFIG_INCOMPLETE
    ).success
  )
  assert.equal(
    MarketplaceRequirementCheckSchema.shape.status.safeParse("skipped").success,
    false
  )
})

test("StartPluginAuthInputSchema parses plugin-auth start requests", () => {
  assert.deepEqual(
    StartPluginAuthInputSchema.parse({
      installationId: uuid(),
      draftConfig: { account: "demo" },
      metadata: { source: "contract-test" },
    }).metadata,
    { source: "contract-test" }
  )
})

test("McpMarketplaceListQuerySchema parses app-facing filters", () => {
  assert.deepEqual(
    McpMarketplaceListQuerySchema.parse({
      search: " gateway ",
      tags: " smart-home, automation ,,",
      categories: [" devices ", "tooling"],
      transport: "http",
    }),
    {
      search: "gateway",
      tags: ["smart-home", "automation"],
      categories: ["devices", "tooling"],
      transport: "http",
    }
  )
  assert.equal(
    McpMarketplaceListQuerySchema.safeParse({ transport: "filesystem" })
      .success,
    false
  )
})

test("McpPluginInstallationListQuerySchema validates plugin filters", () => {
  const pluginId = uuid()
  assert.deepEqual(McpPluginInstallationListQuerySchema.parse({ pluginId }), {
    pluginId,
  })
  assert.equal(
    McpPluginInstallationListQuerySchema.safeParse({
      pluginId: "not-a-uuid",
    }).success,
    false
  )
})

test("MCP plugin audit query schemas parse typed filters", () => {
  const pluginId = uuid()
  const sessionId = uuid()
  const actorId = uuid()
  const before = "2026-06-14T00:00:00.000Z"

  assert.deepEqual(
    McpPluginToolCallAuditLogListQuerySchema.parse({
      pluginId,
      sessionId,
      actorId,
      limit: "25",
      before,
    }),
    {
      pluginId,
      sessionId,
      actorId,
      limit: 25,
      before,
    }
  )

  assert.deepEqual(
    McpPluginEventAuditLogListQuerySchema.parse({
      eventType: "plugin.auth",
      pluginId,
      limit: 50,
      before,
    }),
    {
      eventType: "plugin.auth",
      pluginId,
      limit: 50,
      before,
    }
  )
})

test("MCP plugin audit query schemas reject invalid app filters", () => {
  assert.equal(
    McpPluginToolCallAuditLogListQuerySchema.safeParse({
      sessionId: "not-a-uuid",
    }).success,
    false
  )
  assert.equal(
    McpPluginToolCallAuditLogListQuerySchema.safeParse({ limit: "0" }).success,
    false
  )
  assert.equal(
    McpPluginEventAuditLogListQuerySchema.safeParse({
      before: "yesterday",
    }).success,
    false
  )
})
