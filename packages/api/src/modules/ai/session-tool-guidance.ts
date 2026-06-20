type RequestUserInputDescriptionVariant =
  | { kind: "generic" }
  | { kind: "direct"; recipientLabel: string }
  | { kind: "group"; candidateDirectory: string }

type ReplyToRefGuidanceVariant = "direct" | "group"

function joinSentences(...sentences: string[]): string {
  return sentences.join(" ")
}

export function buildReplyToRefUsageGuidance(
  variant: ReplyToRefGuidanceVariant
): string {
  if (variant === "direct") {
    return joinSentences(
      "`replyToRef` is optional and should be used only when it adds clarity.",
      "In a direct conversation, if you are replying to the immediately preceding visible message and no other recent message could plausibly be the target, omit `replyToRef` by default.",
      "Use it when replying to an older message, when multiple recent messages or questions could be the target, when newer messages may have shifted the context, or when the explicit reply preview itself would be useful.",
      "Do not add `replyToRef` mechanically just because the XML shows message refs."
    )
  }

  return joinSentences(
    "`replyToRef` is for replying to a specific visible message or sub-thread in the group conversation.",
    "Use it when the reply target matters for routing or clarity.",
    "General group updates can omit it.",
    "Body mentions do not replace `replyToRef`."
  )
}

export function buildRequestUserInputToolDescription(
  variant: RequestUserInputDescriptionVariant
): string {
  const intro = ((): string => {
    switch (variant.kind) {
      case "direct":
        return `Request structured input from the single user in this direct conversation. The recipient is implicit: ${variant.recipientLabel}.`
      case "group":
        return `Request structured input from exactly one user in this conversation. \`targetParticipantId\` is required. Available \`targetParticipantId\` values: ${variant.candidateDirectory}.`
      default:
        return "Request structured input from one user in the current conversation. In direct conversations the target user is implicit; in group conversations you must provide `targetParticipantId`."
    }
  })()

  return joinSentences(
    intro,
    "Use this only for clarification, requirements, preferences, or choosing between meaningful approaches when the answer cannot be discovered from the repo or current context.",
    "Ask one to four short, specific questions that can materially change the work; prefer one.",
    "For choice questions, provide only meaningful options, put any recommended option first, and use `allowOther` instead of adding an `Other` option yourself.",
    "Do not use this tool for plan approval, status checks, or asking whether you should proceed."
  )
}

export function buildEnterPlanModeToolDescription(): string {
  return joinSentences(
    "Switch the current session into plan mode before a non-trivial implementation task.",
    "Use plan mode when you need read-only exploration, requirement clarification, or approach alignment before coding.",
    "Do not use it for pure research or code-reading tasks that do not need an implementation plan or approval."
  )
}

export function buildUpdatePlanToolDescription(): string {
  return joinSentences(
    "Replace the current plan checklist for this session.",
    "This tool only updates the checklist artifact for plan mode; it does not request approval or ask whether to proceed."
  )
}

type ExitPlanModeDescriptionVariant =
  | { kind: "direct"; recipientLabel: string }
  | { kind: "group"; candidateDirectory: string }
  | { kind: "generic" }

export function buildExitPlanModeToolDescription(
  variant: ExitPlanModeDescriptionVariant
): string {
  const intro = ((): string => {
    switch (variant.kind) {
      case "direct":
        return `Submit the completed implementation plan for approval by the single user in this direct conversation. The recipient is implicit: ${variant.recipientLabel}.`
      case "group":
        return `Submit the completed implementation plan for approval by exactly one user in this conversation. \`targetParticipantId\` is required. Available \`targetParticipantId\` values: ${variant.candidateDirectory}.`
      default:
        return "Submit the completed implementation plan for user approval. In direct conversations the target user is implicit; in group conversations you must provide `targetParticipantId`."
    }
  })()

  return joinSentences(
    intro,
    "Use this only after the plan is complete and remaining requirements or approach questions have been resolved.",
    "If you still need clarification or a decision between approaches, use `request_user_input` first.",
    "Do not ask for plan approval in plain text or through `request_user_input`; this tool is the approval request."
  )
}
