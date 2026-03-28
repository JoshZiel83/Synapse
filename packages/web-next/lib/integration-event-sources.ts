import {
  listAutomationEventDefinitions,
} from "@synapse/shared/automation"
import type {
  AutomationIntegrationProvider,
  AutomationIntegrationTargetKind,
} from "@synapse/shared"
import { api } from "./api"

export type IntegrationInstallationView = {
  id: string
  org_slug?: string
  plugin_slug?: string
  plugin_display_name?: string
  status?: string
}

export type IntegrationEventDefinitionOption = {
  sourceKey: string
  provider: AutomationIntegrationProvider
  targetKind: AutomationIntegrationTargetKind
  name: string
  description: string
  recommendedUsage?: string
}

export function listIntegrationEventDefinitionOptions(
  provider: AutomationIntegrationProvider
): IntegrationEventDefinitionOption[] {
  return listAutomationEventDefinitions({ providerKind: "integration" })
    .filter((definition) => definition.integrationProvider === provider)
    .map((definition) => {
      const targetKind =
        provider === "github" ? "repository" : "project"
      const template = definition.buildSource({
        integrationProvider: provider,
        integrationTargetKind: targetKind,
        integrationTargetId: provider === "github" ? "owner/repo" : "group/project",
        integrationTargetLabel: provider === "github" ? "owner/repo" : "group/project",
        providerLabel: provider === "github" ? "owner/repo" : "group/project",
        providerRef: provider === "github" ? "owner/repo" : "group/project",
      })
      return {
        sourceKey: definition.definitionKey,
        provider,
        targetKind,
        name: template.name,
        description: template.description,
        recommendedUsage: template.recommendedUsage,
      }
    })
}

export function listIntegrationInstallations(
  installations: IntegrationInstallationView[],
  provider: AutomationIntegrationProvider
) {
  return installations.filter(
    (installation) =>
      installation.org_slug === provider &&
      installation.plugin_slug === "official-mcp" &&
      installation.status === "active"
  )
}

export async function createIntegrationEventSources(params: {
  workspaceId: string
  installationId: string
  provider: AutomationIntegrationProvider
  targetId: string
  targetLabel?: string
  sourceKeys: string[]
}) {
  const targetKind: AutomationIntegrationTargetKind =
    params.provider === "github" ? "repository" : "project"
  const targetLabel = params.targetLabel?.trim() || params.targetId.trim()

  const created = []
  for (const sourceKey of params.sourceKeys) {
    created.push(
      await api.createAutomationEventSource(params.workspaceId, {
        providerKind: "integration",
        sourceKey,
        integration: {
          installationId: params.installationId,
          provider: params.provider,
          ingressKind: "webhook",
          targetKind,
          targetId: params.targetId.trim(),
          targetLabel,
        },
      })
    )
  }
  return created
}
