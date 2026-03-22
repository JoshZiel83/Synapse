import type {
  AutomationEventDefinition,
  AutomationOccurrenceDisplay,
  AutomationOccurrenceDisplayContext,
  AutomationEventSourceDefinitionContext,
  AutomationEventSourceTemplate,
} from "./types.js";
import {
  relayDeviceOfflineEventDefinition,
  relayDeviceOnlineEventDefinition,
  relayLifecycleEventDefinitions,
} from "./relay.js";

const automationEventDefinitions =
  relayLifecycleEventDefinitions satisfies readonly AutomationEventDefinition[];

export function listAutomationEventDefinitions(filters?: {
  providerKind?: AutomationEventDefinition["providerKind"];
  managementMode?: AutomationEventDefinition["managementMode"];
}) {
  return automationEventDefinitions.filter((definition) => {
    if (filters?.providerKind && definition.providerKind !== filters.providerKind) {
      return false;
    }
    if (filters?.managementMode && definition.managementMode !== filters.managementMode) {
      return false;
    }
    return true;
  });
}

export function getAutomationEventDefinition(definitionKey: string) {
  return automationEventDefinitions.find((definition) => definition.definitionKey === definitionKey) || null;
}

export function buildAutomationEventSourceTemplate(
  definitionKey: string,
  context: AutomationEventSourceDefinitionContext,
): AutomationEventSourceTemplate {
  const definition = getAutomationEventDefinition(definitionKey);
  if (!definition) {
    throw new Error(`Unknown automation event definition: ${definitionKey}`);
  }
  return definition.buildSource(context);
}

export function buildAutomationOccurrenceDisplay(
  definitionKey: string,
  context: AutomationOccurrenceDisplayContext,
): AutomationOccurrenceDisplay | null {
  const definition = getAutomationEventDefinition(definitionKey);
  if (!definition?.buildOccurrenceDisplay) {
    return null;
  }
  return definition.buildOccurrenceDisplay(context);
}

export {
  relayDeviceOfflineEventDefinition,
  relayDeviceOnlineEventDefinition,
  relayLifecycleEventDefinitions,
};
export type {
  AutomationEventDefinition,
  AutomationOccurrenceDisplay,
  AutomationOccurrenceDisplayContext,
  AutomationEventSourceDefinitionContext,
  AutomationEventSourceTemplate,
};
