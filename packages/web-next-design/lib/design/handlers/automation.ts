import {
  designAutomationRules,
  designEventSources,
  designOccurrences,
  buildRuleFromInput,
} from "../fixtures/automation"
import type { DesignHandlers } from "./_types"

// Automation: curated event sources + rules for the redesigned Automations
// surface (the random faker output rendered "Invalid Date" / garbage counts).
// Creates/updates echo a coherent rule; the sandbox is stateless so nothing
// persists across refetches — the authoring FLOW is what these back.
const ruleById = (id?: string) =>
  designAutomationRules.find((r) => r.id === id) ?? designAutomationRules[0]

export const automationHandlers = {
  getAutomationEventSources: async () => designEventSources,
  createAutomationEventSource: async () => designEventSources[0],
  updateAutomationEventSource: async () => designEventSources[0],
  archiveAutomationEventSource: async () => ({ success: true }),
  getAutomationEventSourceOccurrences: async (
    _wsId: string,
    sourceId: string
  ) => designOccurrences[sourceId] ?? [],
  getAutomations: async () => designAutomationRules,
  getAutomation: async (_wsId: string, id: string) => ruleById(id),
  createAutomation: async (
    _wsId: string,
    data: Parameters<typeof buildRuleFromInput>[0]
  ) => buildRuleFromInput(data),
  updateAutomation: async (_wsId: string, id: string) => ruleById(id),
  deleteAutomation: async () => ({ success: true }),
  getAutomationExecutions: async () => [],
} satisfies DesignHandlers
