export function buildPlanApprovedPrompt(note?: string) {
  return [
    "The user approved your plan in Synapse.",
    note ? `Note from the user: ${note}` : "",
    "Continue with the approved work. Check messages first if needed, then proceed.",
  ]
    .filter(Boolean)
    .join(" ")
}

export function buildPlanRevisionPrompt(note?: string) {
  return [
    "The user asked you to revise your plan in Synapse.",
    note ? `Feedback: ${note}` : "",
    "Review the conversation history, update your plan, and request approval again when ready.",
  ]
    .filter(Boolean)
    .join(" ")
}

export function buildResolvedPlanTaskFallbackPrompt(
  task: Record<string, unknown>
): string | null {
  const kind = typeof task.kind === "string" ? task.kind : null
  if (kind !== "plan_approval") return null

  const outcome = typeof task.outcome === "string" ? task.outcome : null
  const note =
    typeof task.resolutionNote === "string" ? task.resolutionNote : undefined
  if (outcome === "approved") return buildPlanApprovedPrompt(note)
  if (outcome === "revision_requested") return buildPlanRevisionPrompt(note)
  return null
}
