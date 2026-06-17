import { z } from "zod"

export type ResolvedTaskAnswer = {
  readonly selectedOptionLabels?: unknown[]
  readonly text?: string
  readonly otherText?: string
}

export type ResolvedTaskQuestion = {
  readonly id?: string
  readonly title?: string
  readonly prompt?: string
  readonly answer?: ResolvedTaskAnswer
}

export type ResolvedTaskUserInput = {
  readonly title?: string
  readonly questions?: ResolvedTaskQuestion[]
}

export type ResolvedTaskPayload = {
  readonly conversationId?: string
  readonly kind?: string
  readonly lifecycleStatus?: string
  readonly outcome?: string
  readonly resolutionNote?: string
  readonly userInput?: ResolvedTaskUserInput
}

const stringField = z
  .unknown()
  .transform((value) => (typeof value === "string" ? value : undefined))

const answerSchema = z
  .object({
    selectedOptionLabels: z.array(z.unknown()).optional(),
    text: stringField,
    otherText: stringField,
  })
  .passthrough()

const questionSchema = z
  .object({
    id: stringField,
    title: stringField,
    prompt: stringField,
    answer: z.unknown().transform((value) => {
      const parsed = answerSchema.safeParse(value)
      return parsed.success ? parsed.data : undefined
    }),
  })
  .passthrough()

const userInputSchema = z
  .object({
    title: stringField,
    questions: z.unknown().transform((value) => {
      if (!Array.isArray(value)) return []
      return value.flatMap((question) => {
        const parsed = questionSchema.safeParse(question)
        return parsed.success ? [parsed.data] : []
      })
    }),
  })
  .passthrough()

const resolvedTaskPayloadSchema: z.ZodType<ResolvedTaskPayload> = z
  .object({
    conversationId: stringField,
    kind: stringField,
    lifecycleStatus: stringField,
    outcome: stringField,
    resolutionNote: stringField,
    userInput: z.unknown().transform((value) => {
      const parsed = userInputSchema.safeParse(value)
      return parsed.success ? parsed.data : undefined
    }),
  })
  .passthrough()

export function parseResolvedTaskPayload(raw: unknown): ResolvedTaskPayload {
  const parsed = resolvedTaskPayloadSchema.safeParse(raw)
  if (!parsed.success) return {}
  return parsed.data
}

export function buildResolvedUserInputPrompt(task: ResolvedTaskPayload) {
  const title = task.userInput?.title?.trim() || "User input"
  const questions = task.userInput?.questions ?? []
  const answerLines = questions
    .map((question) => {
      const prompt =
        question.prompt?.trim() ||
        question.title?.trim() ||
        question.id ||
        "Question"
      const labels = (question.answer?.selectedOptionLabels ?? []).filter(
        (value): value is string =>
          typeof value === "string" && value.trim().length > 0
      )
      const selected = labels.length > 0 ? labels.join(", ") : undefined
      const text = question.answer?.text?.trim() || undefined
      const otherText = question.answer?.otherText?.trim() || undefined
      const value = [selected, text, otherText].filter(Boolean).join(" | ")
      return value ? `- ${prompt}: ${value}` : null
    })
    .filter((line): line is string => Boolean(line))
  return [
    `The Synapse user answered your input request: ${title}.`,
    answerLines.length > 0
      ? answerLines.join("\n")
      : "Review the latest conversation state for the submitted answers.",
    "Continue the task using those answers.",
  ].join("\n")
}

export function buildAnswerMap(task: ResolvedTaskPayload) {
  const answers: Record<string, string> = {}
  const questions = task.userInput?.questions ?? []
  for (const question of questions) {
    const prompt = question.prompt
    if (!prompt) continue
    const answer = question.answer
    const parts = [
      ...(answer?.selectedOptionLabels ?? []).map((value) => String(value)),
      answer?.otherText,
      answer?.text,
    ].filter((value): value is string => Boolean(value))
    if (parts.length > 0) {
      answers[prompt] = parts.join(", ")
    }
  }
  return answers
}
