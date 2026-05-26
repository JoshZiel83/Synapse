import type {
  AutomationEventDefinition,
  AutomationOccurrenceDisplay,
  AutomationOccurrenceDisplayContext,
  AutomationEventSourceDefinitionContext,
  AutomationEventSourceTemplate,
} from "./types.js"
import {
  githubIssueCommentEventDefinition,
  githubPullRequestEventDefinition,
  githubPullRequestReviewEventDefinition,
  githubPushEventDefinition,
  githubWorkflowRunEventDefinition,
  gitlabMergeRequestEventDefinition,
  gitlabNoteEventDefinition,
  gitlabPipelineEventDefinition,
  gitlabPushEventDefinition,
  integrationEventDefinitions,
} from "./integrations.js"
import {
  deviceOfflineEventDefinition,
  deviceOnlineEventDefinition,
  deviceLifecycleEventDefinitions,
} from "./relay.js"

const automationEventDefinitions = [
  ...deviceLifecycleEventDefinitions,
  ...integrationEventDefinitions,
] satisfies readonly AutomationEventDefinition[]

export function listAutomationEventDefinitions(filters?: {
  providerKind?: AutomationEventDefinition["providerKind"]
  managementMode?: AutomationEventDefinition["managementMode"]
}) {
  return automationEventDefinitions.filter((definition) => {
    if (
      filters?.providerKind &&
      definition.providerKind !== filters.providerKind
    ) {
      return false
    }
    if (
      filters?.managementMode &&
      definition.managementMode !== filters.managementMode
    ) {
      return false
    }
    return true
  })
}

export function getAutomationEventDefinition(definitionKey: string) {
  return (
    automationEventDefinitions.find(
      (definition) => definition.definitionKey === definitionKey
    ) || null
  )
}

export function buildAutomationEventSourceTemplate(
  definitionKey: string,
  context: AutomationEventSourceDefinitionContext
): AutomationEventSourceTemplate {
  const definition = getAutomationEventDefinition(definitionKey)
  if (!definition) {
    throw new Error(`Unknown automation event definition: ${definitionKey}`)
  }
  return definition.buildSource(context)
}

export function buildAutomationOccurrenceDisplay(
  definitionKey: string,
  context: AutomationOccurrenceDisplayContext
): AutomationOccurrenceDisplay | null {
  const definition = getAutomationEventDefinition(definitionKey)
  if (!definition?.buildOccurrenceDisplay) {
    return null
  }
  return definition.buildOccurrenceDisplay(context)
}

export {
  githubIssueCommentEventDefinition,
  githubPullRequestEventDefinition,
  githubPullRequestReviewEventDefinition,
  githubPushEventDefinition,
  githubWorkflowRunEventDefinition,
  gitlabMergeRequestEventDefinition,
  gitlabNoteEventDefinition,
  gitlabPipelineEventDefinition,
  gitlabPushEventDefinition,
  integrationEventDefinitions,
  deviceOfflineEventDefinition,
  deviceOnlineEventDefinition,
  deviceLifecycleEventDefinitions,
}
export type {
  AutomationEventDefinition,
  AutomationOccurrenceDisplay,
  AutomationOccurrenceDisplayContext,
  AutomationEventSourceDefinitionContext,
  AutomationEventSourceTemplate,
}
