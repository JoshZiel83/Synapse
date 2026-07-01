import {
  AutomationEventSourceSchema,
  AutomationEventSourceListSchema,
  AutomationOccurrenceListSchema,
  AutomationRuleSchema,
  AutomationRuleListSchema,
  AutomationExecutionListSchema,
  AutomationSuccessSchema,
} from "@synapse/shared/schemas"
import { mock } from "../faker-setup"
import type { DesignHandlers } from "./_types"

// Automation: event sources + their occurrences, automation rules (CRUD), and
// rule executions. Lists feed the automation index pages; the single-rule and
// event-source views feed the detail/edit screens. DELETE routes return the
// shared `{ success }` envelope.
export const automationHandlers = {
  getAutomationEventSources: async () => mock(AutomationEventSourceListSchema),
  createAutomationEventSource: async () => mock(AutomationEventSourceSchema),
  updateAutomationEventSource: async () => mock(AutomationEventSourceSchema),
  archiveAutomationEventSource: async () => mock(AutomationSuccessSchema),
  getAutomationEventSourceOccurrences: async () =>
    mock(AutomationOccurrenceListSchema),
  getAutomations: async () => mock(AutomationRuleListSchema),
  // Re-enabled after the RC1 fix (b9647863): automationDeliverySchema.messageBlocks
  // now uses PersistedCanonicalContentBlockSchema (id required), matching
  // AutomationRule.delivery.messageBlocks[].id.
  getAutomation: async () => mock(AutomationRuleSchema),
  createAutomation: async () => mock(AutomationRuleSchema),
  updateAutomation: async () => mock(AutomationRuleSchema),
  deleteAutomation: async () => mock(AutomationSuccessSchema),
  getAutomationExecutions: async () => mock(AutomationExecutionListSchema),
} satisfies DesignHandlers
