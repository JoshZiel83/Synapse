"use client"

import type { ComponentPropsWithoutRef } from "react"
import type {
  ActorRuntimeState,
  CanonicalContentBlock,
  ConversationEntityRef,
  ConversationMessageTransportContext,
  ConversationMessageTransportDelivery,
  InteractionRequestSummary,
  RelayAuthorizationScope,
} from "@synapse/shared"
import type { InteractionQuestionFieldAnswer } from "@synapse/shared/types"
import { useRouter } from "next/navigation"
import { useEffect, useMemo, useState } from "react"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { useIsMobile } from "@/hooks/use-mobile"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  GitBranch,
  Wrench,
  Search,
  Globe,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FileIcon,
  Download,
  AlertTriangle,
  AtSign,
  Expand,
  CheckCircle2,
  Clock3,
  FolderOpen,
  Loader2,
  MousePointerClick,
  RotateCcw,
  Shield,
  XCircle,
} from "lucide-react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { extractText } from "@synapse/shared"
import { runtimeToAvatarStatus } from "@/stores/chat-store"
import type { ServerToolCall } from "@/stores/chat-store"
import type { GroupMember } from "@/stores/chat-store"
import { cn, resolveFileUrl } from "@/lib/utils"
import ChatAvatar from "./chat-avatar"
import {
  formatTransportKindLabel,
  getAuthorContactHref,
  getGroupMemberSubtitle,
  resolveAuthorMember,
} from "./member-utils"
import ChatParticipantHoverCard from "./chat-participant-hover-card"
import {
  TablePreviewOverlay,
  type TablePreviewContent,
} from "./table-preview-overlay"

interface MessageBubbleProps {
  messageId: string
  role: string
  messageType?: string
  metadata?: Record<string, unknown>
  author?: ConversationEntityRef
  contentBlocks: CanonicalContentBlock[]
  actorName?: string
  actorAvatarUrl?: string
  actorEmoji?: string
  actorRole?: string
  actorRuntime?: ActorRuntimeState
  timestamp?: string
  isUser: boolean
  status?: "sending" | "retrying" | "sent"
  toolsUsed?: string[]
  serverToolCalls?: ServerToolCall[]
  citationSources?: Record<string, { url: string; title: string }>
  coordination?: boolean
  groupMembers?: GroupMember[]
  targetParticipantIds?: string[]
  transport?: ConversationMessageTransportContext
  transportDeliveries?: ConversationMessageTransportDelivery[]
  interaction?: InteractionRequestSummary
  enableTablePreview?: boolean
  viewerUserId?: string
  contactBasePath?: string
  retryPending?: boolean
  onParticipantClick?: (member: GroupMember) => void
  onRetryModelError?: (sessionId: string, itemId: string) => Promise<void> | void
  onResolveInteraction?: (
    interactionId: string,
    payload: {
      answers?: InteractionQuestionFieldAnswer[]
      selectedOptionId?: string
      decision?: "approve" | "reject"
      note?: string
    }
  ) => Promise<InteractionRequestSummary | void> | InteractionRequestSummary | void
}

function formatToolsUsed(tools: string[]): string {
  const counts = new Map<string, number>()
  for (const t of tools) {
    counts.set(t, (counts.get(t) || 0) + 1)
  }
  const entries = Array.from(counts.entries())
  const names = entries.map(([name, count]) =>
    count > 1 ? `${name} x${count}` : name
  )
  const total = tools.length
  if (names.length <= 3) {
    return `Used ${names.join(", ")} (${total} tool call${total > 1 ? "s" : ""})`
  }
  return `Used ${names.slice(0, 2).join(", ")} + ${names.length - 2} more (${total} tool call${total > 1 ? "s" : ""})`
}

function getRuntimeLabel(runtime?: ActorRuntimeState) {
  if (!runtime) return undefined
  if (runtime.health === "error" || runtime.laneState === "blocked")
    return "Error"
  if (runtime.laneState === "running") return "Working"
  if (runtime.laneState === "queued") return "Queued"
  return "Idle"
}

function getRuntimeDetail(runtime?: ActorRuntimeState) {
  if (!runtime) return undefined
  if (runtime.lastError?.message) return runtime.lastError.message
  if (
    runtime.laneState === "running" &&
    runtime.activeWakeups.some((wakeup) => wakeup.status === "attached")
  ) {
    return runtime.activeWakeups
      .filter((wakeup) => wakeup.status === "attached")
      .slice(0, 2)
      .map(
        (wakeup) => wakeup.sourceName || wakeup.sourceType.replace(/_/g, " ")
      )
      .join(", ")
  }
  if (runtime.statusText) return runtime.statusText
  if (runtime.pendingWakeupCount > 0) {
    return `${runtime.pendingWakeupCount} queued wakeup${runtime.pendingWakeupCount === 1 ? "" : "s"}`
  }
  return undefined
}

function getCompactMessagePreview(
  text: string,
  blocks: RenderedMessageBlock[]
) {
  const normalized = text.replace(/\s+/g, " ").trim()
  if (normalized) return normalized
  if (blocks.some((block) => block.type === "file_ref")) return "Attachment"
  return "Message"
}

function buildRenderedMessageBlocks(
  contentBlocks: CanonicalContentBlock[],
  citationSources?: Record<string, { url: string; title: string }>
): {
  blocks: RenderedMessageBlock[]
  sources: { num: number; url: string; title: string }[]
} {
  if (!citationSources || Object.keys(citationSources).length === 0) {
    return {
      blocks: contentBlocks.map((block) =>
        block.type === "text"
          ? {
              id: block.id,
              type: "text" as const,
              text: block.text.replace(/<br\s*\/?>/gi, "\n"),
            }
          : {
              id: block.id,
              type: "file_ref" as const,
              block,
            }
      ),
      sources: [],
    }
  }

  const usedSources: { num: number; url: string; title: string }[] = []
  const urlToNum = new Map<string, number>()

  function registerSource(source: { url: string; title: string }) {
    if (!urlToNum.has(source.url)) {
      const num = usedSources.length + 1
      urlToNum.set(source.url, num)
      usedSources.push({ num, url: source.url, title: source.title })
    }
    return urlToNum.get(source.url)!
  }

  const blocks = contentBlocks.map((block) => {
    if (block.type === "file_ref") {
      return {
        id: block.id,
        type: "file_ref" as const,
        block,
      }
    }

    const sanitized = block.text.replace(/<br\s*\/?>/gi, "\n")
    const processedText = sanitized.replace(
      /<cite\s+index="([^"]+)">([\s\S]*?)<\/cite>/g,
      (_match, indices: string, text: string) => {
        const indexList = indices.split(",").map((s: string) => s.trim())
        const refNums: number[] = []

        for (const idx of indexList) {
          const source = citationSources[idx] || citationSources[`cit-${idx}`]
          if (!source) continue
          refNums.push(registerSource(source))
        }

        if (refNums.length === 0) return text

        const unique = Array.from(new Set(refNums))
        const sup = unique.map((n) => `^[${n}]`).join("")
        return `${text}${sup}`
      }
    )

    return {
      id: block.id,
      type: "text" as const,
      text: processedText,
    }
  })

  for (const [key, source] of Object.entries(citationSources)) {
    if ((key.startsWith("cit-") || key.startsWith("oai-")) && !urlToNum.has(source.url)) {
      registerSource(source)
    }
  }

  return { blocks, sources: usedSources }
}

function CitationFooter({
  sources,
}: {
  sources: { num: number; url: string; title: string }[]
}) {
  if (sources.length === 0) return null

  return (
    <div className="mt-3 border-t border-gray-200 pt-2 dark:border-white/5">
      <div className="mb-1.5 text-[10px] font-medium text-muted-foreground/50">
        Sources
      </div>
      <div className="space-y-0.5">
        {sources.map((s) => (
          <a
            key={s.num}
            href={s.url}
            target="_blank"
            rel="noopener noreferrer"
            className="group/src flex items-start gap-1.5 text-[10px] text-muted-foreground/60 transition-colors hover:text-indigo-600 dark:hover:text-indigo-400"
          >
            <span className="w-3 shrink-0 text-right text-muted-foreground/40">
              {s.num}.
            </span>
            <ExternalLink className="mt-0.5 h-2.5 w-2.5 shrink-0 opacity-0 transition-opacity group-hover/src:opacity-100" />
            <span className="truncate">{s.title || s.url}</span>
          </a>
        ))}
      </div>
    </div>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatTransportStatusLabel(status: ConversationMessageTransportDelivery["deliveryStatus"]) {
  switch (status) {
    case "sent":
      return "sent"
    case "failed":
      return "failed"
    case "pending":
      return "pending"
    case "skipped":
      return "skipped"
    default:
      return status
  }
}

function getTransportBadgeClassName(
  status?: ConversationMessageTransportDelivery["deliveryStatus"]
) {
  switch (status) {
    case "failed":
      return "border-destructive/30 bg-destructive/10 text-destructive"
    case "pending":
      return "border-amber-500/30 bg-amber-500/10 text-amber-700"
    case "skipped":
      return "border-border bg-muted/40 text-muted-foreground"
    default:
      return "border-border bg-muted/30 text-muted-foreground"
  }
}

function TransportSummary({
  transport,
  transportDeliveries,
}: {
  transport?: ConversationMessageTransportContext
  transportDeliveries?: ConversationMessageTransportDelivery[]
}) {
  const inboundLabel =
    transport?.direction === "inbound" && transport.transportKind
      ? `via ${formatTransportKindLabel(transport.transportKind)}`
      : null
  const outboundDeliveries = (transportDeliveries || []).filter(
    (delivery) => delivery.direction === "outbound"
  )

  if (!inboundLabel && outboundDeliveries.length === 0) {
    return null
  }

  return (
    <>
      {inboundLabel ? (
        <Badge
          variant="outline"
          className="rounded-full border-border bg-muted/30 px-2 py-0 text-[10px] font-normal text-muted-foreground"
        >
          {inboundLabel}
        </Badge>
      ) : null}
      {outboundDeliveries.map((delivery) => {
        const transportLabel = formatTransportKindLabel(delivery.transportKind)
        return (
          <Badge
            key={delivery.linkId}
            variant="outline"
            className={`rounded-full px-2 py-0 text-[10px] font-normal ${getTransportBadgeClassName(delivery.deliveryStatus)}`}
          >
            {transportLabel} {formatTransportStatusLabel(delivery.deliveryStatus)}
          </Badge>
        )
      })}
    </>
  )
}

function getInteractionStatusLabel(
  status: InteractionRequestSummary["status"]
) {
  switch (status) {
    case "pending":
      return "Pending"
    case "answered":
      return "Answered"
    case "approved_pending_apply":
      return "Approved, applying"
    case "applied":
      return "Applied"
    case "rejected":
      return "Rejected"
    case "expired":
      return "Expired"
    case "apply_failed":
      return "Apply failed"
    default:
      return status
  }
}

function getInteractionStatusBadgeClassName(
  status: InteractionRequestSummary["status"]
) {
  switch (status) {
    case "answered":
    case "applied":
      return "border-emerald-500/25 bg-emerald-500/10 text-emerald-700"
    case "approved_pending_apply":
      return "border-sky-500/25 bg-sky-500/10 text-sky-700"
    case "rejected":
    case "apply_failed":
    case "expired":
      return "border-destructive/25 bg-destructive/10 text-destructive"
    default:
      return "border-amber-500/25 bg-amber-500/10 text-amber-700"
  }
}

function describeRelayAuthorizationScope(scope: RelayAuthorizationScope) {
  if (scope.capability === "filesystem") {
    const accessLabel =
      scope.access === "read_write"
        ? "read and write"
        : scope.access === "write"
          ? "write only"
          : "read only"
    return {
      icon: FolderOpen,
      summary: `${accessLabel} access`,
      detail: scope.path,
    }
  }

  return {
    icon: MousePointerClick,
    summary: "control access",
    detail: "Computer Use / CUA",
  }
}

type DraftQuestionAnswer = {
  selectedOptionIds: string[]
  otherText: string
  text: string
}

function buildDraftQuestionAnswers(
  interaction: InteractionRequestSummary
): Record<string, DraftQuestionAnswer> {
  if (interaction.kind !== "question_choice" || !interaction.question) {
    return {}
  }

  return Object.fromEntries(
    interaction.question.fields.map((field) => [
      field.id,
      {
        selectedOptionIds: [...(field.answer?.selectedOptionIds || [])],
        otherText: field.answer?.otherText || "",
        text: field.answer?.text || "",
      },
    ])
  )
}

function summarizeQuestionFieldAnswer(
  field: NonNullable<InteractionRequestSummary["question"]>["fields"][number]
) {
  const parts: string[] = []
  if (field.answer?.selectedOptionLabels?.length) {
    parts.push(field.answer.selectedOptionLabels.join(", "))
  }
  if (field.answer?.otherText) {
    parts.push(field.answer.otherText)
  }
  if (field.answer?.text) {
    parts.push(field.answer.text)
  }
  return parts.join(" | ")
}

function InteractionStatusNote({
  interaction,
  isTargetUser,
  viewerCanResolve,
}: {
  interaction: InteractionRequestSummary
  isTargetUser: boolean
  viewerCanResolve: boolean
}) {
  const targetName = interaction.target?.name || "the selected user"

  if (interaction.kind === "question_choice") {
    if (interaction.status === "pending") {
      return (
        <p className="text-xs text-muted-foreground">
          {isTargetUser
            ? "Only you can answer this question."
            : `Waiting for ${targetName} to answer.`}
        </p>
      )
    }
    if (interaction.status === "answered") {
      const fieldCount = interaction.question?.fields.length || 0
      const answerSummary =
        interaction.question?.fields
          .map((field) => {
            const summary = summarizeQuestionFieldAnswer(field)
            if (!summary) return ""
            return fieldCount > 1 ? `${field.label}: ${summary}` : summary
          })
          .filter((value) => value.length > 0)
          .join(" | ") || "a response"
      return (
        <p className="text-xs text-muted-foreground">
          {`${interaction.resolvedBy?.name || targetName} answered: ${answerSummary}.`}
        </p>
      )
    }
    return null
  }

  if (interaction.status === "pending") {
    return (
      <p className="text-xs text-muted-foreground">
        {viewerCanResolve
          ? "You can approve or reject this relay access request if you have relay authorization permission."
          : "Waiting for an authorized user to approve or reject."}
      </p>
    )
  }
  if (interaction.status === "approved_pending_apply") {
    return (
      <p className="text-xs text-muted-foreground">
        The relay is applying the approved runtime access now.
      </p>
    )
  }
  if (interaction.status === "applied") {
    return (
      <p className="text-xs text-muted-foreground">
        The relay accepted the grant and updated its local runtime policy.
      </p>
    )
  }
  if (interaction.status === "rejected") {
    return (
      <p className="text-xs text-muted-foreground">
        The authorization request was rejected.
      </p>
    )
  }
  if (interaction.status === "apply_failed") {
    return (
      <p className="text-xs text-destructive/80">
        {interaction.relayAuthorization?.applyError ||
          "The relay could not apply the approved authorization."}
      </p>
    )
  }
  if (interaction.status === "expired") {
    return (
      <p className="text-xs text-muted-foreground">
        This authorization request expired before it was resolved.
      </p>
    )
  }
  return null
}

function InteractionCard({
  interaction,
  viewerUserId,
  onResolveInteraction,
}: {
  interaction: InteractionRequestSummary
  viewerUserId?: string
  onResolveInteraction?: MessageBubbleProps["onResolveInteraction"]
}) {
  const [submittingAction, setSubmittingAction] = useState<string | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [draftAnswers, setDraftAnswers] = useState<Record<string, DraftQuestionAnswer>>(
    () => buildDraftQuestionAnswers(interaction)
  )

  const isTargetUser =
    interaction.target?.memberType === "user" &&
    Boolean(viewerUserId) &&
    interaction.target?.userId === viewerUserId
  const canResolveQuestion =
    interaction.kind === "question_choice" &&
    Boolean(onResolveInteraction) &&
    isTargetUser &&
    interaction.status === "pending"
  const canResolveRelayAuthorization =
    interaction.kind === "relay_authorization" &&
    Boolean(onResolveInteraction) &&
    interaction.viewerCanResolve === true &&
    interaction.status === "pending"
  const canResolve =
    canResolveQuestion || canResolveRelayAuthorization

  useEffect(() => {
    setSubmittingAction(null)
    setSubmitError(null)
    setDraftAnswers(buildDraftQuestionAnswers(interaction))
  }, [interaction.id, interaction.status])

  async function submitResolution(
    actionKey: string,
    payload: Parameters<NonNullable<MessageBubbleProps["onResolveInteraction"]>>[1]
  ) {
    if (!onResolveInteraction || !canResolve) return
    setSubmittingAction(actionKey)
    setSubmitError(null)
    try {
      await onResolveInteraction(interaction.id, payload)
    } catch (error) {
      setSubmitError(
        error instanceof Error ? error.message : "Failed to submit response."
      )
    } finally {
      setSubmittingAction(null)
    }
  }

  function updateDraftAnswer(
    fieldId: string,
    updater: (current: DraftQuestionAnswer) => DraftQuestionAnswer
  ) {
    setDraftAnswers((current) => {
      const existing = current[fieldId] || {
        selectedOptionIds: [],
        otherText: "",
        text: "",
      }
      return {
        ...current,
        [fieldId]: updater(existing),
      }
    })
  }

  function buildQuestionAnswerPayload() {
    if (interaction.kind !== "question_choice" || !interaction.question) {
      return []
    }

    return interaction.question.fields.map((field) => {
      const draft = draftAnswers[field.id] || {
        selectedOptionIds: [],
        otherText: "",
        text: "",
      }
      return {
        fieldId: field.id,
        selectedOptionIds:
          draft.selectedOptionIds.length > 0 ? draft.selectedOptionIds : undefined,
        otherText: draft.otherText.trim() || undefined,
        text: draft.text.trim() || undefined,
      }
    })
  }

  if (interaction.kind === "question_choice" && interaction.question) {
    const question = interaction.question
    const fields = question.fields
    const isSimpleSingleSelect =
      canResolve &&
      fields.length === 1 &&
      fields[0]?.type === "single_select" &&
      !fields[0]?.allowOther

    return (
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge
            variant="outline"
            className="rounded-full border-primary/20 bg-primary/5 text-primary"
          >
            <MousePointerClick className="mr-1 h-3 w-3" />
            Question
          </Badge>
          <Badge
            variant="outline"
            className={cn(
              "rounded-full",
              getInteractionStatusBadgeClassName(interaction.status)
            )}
          >
            {getInteractionStatusLabel(interaction.status)}
          </Badge>
        </div>

        <div className="space-y-1.5">
          <p className="text-sm font-medium leading-6 text-foreground">
            {question.prompt}
          </p>
          {question.instructions ? (
            <p className="text-xs leading-5 text-muted-foreground">
              {question.instructions}
            </p>
          ) : null}
        </div>

        <div className="space-y-3">
          {fields.map((field) => {
            const draft = draftAnswers[field.id] || {
              selectedOptionIds: [],
              otherText: "",
              text: "",
            }
            const selectedOptionIds = canResolve
              ? draft.selectedOptionIds
              : field.answer?.selectedOptionIds || []
            const fieldAnswerText = summarizeQuestionFieldAnswer(field)
            const shouldShowFieldHeading =
              fields.length > 1 || field.label !== question.prompt

            return (
              <div
                key={field.id}
                className="space-y-2 rounded-2xl border border-border/70 bg-muted/20 px-4 py-3"
              >
                {shouldShowFieldHeading ? (
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="text-sm font-medium text-foreground">
                        {field.label}
                      </div>
                      {field.required ? (
                        <Badge
                          variant="outline"
                          className="rounded-full border-border/70 bg-background/70 text-[10px] text-muted-foreground"
                        >
                          Required
                        </Badge>
                      ) : null}
                    </div>
                    {field.description ? (
                      <div className="text-xs text-muted-foreground">
                        {field.description}
                      </div>
                    ) : null}
                  </div>
                ) : null}

                {field.type === "text" ? (
                  canResolve ? (
                    <Textarea
                      value={draft.text}
                      onChange={(event) =>
                        updateDraftAnswer(field.id, (current) => ({
                          ...current,
                          text: event.target.value,
                        }))
                      }
                      placeholder={field.placeholder || "Type your answer"}
                      disabled={Boolean(submittingAction)}
                      className="min-h-24 resize-y rounded-2xl bg-background"
                    />
                  ) : fieldAnswerText ? (
                    <div className="rounded-xl border border-border/70 bg-background px-3 py-2 text-sm text-foreground whitespace-pre-wrap">
                      {fieldAnswerText}
                    </div>
                  ) : (
                    <div className="text-xs text-muted-foreground">
                      No response provided.
                    </div>
                  )
                ) : (
                  <div className="space-y-2">
                    {(field.options || []).map((option) => {
                      const isSelected = selectedOptionIds.includes(option.id)
                      const isSubmitting = submittingAction === `${field.id}:${option.id}`

                      if (canResolve && isSimpleSingleSelect) {
                        return (
                          <Button
                            key={option.id}
                            type="button"
                            variant={isSelected ? "default" : "outline"}
                            disabled={Boolean(submittingAction)}
                            onClick={() =>
                              void submitResolution(`${field.id}:${option.id}`, {
                                answers: [
                                  {
                                    fieldId: field.id,
                                    selectedOptionIds: [option.id],
                                  },
                                ],
                              })
                            }
                            className="h-auto w-full justify-start rounded-2xl px-4 py-3 text-left"
                          >
                            <div className="flex min-w-0 flex-1 items-start gap-3">
                              {isSubmitting ? (
                                <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin" />
                              ) : isSelected ? (
                                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                              ) : (
                                <div className="mt-1 h-2 w-2 shrink-0 rounded-full bg-current/40" />
                              )}
                              <div className="min-w-0">
                                <div className="whitespace-normal font-medium">
                                  {option.label}
                                </div>
                                {option.description ? (
                                  <div className="mt-1 whitespace-normal text-xs opacity-80">
                                    {option.description}
                                  </div>
                                ) : null}
                              </div>
                            </div>
                          </Button>
                        )
                      }

                      if (canResolve) {
                        return (
                          <button
                            key={option.id}
                            type="button"
                            disabled={Boolean(submittingAction)}
                            onClick={() =>
                              updateDraftAnswer(field.id, (current) => {
                                const hasOption = current.selectedOptionIds.includes(option.id)
                                if (field.type === "single_select") {
                                  return {
                                    ...current,
                                    selectedOptionIds: hasOption ? [] : [option.id],
                                    otherText: hasOption ? current.otherText : "",
                                  }
                                }
                                return {
                                  ...current,
                                  selectedOptionIds: hasOption
                                    ? current.selectedOptionIds.filter((id) => id !== option.id)
                                    : [...current.selectedOptionIds, option.id],
                                }
                              })
                            }
                            className={cn(
                              "flex w-full items-start gap-3 rounded-2xl border px-4 py-3 text-left transition-colors",
                              isSelected
                                ? "border-emerald-500/25 bg-emerald-500/10"
                                : "border-border/70 bg-background hover:bg-muted/30"
                            )}
                          >
                            {isSelected ? (
                              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                            ) : (
                              <div className="mt-1 h-2 w-2 shrink-0 rounded-full bg-muted-foreground/35" />
                            )}
                            <div className="min-w-0">
                              <div className="font-medium text-foreground">
                                {option.label}
                              </div>
                              {option.description ? (
                                <div className="mt-1 text-xs text-muted-foreground">
                                  {option.description}
                                </div>
                              ) : null}
                            </div>
                          </button>
                        )
                      }

                      return (
                        <div
                          key={option.id}
                          className={cn(
                            "rounded-2xl border px-4 py-3",
                            isSelected
                              ? "border-emerald-500/25 bg-emerald-500/10"
                              : "border-border/70 bg-background"
                          )}
                        >
                          <div className="flex items-start gap-3">
                            {isSelected ? (
                              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                            ) : (
                              <div className="mt-1 h-2 w-2 shrink-0 rounded-full bg-muted-foreground/35" />
                            )}
                            <div className="min-w-0">
                              <div className="font-medium text-foreground">
                                {option.label}
                              </div>
                              {option.description ? (
                                <div className="mt-1 text-xs text-muted-foreground">
                                  {option.description}
                                </div>
                              ) : null}
                            </div>
                          </div>
                        </div>
                      )
                    })}

                    {field.allowOther ? (
                      canResolve ? (
                        <div className="space-y-1">
                          <div className="text-xs font-medium text-muted-foreground">
                            {field.otherLabel || "Other"}
                          </div>
                          <Textarea
                            value={draft.otherText}
                            onChange={(event) =>
                              updateDraftAnswer(field.id, (current) => ({
                                ...current,
                                otherText: event.target.value,
                                selectedOptionIds:
                                  field.type === "single_select" && event.target.value.trim()
                                    ? []
                                    : current.selectedOptionIds,
                              }))
                            }
                            placeholder={field.otherPlaceholder || "Add another answer"}
                            disabled={Boolean(submittingAction)}
                            className="min-h-20 resize-y rounded-2xl bg-background"
                          />
                        </div>
                      ) : field.answer?.otherText ? (
                        <div className="rounded-xl border border-border/70 bg-background px-3 py-2 text-sm text-foreground whitespace-pre-wrap">
                          {`${field.otherLabel || "Other"}: ${field.answer.otherText}`}
                        </div>
                      ) : null
                    ) : null}

                    {!canResolve && !fieldAnswerText && !field.answer?.otherText ? (
                      <div className="text-xs text-muted-foreground">
                        No response provided.
                      </div>
                    ) : null}
                  </div>
                )}
              </div>
            )
          })}
        </div>

        {canResolve && !isSimpleSingleSelect ? (
          <div className="flex items-center gap-2">
            <Button
              type="button"
              disabled={Boolean(submittingAction)}
              onClick={() =>
                void submitResolution("submit_answers", {
                  answers: buildQuestionAnswerPayload(),
                })
              }
              className="rounded-full"
            >
              {submittingAction === "submit_answers" ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <CheckCircle2 className="mr-1 h-4 w-4" />
              )}
              Submit Response
            </Button>
          </div>
        ) : null}

        <InteractionStatusNote
          interaction={interaction}
          isTargetUser={Boolean(isTargetUser)}
          viewerCanResolve={canResolve}
        />
        {interaction.resolutionNote ? (
          <div className="rounded-xl border border-border/70 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
            {interaction.resolutionNote}
          </div>
        ) : null}
        {submitError ? (
          <div className="rounded-xl border border-destructive/20 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {submitError}
          </div>
        ) : null}
      </div>
    )
  }

  if (interaction.kind === "relay_authorization" && interaction.relayAuthorization) {
    const requestedScope = describeRelayAuthorizationScope(
      interaction.relayAuthorization.requestedScope
    )
    const approvedScope = interaction.relayAuthorization.approvedScope
      ? describeRelayAuthorizationScope(interaction.relayAuthorization.approvedScope)
      : null
    const ScopeIcon = requestedScope.icon
    const ApprovedScopeIcon = approvedScope?.icon

    return (
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge
            variant="outline"
            className="rounded-full border-primary/20 bg-primary/5 text-primary"
          >
            <Shield className="mr-1 h-3 w-3" />
            Relay Authorization
          </Badge>
          <Badge
            variant="outline"
            className={cn(
              "rounded-full",
              getInteractionStatusBadgeClassName(interaction.status)
            )}
          >
            {getInteractionStatusLabel(interaction.status)}
          </Badge>
        </div>

        <div className="space-y-1.5">
          <p className="text-sm font-medium leading-6 text-foreground">
            {`Grant ${interaction.relayAuthorization.relayToolName} access on ${interaction.relayAuthorization.deviceDisplayName}`}
          </p>
          <p className="text-xs leading-5 text-muted-foreground">
            {interaction.relayAuthorization.reason}
          </p>
        </div>

        <div className="grid gap-2">
          <div className="rounded-2xl border border-border/70 bg-muted/20 px-4 py-3">
            <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground/70">
              Exposure
            </div>
            <div className="mt-1 text-sm text-foreground">
              {interaction.relayAuthorization.exposureDisplayName}
            </div>
          </div>
          <div className="rounded-2xl border border-border/70 bg-muted/20 px-4 py-3">
            <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground/70">
              Requested Scope
            </div>
            <div className="mt-1 flex items-start gap-2 text-sm text-foreground">
              <ScopeIcon className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              <div className="min-w-0">
                <div>{requestedScope.summary}</div>
                <div className="mt-0.5 break-all text-xs text-muted-foreground">
                  {requestedScope.detail}
                </div>
              </div>
            </div>
          </div>
          <div className="rounded-2xl border border-border/70 bg-muted/20 px-4 py-3">
            <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground/70">
              Duration
            </div>
            <div className="mt-1 inline-flex items-center gap-2 text-sm text-foreground">
              <Clock3 className="h-4 w-4 text-primary" />
              <span>
                {interaction.relayAuthorization.duration === "persistent"
                  ? "Persistent until revoked"
                  : "Current relay session"}
              </span>
            </div>
          </div>
          {approvedScope ? (
            <div className="rounded-2xl border border-emerald-500/25 bg-emerald-500/10 px-4 py-3">
              <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-emerald-700/80">
                Approved Scope
              </div>
              <div className="mt-1 flex items-start gap-2 text-sm text-foreground">
                {ApprovedScopeIcon ? (
                  <ApprovedScopeIcon className="mt-0.5 h-4 w-4 shrink-0 text-emerald-700" />
                ) : null}
                <div className="min-w-0">
                  <div>{approvedScope.summary}</div>
                  <div className="mt-0.5 break-all text-xs text-muted-foreground">
                    {approvedScope.detail}
                  </div>
                </div>
              </div>
            </div>
          ) : null}
        </div>

        {canResolve ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              disabled={Boolean(submittingAction)}
              onClick={() =>
                void submitResolution("approve", { decision: "approve" })
              }
              className="rounded-full"
            >
              {submittingAction === "approve" ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <CheckCircle2 className="mr-1 h-4 w-4" />
              )}
              Approve
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={Boolean(submittingAction)}
              onClick={() =>
                void submitResolution("reject", { decision: "reject" })
              }
              className="rounded-full"
            >
              {submittingAction === "reject" ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <XCircle className="mr-1 h-4 w-4" />
              )}
              Reject
            </Button>
          </div>
        ) : null}

        <InteractionStatusNote
          interaction={interaction}
          isTargetUser={Boolean(isTargetUser)}
          viewerCanResolve={canResolve}
        />
        {interaction.resolutionNote ? (
          <div className="rounded-xl border border-border/70 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
            {interaction.resolutionNote}
          </div>
        ) : null}
        {submitError ? (
          <div className="rounded-xl border border-destructive/20 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {submitError}
          </div>
        ) : null}
      </div>
    )
  }

  return null
}

type MessageRecipient = Pick<
  GroupMember,
  | "id"
  | "participantId"
  | "type"
  | "name"
  | "title"
  | "role"
  | "emoji"
  | "avatarUrl"
  | "linkedUserName"
> & {
  member?: GroupMember
}

type FileRefBlock = Extract<CanonicalContentBlock, { type: "file_ref" }>
type RenderedMessageBlock =
  | {
      id: string
      type: "text"
      text: string
    }
  | {
      id: string
      type: "file_ref"
      block: FileRefBlock
    }

const AUDIO_EXTENSIONS = [
  ".wav",
  ".mp3",
  ".ogg",
  ".m4a",
  ".flac",
  ".aac",
  ".wma",
]

function resolveRecipients(
  groupMembers: GroupMember[] | undefined,
  targetParticipantIds: string[] | undefined
) {
  const participantIds = Array.from(new Set(targetParticipantIds || []))
  const memberMap = new Map<string, GroupMember>()

  for (const member of groupMembers || []) {
    memberMap.set(member.participantId || member.memberId, member)
  }

  return participantIds.map((participantId) => {
    const member = memberMap.get(participantId)
    return {
      participantId,
      id: member?.id || participantId,
      type: member?.type || "external",
      name: member?.name || "Unknown recipient",
      title: member?.title,
      role: member?.role,
      emoji: member?.emoji,
      avatarUrl: member?.avatarUrl,
      linkedUserName: member?.linkedUserName,
      member,
    } satisfies MessageRecipient
  })
}

function RecipientChip({
  recipient,
  onClick,
  isMobile,
  contactBasePath,
}: {
  recipient: MessageRecipient
  onClick?: (member: GroupMember) => void
  isMobile: boolean
  contactBasePath?: string
}) {
  const trigger = recipient.member && onClick ? (
    <button
      type="button"
      onClick={() => onClick(recipient.member!)}
      className="cursor-pointer text-foreground/70 transition-colors hover:text-foreground"
    >
      @{recipient.name}
    </button>
  ) : (
    <span className="cursor-help text-foreground/70 transition-colors hover:text-foreground">
      @{recipient.name}
    </span>
  )

  if (recipient.member && !isMobile) {
    return (
      <ChatParticipantHoverCard
        member={recipient.member}
        contactBasePath={contactBasePath}
      >
        <span
          className="cursor-help text-foreground/70 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
          tabIndex={0}
        >
          @{recipient.name}
        </span>
      </ChatParticipantHoverCard>
    )
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {trigger}
      </TooltipTrigger>
      <TooltipContent
        side="top"
        className="flex max-w-64 items-start gap-2 px-3 py-2"
      >
        <ChatAvatar
          name={recipient.name}
          avatarUrl={recipient.avatarUrl}
          emoji={recipient.emoji}
          entityType={recipient.type}
          size="sm"
          className="shrink-0"
        />
        <div className="min-w-0">
          <div className="font-medium">{recipient.name}</div>
          <div className="text-background/80">
            {recipient.type === "actor"
              ? recipient.title || recipient.role || "Actor"
              : recipient.type === "external"
                ? recipient.linkedUserName
                  ? `External participant · linked to ${recipient.linkedUserName}`
                  : "External participant"
                : "User"}
          </div>
        </div>
      </TooltipContent>
    </Tooltip>
  )
}

function RecipientSummary({
  recipients,
  hasExplicitTargets,
  onRecipientClick,
  isMobile,
  contactBasePath,
}: {
  recipients: MessageRecipient[]
  hasExplicitTargets: boolean
  onRecipientClick?: (member: GroupMember) => void
  isMobile: boolean
  contactBasePath?: string
}) {
  if (!hasExplicitTargets) {
    return (
      <span className="text-[10px] text-muted-foreground/45">
        To all members
      </span>
    )
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-1 text-[10px] text-muted-foreground/45">
      <span>To</span>
      {recipients.map((recipient) => (
        <RecipientChip
          key={`${recipient.type}:${recipient.id}`}
          recipient={recipient}
          onClick={onRecipientClick}
          isMobile={isMobile}
          contactBasePath={contactBasePath}
        />
      ))}
    </span>
  )
}

function FileBlockPreview({ blocks }: { blocks: FileRefBlock[] }) {
  const [expandedImage, setExpandedImage] = useState<string | null>(null)

  if (blocks.length === 0) return null

  return (
    <>
      <div className="space-y-2">
        {blocks.map((block) => {
          const cat = block.category
          const resolvedUrl = resolveFileUrl(block.url) || block.url

          if (cat === "image") {
            return (
              <div key={block.fileId}>
                <img
                  src={resolvedUrl}
                  alt={block.originalName}
                  className="max-h-64 max-w-full cursor-pointer rounded-lg transition-opacity hover:opacity-90"
                  onClick={() => setExpandedImage(resolvedUrl)}
                />
              </div>
            )
          }

          if (cat === "audio") {
            return (
              <div
                key={block.fileId}
                className="rounded-lg bg-gray-50 p-2.5 ring-1 ring-gray-200 dark:bg-white/[0.03] dark:ring-white/[0.06]"
              >
                <div className="mb-1.5 truncate text-[11px] text-muted-foreground">
                  {block.originalName}
                </div>
                <audio controls className="h-8 w-full" preload="metadata">
                  <source src={resolvedUrl} type={block.mimeType} />
                </audio>
              </div>
            )
          }

          if (cat === "video") {
            return (
              <div key={block.fileId}>
                <video
                  controls
                  className="max-h-64 max-w-full rounded-lg"
                  preload="metadata"
                >
                  <source src={resolvedUrl} type={block.mimeType} />
                </video>
              </div>
            )
          }

          // Document
          return (
            <a
              key={block.fileId}
              href={resolvedUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="group/file flex items-center gap-2.5 rounded-lg bg-gray-50 p-2.5 ring-1 ring-gray-200 transition-colors hover:bg-gray-100 dark:bg-white/[0.03] dark:ring-white/[0.06] dark:hover:bg-white/[0.06]"
            >
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-indigo-500/10">
                <FileIcon className="h-4 w-4 text-indigo-500" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs text-foreground/80">
                  {block.originalName}
                </div>
                <div className="text-[10px] text-muted-foreground/50">
                  {formatBytes(block.sizeBytes)}
                </div>
              </div>
              <Download className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40 transition-colors group-hover/file:text-indigo-500" />
            </a>
          )
        })}
      </div>

      {/* Image lightbox */}
      {expandedImage && (
        <div
          className="fixed inset-0 z-50 flex cursor-pointer items-center justify-center bg-black/80 p-4"
          onClick={() => setExpandedImage(null)}
        >
          <img
            src={expandedImage}
            alt="Expanded"
            className="max-h-full max-w-full rounded-lg object-contain"
          />
        </div>
      )}
    </>
  )
}

function MarkdownTextBlock({
  text,
  enableTablePreview,
}: {
  text: string
  enableTablePreview: boolean
}) {
  const [expandedTable, setExpandedTable] = useState<TablePreviewContent | null>(
    null
  )

  function openTablePreview(table: TablePreviewContent) {
    setExpandedTable(table)
  }

  if (!text) return null

  return (
    <>
      <div className="prose prose-sm max-w-full min-w-0 break-words prose-p:my-1.5 prose-headings:text-foreground prose-code:rounded prose-code:bg-primary/10 prose-code:px-1.5 prose-code:py-0.5 prose-code:text-xs prose-code:text-primary prose-code:before:content-none prose-code:after:content-none prose-pre:rounded-2xl prose-pre:border prose-pre:border-border prose-pre:bg-muted prose-strong:text-foreground dark:prose-invert [&_a]:break-words [&_a]:[overflow-wrap:anywhere] [&_code]:break-words [&_code]:[overflow-wrap:anywhere] [&_li]:[overflow-wrap:anywhere] [&_p]:[overflow-wrap:anywhere] [&_pre]:max-w-full [&_pre]:overflow-x-auto">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            img: ({ src, alt, ...props }) => (
              <ExpandableImage src={src} alt={alt} {...props} />
            ),
            a: ({ href, children, ...props }) => {
              const isAudio =
                href &&
                AUDIO_EXTENSIONS.some((ext) => href.toLowerCase().endsWith(ext))

              if (isAudio) {
                return (
                  <span className="my-2 block">
                    <audio controls className="h-8 w-full" preload="metadata">
                      <source src={href} />
                    </audio>
                    <span className="mt-0.5 block text-[10px] text-muted-foreground/50">
                      {String(children) || href}
                    </span>
                  </span>
                )
              }

              return (
                <a
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline"
                  {...props}
                >
                  {children}
                </a>
              )
            },
            table: ({ className, children, ...props }) => (
              <div className="group relative my-2 w-full max-w-full">
                <div
                  role={enableTablePreview ? "button" : undefined}
                  tabIndex={enableTablePreview ? 0 : undefined}
                  className={cn(
                    "w-full max-w-full overflow-x-auto rounded-2xl border border-border/70 bg-muted/30",
                    enableTablePreview &&
                      "cursor-zoom-in focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
                  )}
                  onClick={
                    enableTablePreview
                      ? () => openTablePreview({ className, children })
                      : undefined
                  }
                  onKeyDown={
                    enableTablePreview
                      ? (event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault()
                            openTablePreview({ className, children })
                          }
                        }
                      : undefined
                  }
                >
                  <table
                    className={cn(
                      "w-max min-w-full border-collapse text-sm",
                      className
                    )}
                    {...props}
                  >
                    {children}
                  </table>
                </div>
                {enableTablePreview ? (
                  <div className="pointer-events-none absolute inset-x-3 top-3 flex justify-end lg:hidden">
                    <span className="inline-flex items-center gap-1 rounded-full bg-background/92 px-2 py-1 text-[10px] font-medium text-foreground shadow-sm ring-1 ring-border/70">
                      <Expand className="size-3" />
                      Expand
                    </span>
                  </div>
                ) : null}
              </div>
            ),
            thead: ({ className, ...props }) => (
              <thead className={cn("bg-muted/40", className)} {...props} />
            ),
            tbody: ({ className, ...props }) => (
              <tbody
                className={cn("[&_tr:last-child_td]:border-b-0", className)}
                {...props}
              />
            ),
            tr: ({ className, ...props }) => (
              <tr
                className={cn("border-b border-border/70", className)}
                {...props}
              />
            ),
            th: ({ className, ...props }) => (
              <th
                className={cn(
                  "min-w-[7rem] border-b border-border/70 px-3 py-2 text-left align-top font-medium text-foreground whitespace-nowrap",
                  className
                )}
                {...props}
              />
            ),
            td: ({ className, ...props }) => (
              <td
                className={cn(
                  "min-w-[7rem] border-b border-border/70 px-3 py-2 align-top break-words [overflow-wrap:anywhere]",
                  className
                )}
                {...props}
              />
            ),
            code: ({
              className,
              children,
              ...props
            }: ComponentPropsWithoutRef<"code">) => (
              <code
                className={cn(
                  className,
                  "break-words [overflow-wrap:anywhere]"
                )}
                {...props}
              >
                {children}
              </code>
            ),
          }}
        >
          {text}
        </ReactMarkdown>
      </div>

      {enableTablePreview && expandedTable ? (
        <TablePreviewOverlay
          table={expandedTable}
          onClose={() => setExpandedTable(null)}
        />
      ) : null}
    </>
  )
}

function MessageContentBlocks({
  blocks,
  isUser,
  enableTablePreview,
}: {
  blocks: RenderedMessageBlock[]
  isUser: boolean
  enableTablePreview: boolean
}) {
  if (blocks.length === 0) return null

  return (
    <div className="min-w-0 max-w-full space-y-2">
      {blocks.map((block) =>
        block.type === "file_ref" ? (
          <FileBlockPreview key={block.id} blocks={[block.block]} />
        ) : isUser ? (
          block.text ? (
            <p
              key={block.id}
              className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]"
            >
              {block.text}
            </p>
          ) : null
        ) : (
          <MarkdownTextBlock
            key={block.id}
            text={block.text}
            enableTablePreview={enableTablePreview}
          />
        )
      )}
    </div>
  )
}

function ExpandableImage({
  src,
  alt,
  ...props
}: ComponentPropsWithoutRef<"img">) {
  const [expanded, setExpanded] = useState(false)
  return (
    <>
      <img
        src={src}
        alt={alt || ""}
        className="my-2 max-h-64 max-w-full cursor-pointer rounded-lg transition-opacity hover:opacity-90"
        onClick={() => setExpanded(true)}
        {...props}
      />
      {expanded && (
        <div
          className="fixed inset-0 z-50 flex cursor-pointer items-center justify-center bg-black/80 p-4"
          onClick={() => setExpanded(false)}
        >
          <img
            src={src}
            alt={alt || ""}
            className="max-h-full max-w-full rounded-lg object-contain"
          />
        </div>
      )}
    </>
  )
}

function ServerToolCallDisplay({ calls }: { calls: ServerToolCall[] }) {
  const [expanded, setExpanded] = useState(false)

  if (calls.length === 0) return null

  const searchCalls = calls.filter((c) => c.type === "web_search")
  const fetchCalls = calls.filter((c) => c.type === "web_fetch")
  const totalResults = searchCalls.reduce(
    (sum, c) => sum + (c.results?.length || 0),
    0
  )

  // Compact summary line
  const parts: string[] = []
  if (searchCalls.length > 0) {
    parts.push(
      `${searchCalls.length} search${searchCalls.length > 1 ? "es" : ""}`
    )
  }
  if (fetchCalls.length > 0) {
    parts.push(`${fetchCalls.length} fetch${fetchCalls.length > 1 ? "es" : ""}`)
  }

  return (
    <div className="mt-2 border-t border-gray-200 pt-2 dark:border-white/5">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-1.5 text-left text-[11px] text-muted-foreground/70 transition-colors hover:text-muted-foreground"
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3" />
        ) : (
          <ChevronRight className="h-3 w-3" />
        )}
        <span className="font-medium">
          {parts.join(", ")}
          {totalResults > 0 &&
            ` · ${totalResults} result${totalResults > 1 ? "s" : ""}`}
        </span>
      </button>

      {expanded && (
        <div className="mt-2 space-y-2">
          {searchCalls.map((call, i) => (
            <div
              key={`search-${i}`}
              className="rounded-lg bg-gray-50 p-2.5 ring-1 ring-gray-200 dark:bg-white/[0.03] dark:ring-white/[0.06]"
            >
              <div className="flex items-center gap-1.5 text-[11px] text-indigo-600 dark:text-indigo-400/80">
                <Search className="h-3 w-3" />
                <span className="font-medium">Web Search</span>
              </div>
              {call.query && (
                <p className="mt-1 rounded bg-white/[0.03] px-2 py-1 font-mono text-[11px] text-foreground/80">
                  {call.query}
                </p>
              )}
              {call.results && call.results.length > 0 && (
                <div className="mt-1.5 space-y-1">
                  {call.results.slice(0, 5).map((r, j) => (
                    <a
                      key={j}
                      href={r.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="group/link flex items-start gap-1.5 text-[10px] text-muted-foreground/60 transition-colors hover:text-indigo-600 dark:hover:text-indigo-400"
                    >
                      <ExternalLink className="mt-0.5 h-2.5 w-2.5 shrink-0 opacity-0 transition-opacity group-hover/link:opacity-100" />
                      <span className="truncate">
                        <span className="text-foreground/60 group-hover/link:text-indigo-500">
                          {r.title || r.url}
                        </span>
                        {r.pageAge && (
                          <span className="ml-1 text-muted-foreground/40">
                            · {r.pageAge}
                          </span>
                        )}
                      </span>
                    </a>
                  ))}
                  {call.results.length > 5 && (
                    <span className="ml-4 text-[10px] text-muted-foreground/40">
                      +{call.results.length - 5} more results
                    </span>
                  )}
                </div>
              )}
            </div>
          ))}

          {fetchCalls.map((call, i) => (
            <div
              key={`fetch-${i}`}
              className="rounded-lg bg-gray-50 p-2.5 ring-1 ring-gray-200 dark:bg-white/[0.03] dark:ring-white/[0.06]"
            >
              <div className="flex items-center gap-1.5 text-[11px] text-emerald-400/80">
                <Globe className="h-3 w-3" />
                <span className="font-medium">Web Fetch</span>
              </div>
              {call.url && (
                <a
                  href={call.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-1 block truncate text-[10px] text-muted-foreground/60 transition-colors hover:text-emerald-400"
                >
                  {call.url}
                </a>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default function MessageBubble({
  messageId,
  role,
  messageType,
  metadata,
  author,
  contentBlocks,
  actorName,
  actorAvatarUrl,
  actorEmoji,
  actorRole,
  actorRuntime,
  timestamp,
  isUser,
  status,
  toolsUsed,
  serverToolCalls,
  citationSources,
  coordination,
  groupMembers,
  targetParticipantIds,
  transport,
  transportDeliveries,
  interaction,
  enableTablePreview = false,
  viewerUserId,
  contactBasePath = "/dashboard/contacts",
  retryPending = false,
  onParticipantClick,
  onRetryModelError,
  onResolveInteraction,
}: MessageBubbleProps) {
  const router = useRouter()
  const isMobile = useIsMobile()
  const isChildResult = role === "child_result"
  const isSystem = role === "system"
  const isError = role === "error"
  const textContent = useMemo(() => extractText(contentBlocks), [contentBlocks])
  const recipients = useMemo(
    () => resolveRecipients(groupMembers, targetParticipantIds),
    [groupMembers, targetParticipantIds]
  )
  const hasExplicitTargets = (targetParticipantIds?.length || 0) > 0
  const viewerUserMember = useMemo(() => {
    if (!viewerUserId) return undefined
    return groupMembers?.find(
      (member) => member.type === "user" && member.id === viewerUserId
    )
  }, [groupMembers, viewerUserId])
  const authorMember = useMemo(
    () => resolveAuthorMember(author, groupMembers),
    [author, groupMembers]
  )
  const authorContactHref = useMemo(
    () => getAuthorContactHref(author, groupMembers, contactBasePath),
    [author, contactBasePath, groupMembers]
  )
  const canOpenAuthorDetails = Boolean(isMobile && authorMember && onParticipantClick)
  const authorEntityType = useMemo(() => {
    if (author?.memberType === "external") return "external" as const
    if (author?.memberType === "user") return "user" as const
    return "actor" as const
  }, [author?.memberType])
  const resolvedAuthorName = useMemo(() => {
    if (author?.memberType === "user") {
      if (author.userId && author.userId === viewerUserId) return "You"
      return author.name || authorMember?.name || "User"
    }
    if (author?.memberType === "external") {
      return author.name || authorMember?.name || "External participant"
    }
    if (author?.memberType === "actor") {
      return author.name || actorName || authorMember?.name || "Actor"
    }
    return actorName || (isUser ? "You" : "Member")
  }, [actorName, author, authorMember, isUser, viewerUserId])
  const resolvedAuthorAvatarUrl =
    authorEntityType === "actor"
      ? actorAvatarUrl || author?.avatarUrl || authorMember?.avatarUrl
      : authorMember?.avatarUrl || author?.avatarUrl
  const resolvedAuthorEmoji =
    authorEntityType === "actor"
      ? actorEmoji || author?.avatarEmoji || authorMember?.emoji
      : authorMember?.emoji || author?.avatarEmoji
  const resolvedAuthorSubtitle = useMemo(() => {
    if (author?.memberType === "actor") {
      return actorRole || author?.title || author?.role || authorMember?.title || authorMember?.role || "Actor"
    }
    if (author?.memberType === "external") {
      return authorMember
        ? getGroupMemberSubtitle(authorMember)
        : "External participant"
    }
    if (author?.memberType === "user") {
      return author.userId && author.userId === viewerUserId ? "You" : "Workspace user"
    }
    return undefined
  }, [actorRole, author, authorMember, viewerUserId])

  const { blocks: renderedBlocks, sources } = useMemo(
    () => buildRenderedMessageBlocks(contentBlocks, citationSources),
    [citationSources, contentBlocks]
  )
  const [compactExpanded, setCompactExpanded] = useState(false)
  const compactPreview = useMemo(
    () => getCompactMessagePreview(textContent, renderedBlocks),
    [renderedBlocks, textContent]
  )

  if (isError) {
    return (
      <div className="flex w-full min-w-0 max-w-full gap-3">
        <div className="text-destructive-foreground mt-1 flex size-8 shrink-0 items-center justify-center rounded-2xl bg-destructive shadow-sm">
          <AlertTriangle className="h-4 w-4 text-white" />
        </div>
        <div className="flex w-full max-w-[75%] min-w-0 flex-col items-start">
          <div className="rounded-3xl rounded-tl-sm border border-destructive/20 bg-destructive/10 px-4 py-3 text-sm leading-relaxed text-destructive shadow-sm">
            <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
              {textContent}
            </p>
          </div>
          {timestamp && (
            <span className="mt-1 text-[10px] text-muted-foreground/50">
              {new Date(timestamp).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
          )}
        </div>
      </div>
    )
  }

  if (isSystem && !interaction) {
    return (
      <div className="my-2 flex w-full min-w-0 max-w-full justify-center">
        <div className="max-w-[80%] text-center text-xs text-muted-foreground/75">
          {textContent.length > 200
            ? textContent.substring(0, 200) + "..."
            : textContent}
        </div>
      </div>
    )
  }

  const hasServerToolCalls = serverToolCalls && serverToolCalls.length > 0
  const hasToolsUsed = toolsUsed && toolsUsed.length > 0
  const hasCitations = sources.length > 0
  const isRetrying = isUser && status === "retrying"
  const viewerParticipantId = useMemo(
    () => viewerUserMember?.participantId,
    [viewerUserMember]
  )
  const isDirectToViewer = Boolean(
    viewerParticipantId && targetParticipantIds?.includes(viewerParticipantId)
  )
  const retrySessionId =
    typeof metadata?.retrySessionId === "string"
      ? metadata.retrySessionId
      : undefined
  const canRetryModelError = Boolean(
    messageType === "model_error_notice" &&
      retrySessionId &&
      viewerParticipantId &&
      targetParticipantIds?.includes(viewerParticipantId) &&
      onRetryModelError
  )
  const shouldRenderCompact =
    !interaction &&
    !isUser &&
    (coordination || (hasExplicitTargets && !isDirectToViewer))

  // Non-direct actor traffic stays compact so the main thread focuses on viewer-facing messages.
  if (shouldRenderCompact) {
    return (
      <div className="ml-10 flex w-[calc(100%-2.5rem)] min-w-0 max-w-full gap-2 opacity-70">
        <div className="flex w-full max-w-[70%] min-w-0 items-start gap-2">
          <AtSign className="mt-1 h-3 w-3 shrink-0 text-primary/60" />
          <div className="min-w-0 flex-1">
            <div className="flex items-start gap-1.5 text-xs text-muted-foreground/70">
              <div className="min-w-0 flex-1">
                {compactExpanded ? (
                  <div className="mb-0.5 flex flex-wrap items-center gap-1.5">
                    {authorMember && !isMobile ? (
                      <ChatParticipantHoverCard
                        member={authorMember}
                        contactBasePath={contactBasePath}
                      >
                        <span
                          className="text-[11px] font-medium text-muted-foreground/80 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
                          tabIndex={0}
                        >
                          {resolvedAuthorName}
                        </span>
                      </ChatParticipantHoverCard>
                    ) : canOpenAuthorDetails ? (
                      <button
                        type="button"
                        onClick={() => onParticipantClick?.(authorMember!)}
                        className="text-[11px] font-medium text-muted-foreground/80 transition-colors hover:text-foreground"
                      >
                        {resolvedAuthorName}
                      </button>
                    ) : (
                      <span className="text-[11px] font-medium text-muted-foreground/80">
                        {resolvedAuthorName}
                      </span>
                    )}
                    {resolvedAuthorSubtitle ? (
                      <span className="text-[10px] text-muted-foreground/55">
                        {resolvedAuthorSubtitle}
                      </span>
                    ) : null}
                  </div>
                ) : (
                  <div className="flex min-w-0 items-center gap-1">
                    {authorMember && !isMobile ? (
                      <ChatParticipantHoverCard
                        member={authorMember}
                        contactBasePath={contactBasePath}
                      >
                        <span
                          className="shrink-0 font-medium text-muted-foreground/80 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
                          tabIndex={0}
                        >
                          {resolvedAuthorName}
                        </span>
                      </ChatParticipantHoverCard>
                    ) : canOpenAuthorDetails ? (
                      <button
                        type="button"
                        onClick={() => onParticipantClick?.(authorMember!)}
                        className="shrink-0 font-medium text-muted-foreground/80 transition-colors hover:text-foreground"
                      >
                        {resolvedAuthorName}
                      </button>
                    ) : (
                      <span className="shrink-0 font-medium text-muted-foreground/80">
                        {resolvedAuthorName}
                      </span>
                    )}
                    <span className="shrink-0 text-muted-foreground/40">·</span>
                    <button
                      type="button"
                      onClick={() => setCompactExpanded((current) => !current)}
                      className="min-w-0 flex-1 truncate text-left transition-colors hover:text-foreground/80"
                      aria-expanded={compactExpanded}
                    >
                      {compactPreview}
                    </button>
                  </div>
                )}
              </div>
              <button
                type="button"
                className="shrink-0 text-muted-foreground/45 transition-colors hover:text-foreground/70"
                onClick={() => setCompactExpanded((current) => !current)}
                aria-expanded={compactExpanded}
                aria-label={compactExpanded ? "Collapse message" : "Expand message"}
              >
                {compactExpanded ? (
                  <ChevronDown className="mt-0.5 h-3 w-3" />
                ) : (
                  <ChevronRight className="mt-0.5 h-3 w-3" />
                )}
              </button>
            </div>

            {compactExpanded ? (
              <>
                <div className="text-xs leading-relaxed text-muted-foreground/70">
                  <MessageContentBlocks
                    blocks={renderedBlocks}
                    isUser={false}
                    enableTablePreview={enableTablePreview}
                  />
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[9px] text-muted-foreground/30">
                  {timestamp ? (
                    <span>
                      {new Date(timestamp).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  ) : null}
                  <TransportSummary
                    transport={transport}
                    transportDeliveries={transportDeliveries}
                  />
                  <RecipientSummary
                    recipients={recipients}
                    hasExplicitTargets={hasExplicitTargets}
                    onRecipientClick={onParticipantClick}
                    isMobile={isMobile}
                    contactBasePath={contactBasePath}
                  />
                </div>
              </>
            ) : null}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div
      className={`flex w-full min-w-0 max-w-full gap-3 ${isUser ? "flex-row-reverse" : "flex-row"}`}
    >
      {isUser ? (
        <ChatAvatar
          name={viewerUserMember?.name || resolvedAuthorName}
          avatarUrl={viewerUserMember?.avatarUrl || resolvedAuthorAvatarUrl}
          entityType="user"
          className="mt-1 shrink-0"
        />
      ) : isChildResult ? (
        <Avatar className="mt-1 h-8 w-8 shrink-0">
          <AvatarFallback className="bg-amber-500 text-xs text-white">
            <GitBranch className="h-4 w-4" />
          </AvatarFallback>
        </Avatar>
      ) : authorMember && !isMobile ? (
        <ChatParticipantHoverCard
          member={authorMember}
          contactBasePath={contactBasePath}
        >
          <span
            className="mt-1 block shrink-0 rounded-full transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
            tabIndex={0}
            aria-label={`View ${resolvedAuthorName}`}
          >
            <ChatAvatar
              name={resolvedAuthorName}
              avatarUrl={resolvedAuthorAvatarUrl}
              emoji={resolvedAuthorEmoji}
              entityType={authorEntityType}
              statusState={
                authorEntityType === "actor"
                  ? runtimeToAvatarStatus(actorRuntime)
                  : undefined
              }
              statusLabel={
                authorEntityType === "actor" ? getRuntimeLabel(actorRuntime) : undefined
              }
              statusDetail={
                authorEntityType === "actor" ? getRuntimeDetail(actorRuntime) : undefined
              }
            />
          </span>
        </ChatParticipantHoverCard>
      ) : canOpenAuthorDetails ? (
        <button
          type="button"
          onClick={() => onParticipantClick?.(authorMember!)}
          className="mt-1 shrink-0 rounded-full transition-opacity hover:opacity-90"
          aria-label={`Open ${resolvedAuthorName}`}
        >
          <ChatAvatar
            name={resolvedAuthorName}
            avatarUrl={resolvedAuthorAvatarUrl}
            emoji={resolvedAuthorEmoji}
            entityType={authorEntityType}
            statusState={
              authorEntityType === "actor"
                ? runtimeToAvatarStatus(actorRuntime)
                : undefined
            }
            statusLabel={
              authorEntityType === "actor" ? getRuntimeLabel(actorRuntime) : undefined
            }
            statusDetail={
              authorEntityType === "actor" ? getRuntimeDetail(actorRuntime) : undefined
            }
          />
        </button>
      ) : (
        <ChatAvatar
          name={resolvedAuthorName}
          avatarUrl={resolvedAuthorAvatarUrl}
          emoji={resolvedAuthorEmoji}
          entityType={authorEntityType}
          className="mt-1 shrink-0"
          statusState={
            authorEntityType === "actor"
              ? runtimeToAvatarStatus(actorRuntime)
              : undefined
          }
          statusLabel={
            authorEntityType === "actor" ? getRuntimeLabel(actorRuntime) : undefined
          }
          statusDetail={
            authorEntityType === "actor" ? getRuntimeDetail(actorRuntime) : undefined
          }
        />
      )}

      <div
        className={`flex w-full max-w-[75%] min-w-0 flex-col ${isUser ? "items-end" : "items-start"}`}
      >
        {!isUser && resolvedAuthorName && (
          <div className="mb-1 ml-1 self-start text-xs text-muted-foreground/70">
            {authorMember && !isMobile ? (
              <ChatParticipantHoverCard
                member={authorMember}
                contactBasePath={contactBasePath}
              >
                <span
                  className="transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
                  tabIndex={0}
                >
                  {resolvedAuthorName}
                </span>
              </ChatParticipantHoverCard>
            ) : authorMember && onParticipantClick ? (
              <button
                type="button"
                onClick={() => onParticipantClick(authorMember)}
                className="transition-colors hover:text-foreground"
              >
                {resolvedAuthorName}
              </button>
            ) : authorContactHref ? (
              <button
                type="button"
                onClick={() => router.push(authorContactHref)}
                className="transition-colors hover:text-foreground"
              >
                {resolvedAuthorName}
              </button>
            ) : (
              <span>{resolvedAuthorName}</span>
            )}
            {resolvedAuthorSubtitle ? (
              <span className="ml-1 text-[11px] text-muted-foreground/50">
                · {resolvedAuthorSubtitle}
              </span>
            ) : null}
          </div>
        )}
        <div
          className={`flex w-full min-w-0 max-w-full items-end gap-2 ${isUser ? "justify-end" : "justify-start"}`}
        >
          {isRetrying ? (
            <span className="mb-2 inline-flex size-6 items-center justify-center rounded-full border border-destructive/25 bg-destructive/10 text-destructive shadow-sm">
              <AlertTriangle className="size-3.5" />
            </span>
          ) : null}
          <div
            className={`max-w-full min-w-0 overflow-hidden rounded-3xl border px-4 py-3 text-sm leading-relaxed shadow-sm ${
              isUser
                ? isRetrying
                  ? "rounded-tr-sm border-destructive/25 bg-destructive/10 text-destructive"
                  : "rounded-tr-sm border-primary/10 bg-primary text-primary-foreground"
                : isChildResult
                  ? "rounded-tl-sm border-amber-500/20 bg-amber-500/10 text-foreground"
                  : "rounded-tl-sm border-border bg-background text-foreground"
            } `}
          >
            {interaction ? (
              <InteractionCard
                interaction={interaction}
                viewerUserId={viewerUserId}
                onResolveInteraction={onResolveInteraction}
              />
            ) : (
              <MessageContentBlocks
                blocks={renderedBlocks}
                isUser={isUser}
                enableTablePreview={enableTablePreview}
              />
            )}

            {/* Citation sources footer */}
            {!interaction && hasCitations && <CitationFooter sources={sources} />}

            {/* Server tool calls (web_search / web_fetch) — inside the bubble */}
            {!interaction && hasServerToolCalls && (
              <ServerToolCallDisplay calls={serverToolCalls} />
            )}
          </div>
        </div>
        <div
          className={`mt-1 inline-flex max-w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-1 ${isUser ? "self-end flex-row-reverse justify-start" : "self-start justify-start"}`}
        >
          {timestamp && (
            <span className="text-[10px] text-muted-foreground/50">
              {new Date(timestamp).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
          )}
          {canRetryModelError && retrySessionId ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-5 w-5 rounded-full text-muted-foreground/60 hover:text-foreground"
                  disabled={retryPending}
                  onClick={async () => {
                    await onRetryModelError?.(retrySessionId, messageId)
                  }}
                  aria-label="重试"
                >
                  {retryPending ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <RotateCcw className="h-3 w-3" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <p>{retryPending ? "正在重试" : "重试"}</p>
              </TooltipContent>
            </Tooltip>
          ) : null}
          <RecipientSummary
            recipients={recipients}
            hasExplicitTargets={hasExplicitTargets}
            onRecipientClick={onParticipantClick}
            isMobile={isMobile}
            contactBasePath={contactBasePath}
          />
          <TransportSummary
            transport={transport}
            transportDeliveries={transportDeliveries}
          />
          {status === "sending" && (
            <span className="text-[10px] text-muted-foreground/40">
              Sending...
            </span>
          )}
          {status === "retrying" && (
            <span className="text-[10px] text-destructive/80">Retrying...</span>
          )}
          {hasToolsUsed && !hasServerToolCalls && (
            <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground/50">
              <Wrench className="h-2.5 w-2.5" />
              {formatToolsUsed(toolsUsed)}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
