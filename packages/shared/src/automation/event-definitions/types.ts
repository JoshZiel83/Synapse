import type {
  AutomationEventProviderKind,
  AutomationIntegrationProvider,
  AutomationIntegrationTargetKind,
} from "../../types/index.js";

export interface AutomationEventSourceDefinitionContext {
  providerRef?: string;
  providerLabel?: string;
  integrationProvider?: AutomationIntegrationProvider;
  integrationTargetKind?: AutomationIntegrationTargetKind;
  integrationTargetId?: string;
  integrationTargetLabel?: string;
  metadata?: Record<string, unknown>;
}

export interface AutomationEventSourceTemplate {
  sourceKey: string;
  name: string;
  description: string;
  recommendedUsage?: string;
  payloadSchema: Record<string, unknown>;
  examplePayload: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface AutomationOccurrenceDisplayContext {
  sourceName?: string;
  providerRef?: string;
  sourceSnapshot: Record<string, unknown>;
  payload: Record<string, unknown>;
  occurredAt?: string;
}

export interface AutomationOccurrenceDisplay {
  title?: string;
  summary?: string;
  description?: string;
}

export interface AutomationEventDefinition<
  TContext extends AutomationEventSourceDefinitionContext = AutomationEventSourceDefinitionContext,
> {
  definitionKey: string;
  providerKind: AutomationEventProviderKind;
  integrationProvider?: AutomationIntegrationProvider;
  managementMode: "system" | "user";
  graceWindowMs?: number;
  buildSource: (context: TContext) => AutomationEventSourceTemplate;
  buildOccurrenceDisplay?: (
    context: AutomationOccurrenceDisplayContext,
  ) => AutomationOccurrenceDisplay;
}
