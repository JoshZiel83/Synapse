import { PLAN_CHECKLIST_STEP_STATUSES } from "@synapse/shared"
import { assertIsoInstant } from "@synapse/shared/datetime"
import type {
  PlanChecklistStep,
  Session,
  SessionCollaborationState,
  SessionPlanDraftState,
} from "@synapse/shared/types"

const PLAN_CHECKLIST_STEP_STATUS_SET = new Set(PLAN_CHECKLIST_STEP_STATUSES)
const COLLABORATION_STATE_KEYS = new Set(["planDraft"])
const PLAN_DRAFT_KEYS = new Set([
  "summary",
  "checklist",
  "explanation",
  "enteredAt",
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function parsePlanChecklistStep(
  value: unknown,
  path: string
): PlanChecklistStep {
  if (!isRecord(value)) {
    throw new Error(`${path} must be an object`)
  }

  const step = typeof value.step === "string" ? value.step.trim() : ""
  if (!step) {
    throw new Error(`${path}.step is required`)
  }

  const status = typeof value.status === "string" ? value.status.trim() : ""
  if (!PLAN_CHECKLIST_STEP_STATUS_SET.has(status as any)) {
    throw new Error(`${path}.status is invalid`)
  }

  return {
    step,
    status: status as PlanChecklistStep["status"],
  }
}

function parsePlanDraftState(
  value: unknown,
  path: string
): SessionPlanDraftState {
  if (!isRecord(value)) {
    throw new Error(`${path} must be an object`)
  }

  for (const key of Object.keys(value)) {
    if (!PLAN_DRAFT_KEYS.has(key)) {
      throw new Error(`${path}.${key} is not allowed`)
    }
  }

  const checklistValue = value.checklist
  if (!Array.isArray(checklistValue)) {
    throw new Error(`${path}.checklist must be an array`)
  }

  const checklist = checklistValue.map((item, index) =>
    parsePlanChecklistStep(item, `${path}.checklist[${index}]`)
  )

  const summary =
    typeof value.summary === "string"
      ? value.summary.trim() || undefined
      : undefined
  const explanation =
    typeof value.explanation === "string"
      ? value.explanation.trim() || undefined
      : undefined
  let enteredAt: SessionPlanDraftState["enteredAt"]
  if (typeof value.enteredAt === "string") {
    const trimmedEnteredAt = value.enteredAt.trim()
    enteredAt = trimmedEnteredAt
      ? assertIsoInstant(trimmedEnteredAt)
      : undefined
  } else {
    enteredAt = undefined
  }

  return {
    summary,
    checklist,
    explanation,
    enteredAt,
  }
}

export function parseSessionCollaborationState(
  value: unknown
): SessionCollaborationState {
  if (!value) return {}
  if (!isRecord(value)) {
    throw new Error("collaborationState must be an object")
  }

  for (const key of Object.keys(value)) {
    if (!COLLABORATION_STATE_KEYS.has(key)) {
      throw new Error(`collaborationState.${key} is not allowed`)
    }
  }

  if (value.planDraft === undefined) {
    return {}
  }

  return {
    planDraft: parsePlanDraftState(
      value.planDraft,
      "collaborationState.planDraft"
    ),
  }
}

export function buildSessionPlanDraftState(params: {
  checklist: PlanChecklistStep[]
  summary?: string
  explanation?: string
  enteredAt?: string
}): SessionPlanDraftState {
  return {
    summary: params.summary?.trim() || undefined,
    checklist: params.checklist,
    explanation: params.explanation?.trim() || undefined,
    enteredAt: params.enteredAt?.trim()
      ? assertIsoInstant(params.enteredAt.trim())
      : undefined,
  }
}

export function requireSessionPlanDraftState(
  session: Pick<Session, "collaborationState" | "collaborationMode">
): SessionPlanDraftState {
  const draft = session.collaborationState.planDraft
  if (!draft) {
    throw new Error(
      `Session in ${session.collaborationMode} is missing collaborationState.planDraft`
    )
  }
  return draft
}
