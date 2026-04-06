"use client"

import type { ComponentPropsWithoutRef, MouseEvent as ReactMouseEvent } from "react"
import type {
  ActorRuntimeState,
  CanonicalContentBlock,
  ConversationEntityRef,
  ConversationMessageTransportContext,
  ConversationMessageTransportDelivery,
  ConversationReplyRef,
  InteractionRequestSummary,
} from "@synapse/shared"
import { INTERACTION_REQUEST_KIND } from "@synapse/shared"
import type {
  RelayAuthorizationGrantSpec,
  RelayAuthorizationPreset,
  RelayAuthorizationRequestedAction,
} from "@synapse/shared/types"
import { useRouter } from "next/navigation"
import { createPortal } from "react-dom"
import { useEffect, useMemo, useRef, useState } from "react"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { TwemojiScope } from "@/components/twemoji-scope"
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
  Copy,
  CornerUpLeft,
  Expand,
  CheckCircle2,
  FolderOpen,
  Loader2,
  MousePointerClick,
  RotateCcw,
  Shield,
  XCircle,
} from "lucide-react"
import ReactMarkdown, { defaultUrlTransform } from "react-markdown"
import remarkGfm from "remark-gfm"
import { extractText } from "@synapse/shared"
import { toast } from "sonner"
import { runtimeToAvatarStatus } from "@/stores/chat-store"
import type { ServerToolCall } from "@/stores/chat-store"
import type { ConversationMember } from "@/stores/chat-store"
import type { ChatInteractionResponseInput } from "@/lib/api"
import { cn, resolveFileUrl } from "@/lib/utils"
import ChatAvatar from "./chat-avatar"
import {
  buildReplyPreviewText,
  getEntityDisplayName,
} from "./reply-utils"
import {
  formatTransportKindLabel,
  getAuthorContactHref,
  getConversationMemberSubtitle,
  resolveAuthorMember,
} from "./member-utils"
import ChatParticipantHoverCard from "./chat-participant-hover-card"
import {
  TablePreviewOverlay,
  type TablePreviewContent,
} from "./table-preview-overlay"

interface MessageBubbleProps {
  kind?: "message" | "event"
  messageId: string
  role: string
  messageType?: string
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
  conversationMembers?: ConversationMember[]
  restrictedAudienceParticipantIds?: string[]
  replyTo?: ConversationReplyRef
  workspaceActors?: Array<{
    id: string
    name: string
    role: string
    title: string
    emoji?: string
    avatarUrl?: string
  }>
  transport?: ConversationMessageTransportContext
  transportDeliveries?: ConversationMessageTransportDelivery[]
  interaction?: InteractionRequestSummary
  enableTablePreview?: boolean
  viewerWorkspaceMemberId?: string
  contactBasePath?: string
  retryPending?: boolean
  onParticipantClick?: (member: ConversationMember) => void
  onQuoteMessage?: (replyTo: ConversationReplyRef) => void
  onRetryModelError?: (itemId: string) => Promise<void> | void
  onResolveInteraction?: (
    interactionId: string,
    payload: ChatInteractionResponseInput
  ) =>
    | Promise<InteractionRequestSummary | void>
    | InteractionRequestSummary
    | void
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
          : block.type === "mention"
            ? {
                id: block.id,
                type: "mention" as const,
                block,
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

    if (block.type === "mention") {
      return {
        id: block.id,
        type: "mention" as const,
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
    if (
      (key.startsWith("cit-") || key.startsWith("oai-")) &&
      !urlToNum.has(source.url)
    ) {
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
            className="group/src flex items-start gap-1.5 text-[10px] text-muted-foreground/60 transition-colors hover:text-primary"
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

function formatTransportStatusLabel(
  status: ConversationMessageTransportDelivery["deliveryStatus"]
) {
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
            {transportLabel}{" "}
            {formatTransportStatusLabel(delivery.deliveryStatus)}
          </Badge>
        )
      })}
    </>
  )
}

function buildMessageReplyRef(input: {
  messageId: string
  messageType?: string
  author?: ConversationEntityRef
  content: string
  contentBlocks: CanonicalContentBlock[]
  createdAt?: string
}) {
  return {
    itemId: input.messageId,
    itemType: "message" as const,
    subtype: input.messageType || "chat.message",
    author: input.author,
    previewText: input.content.trim(),
    previewBlocks: input.contentBlocks,
    createdAt: input.createdAt,
  } satisfies ConversationReplyRef
}

function MessageReplyPreview({
  replyTo,
  isUser,
}: {
  replyTo: ConversationReplyRef
  isUser: boolean
}) {
  return (
    <div
      className={cn(
        "mb-3 flex min-w-0 items-start gap-3 rounded-2xl px-3 py-2.5",
        isUser
          ? "bg-white/10 text-primary-foreground/90"
          : "bg-muted/35 text-foreground"
      )}
    >
      <div
        className={cn(
          "mt-0.5 h-9 w-1 shrink-0 rounded-full",
          isUser ? "bg-white/55" : "bg-primary/45"
        )}
      />
      <div className="min-w-0 flex-1">
        <div
          className={cn(
            "truncate text-xs font-medium",
            isUser ? "text-primary-foreground" : "text-foreground"
          )}
        >
          {getEntityDisplayName(replyTo.author)}
        </div>
        <div
          className={cn(
            "mt-0.5 line-clamp-2 text-xs leading-5",
            isUser ? "text-primary-foreground/80" : "text-muted-foreground"
          )}
        >
          {buildReplyPreviewText(replyTo)}
        </div>
      </div>
    </div>
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
    case "approved":
      return "Approved"
    case "rejected":
      return "Rejected"
    case "expired":
      return "Expired"
    case "superseded":
      return "Superseded"
    default:
      return status
  }
}

function getInteractionStatusBadgeClassName(
  status: InteractionRequestSummary["status"]
) {
  switch (status) {
    case "answered":
    case "approved":
      return "border-emerald-500/25 bg-emerald-500/10 text-emerald-700"
    case "rejected":
    case "expired":
    case "superseded":
      return "border-destructive/25 bg-destructive/10 text-destructive"
    default:
      return "border-amber-500/25 bg-amber-500/10 text-amber-700"
  }
}

function formatRelayAuthorizationPresetLabel(preset: RelayAuthorizationPreset) {
  switch (preset) {
    case "workspace":
      return "Always Allow"
    case "conversation":
      return "Allow This Conversation"
    case "actor":
      return "Allow This Actor"
    case "once":
    default:
      return "Allow Once"
  }
}

function getRelayAuthorizationCapabilityIcon(
  capability: RelayAuthorizationGrantSpec["capability"]
) {
  switch (capability) {
    case "filesystem":
      return FolderOpen
    case "browser":
      return Globe
    case "commandline":
      return Wrench
    case "cua":
    default:
      return MousePointerClick
  }
}

function describeRelayAuthorizationSpec(scope: RelayAuthorizationGrantSpec) {
  if (scope.capability === "filesystem" && scope.filesystem) {
    return {
      icon: FolderOpen,
      summary:
        scope.filesystem.access === "write"
          ? "filesystem write access"
          : "filesystem read access",
      detail:
        scope.filesystem.pathPrefixes.length > 0
          ? scope.filesystem.pathPrefixes.join("\n")
          : "filesystem-wide",
    }
  }

  if (scope.capability === "browser" && scope.browser) {
    const detail =
      scope.browser.scopeType === "host"
        ? scope.browser.host
        : scope.browser.scopeType === "domain"
          ? scope.browser.registrableDomain
          : scope.browser.scopeType === "origin"
            ? scope.browser.origin
            : undefined
    return {
      icon: Globe,
      summary:
        scope.browser.action === "write"
          ? "browser write actions"
          : "browser read actions",
      detail: detail || "browser-wide",
    }
  }

  if (scope.capability === "commandline" && scope.commandline) {
    return {
      icon: Wrench,
      summary:
        scope.commandline.commandMatchType === "exact"
          ? "exact command"
          : scope.commandline.commandMatchType === "prefix"
            ? "command prefix"
            : "commandline tool access",
      detail: [
        scope.commandline.commandText || "bash",
        scope.commandline.workingDirectory
          ? `Working directory: ${scope.commandline.workingDirectory}`
          : null,
      ]
        .filter(Boolean)
        .join("\n"),
    }
  }

  return {
    icon: MousePointerClick,
    summary:
      scope.cua?.access === "write"
        ? "desktop input access"
        : "desktop observation access",
    detail: "Computer Use / CUA",
  }
}

function describeRelayAuthorizationRequestedAction(
  action: RelayAuthorizationRequestedAction
) {
  return {
    icon: getRelayAuthorizationCapabilityIcon(action.capability),
    summary: action.summary,
    detail: action.detail,
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
  if (
    interaction.kind !== INTERACTION_REQUEST_KIND.USER_INPUT ||
    !interaction.userInput
  ) {
    return {}
  }

  return Object.fromEntries(
    interaction.userInput.questions.map((question) => [
      question.id,
      {
        selectedOptionIds: [...(question.answer?.selectedOptionIds || [])],
        otherText: question.answer?.otherText || "",
        text: question.answer?.text || "",
      },
    ])
  )
}

function summarizeQuestionFieldAnswer(
  question: NonNullable<InteractionRequestSummary["userInput"]>["questions"][number]
) {
  const parts: string[] = []
  if (question.answer?.selectedOptionLabels?.length) {
    parts.push(question.answer.selectedOptionLabels.join(", "))
  }
  if (question.answer?.otherText) {
    parts.push(question.answer.otherText)
  }
  if (question.answer?.text) {
    parts.push(question.answer.text)
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

  if (interaction.kind === INTERACTION_REQUEST_KIND.USER_INPUT) {
    if (interaction.status === "pending") {
      return (
        <p className="text-xs text-muted-foreground">
          {isTargetUser
            ? "Only you can answer this input request."
            : `Waiting for ${targetName} to answer.`}
        </p>
      )
    }
    if (interaction.status === "answered") {
      const questionCount = interaction.userInput?.questions.length || 0
      const answerSummary =
        interaction.userInput?.questions
          .map((question) => {
            const summary = summarizeQuestionFieldAnswer(question)
            if (!summary) return ""
            return questionCount > 1 ? `${question.prompt}: ${summary}` : summary
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

  if (interaction.kind === INTERACTION_REQUEST_KIND.PLAN_APPROVAL) {
    if (interaction.status === "pending") {
      return (
        <p className="text-xs text-muted-foreground">
          {isTargetUser
            ? "Approve the plan or request revisions."
            : `Waiting for ${targetName} to review the plan.`}
        </p>
      )
    }
    if (interaction.status === "approved") {
      return (
        <p className="text-xs text-muted-foreground">
          {`${interaction.resolvedBy?.name || targetName} approved the plan.`}
        </p>
      )
    }
    if (interaction.status === "rejected") {
      return (
        <p className="text-xs text-muted-foreground">
          {`${interaction.resolvedBy?.name || targetName} requested revisions.`}
        </p>
      )
    }
    return null
  }

  if (interaction.status === "pending") {
    return (
      <p className="text-xs text-muted-foreground">
        {viewerCanResolve
          ? "You can choose how broadly to allow this relay action if you have relay authorization permission."
          : "Waiting for an authorized user to approve or reject."}
      </p>
    )
  }
  if (interaction.status === "approved") {
    return (
      <p className="text-xs text-muted-foreground">
        The relay authorization is active and the blocked action can continue.
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
  if (interaction.status === "expired") {
    return (
      <p className="text-xs text-muted-foreground">
        This authorization request expired before it was resolved.
      </p>
    )
  }
  if (interaction.status === "superseded") {
    return (
      <p className="text-xs text-muted-foreground">
        A newer user message superseded this authorization request.
      </p>
    )
  }
  return null
}

function InteractionCard({
  interaction,
  onResolveInteraction,
}: {
  interaction: InteractionRequestSummary
  onResolveInteraction?: MessageBubbleProps["onResolveInteraction"]
}) {
  const [submittingAction, setSubmittingAction] = useState<string | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [resolutionNoteDraft, setResolutionNoteDraft] = useState("")
  const [draftAnswers, setDraftAnswers] = useState<
    Record<string, DraftQuestionAnswer>
  >(() => buildDraftQuestionAnswers(interaction))
  const [selectedRelayGrantOptionId, setSelectedRelayGrantOptionId] = useState<
    string | null
  >(interaction.relayAuthorization?.grantOptions[0]?.id || null)

  const isTargetUser =
    (interaction.kind === INTERACTION_REQUEST_KIND.USER_INPUT ||
      interaction.kind === INTERACTION_REQUEST_KIND.PLAN_APPROVAL) &&
    interaction.viewerCanResolve === true
  const canResolveUserInput =
    interaction.kind === INTERACTION_REQUEST_KIND.USER_INPUT &&
    Boolean(onResolveInteraction) &&
    interaction.viewerCanResolve === true &&
    interaction.status === "pending"
  const canResolvePlanApproval =
    interaction.kind === INTERACTION_REQUEST_KIND.PLAN_APPROVAL &&
    Boolean(onResolveInteraction) &&
    interaction.viewerCanResolve === true &&
    interaction.status === "pending"
  const canResolveRelayAuthorization =
    interaction.kind === INTERACTION_REQUEST_KIND.RELAY_AUTHORIZATION &&
    Boolean(onResolveInteraction) &&
    interaction.viewerCanResolve === true &&
    interaction.status === "pending"
  const canResolve =
    canResolveUserInput || canResolvePlanApproval || canResolveRelayAuthorization

  useEffect(() => {
    setSubmittingAction(null)
    setSubmitError(null)
    setResolutionNoteDraft("")
    setDraftAnswers(buildDraftQuestionAnswers(interaction))
    setSelectedRelayGrantOptionId(
      interaction.relayAuthorization?.grantOptions[0]?.id || null
    )
  }, [interaction.id, interaction.status])

  async function submitResolution(
    actionKey: string,
    payload: Parameters<
      NonNullable<MessageBubbleProps["onResolveInteraction"]>
    >[1]
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
    questionId: string,
    updater: (current: DraftQuestionAnswer) => DraftQuestionAnswer
  ) {
    setDraftAnswers((current) => {
      const existing = current[questionId] || {
        selectedOptionIds: [],
        otherText: "",
        text: "",
      }
      return {
        ...current,
        [questionId]: updater(existing),
      }
    })
  }

  function buildUserInputAnswerPayload() {
    if (
      interaction.kind !== INTERACTION_REQUEST_KIND.USER_INPUT ||
      !interaction.userInput
    ) {
      return []
    }

    return interaction.userInput.questions.map((question) => {
      const draft = draftAnswers[question.id] || {
        selectedOptionIds: [],
        otherText: "",
        text: "",
      }
      return {
        questionId: question.id,
        selectedOptionIds:
          draft.selectedOptionIds.length > 0
            ? draft.selectedOptionIds
            : undefined,
        otherText: draft.otherText.trim() || undefined,
        text: draft.text.trim() || undefined,
      }
    })
  }

  if (
    interaction.kind === INTERACTION_REQUEST_KIND.USER_INPUT &&
    interaction.userInput
  ) {
    const userInput = interaction.userInput
    const questions = userInput.questions
    const isSimpleSingleSelect =
      canResolveUserInput &&
      questions.length === 1 &&
      questions[0]?.type === "single_select" &&
      !questions[0]?.allowOther

    return (
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge
            variant="outline"
            className="rounded-full border-primary/20 bg-primary/5 text-primary"
          >
            <MousePointerClick className="mr-1 h-3 w-3" />
            Input Request
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
          <p className="text-sm leading-6 font-medium text-foreground">
            {userInput.title}
          </p>
          {userInput.instructions ? (
            <p className="text-xs leading-5 text-muted-foreground">
              {userInput.instructions}
            </p>
          ) : null}
        </div>

        <div className="space-y-3">
          {questions.map((question) => {
            const draft = draftAnswers[question.id] || {
              selectedOptionIds: [],
              otherText: "",
              text: "",
            }
            const selectedOptionIds = canResolveUserInput
              ? draft.selectedOptionIds
              : question.answer?.selectedOptionIds || []
            const questionAnswerText = summarizeQuestionFieldAnswer(question)
            const shouldShowFieldHeading =
              questions.length > 1 || question.prompt !== userInput.title

            return (
              <div
                key={question.id}
                className="space-y-2 rounded-2xl border border-border/70 bg-muted/20 px-4 py-3"
              >
                {shouldShowFieldHeading ? (
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="text-sm font-medium text-foreground">
                        {question.header}
                      </div>
                      {question.required ? (
                        <Badge
                          variant="outline"
                          className="rounded-full border-border/70 bg-background/70 text-[10px] text-muted-foreground"
                        >
                          Required
                        </Badge>
                      ) : null}
                    </div>
                    <div className="text-sm text-foreground">{question.prompt}</div>
                    {question.description ? (
                      <div className="text-xs text-muted-foreground">
                        {question.description}
                      </div>
                    ) : null}
                  </div>
                ) : null}

                {question.type === "text" ? (
                  canResolveUserInput ? (
                    <Textarea
                      value={draft.text}
                      onChange={(event) =>
                        updateDraftAnswer(question.id, (current) => ({
                          ...current,
                          text: event.target.value,
                        }))
                      }
                      placeholder={question.placeholder || "Type your answer"}
                      disabled={Boolean(submittingAction)}
                      className="min-h-24 resize-y rounded-2xl bg-background"
                    />
                  ) : questionAnswerText ? (
                    <div className="rounded-xl border border-border/70 bg-background px-3 py-2 text-sm whitespace-pre-wrap text-foreground">
                      {questionAnswerText}
                    </div>
                  ) : (
                    <div className="text-xs text-muted-foreground">
                      No response provided.
                    </div>
                  )
                ) : (
                  <div className="space-y-2">
                    {(question.options || []).map((option) => {
                      const isSelected = selectedOptionIds.includes(option.id)
                      const isSubmitting =
                        submittingAction === `${question.id}:${option.id}`

                      if (canResolveUserInput && isSimpleSingleSelect) {
                        return (
                          <Button
                            key={option.id}
                            type="button"
                            variant={isSelected ? "default" : "outline"}
                            disabled={Boolean(submittingAction)}
                            onClick={() =>
                              void submitResolution(
                                `${question.id}:${option.id}`,
                                {
                                  answers: [
                                    {
                                      questionId: question.id,
                                      selectedOptionIds: [option.id],
                                    },
                                  ],
                                }
                              )
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
                                <div className="font-medium whitespace-normal">
                                  {option.label}
                                </div>
                                {option.description ? (
                                  <div className="mt-1 text-xs whitespace-normal opacity-80">
                                    {option.description}
                                  </div>
                                ) : null}
                                {option.preview ? (
                                  <div className="mt-2 rounded-xl border border-border/60 bg-background/80 px-3 py-2 text-xs text-muted-foreground">
                                    {option.preview}
                                  </div>
                                ) : null}
                              </div>
                            </div>
                          </Button>
                        )
                      }

                      if (canResolveUserInput) {
                        return (
                          <button
                            key={option.id}
                            type="button"
                            disabled={Boolean(submittingAction)}
                            onClick={() =>
                              updateDraftAnswer(question.id, (current) => {
                                const hasOption =
                                  current.selectedOptionIds.includes(option.id)
                                if (question.type === "single_select") {
                                  return {
                                    ...current,
                                    selectedOptionIds: hasOption
                                      ? []
                                      : [option.id],
                                    otherText: hasOption
                                      ? current.otherText
                                      : "",
                                  }
                                }
                                return {
                                  ...current,
                                  selectedOptionIds: hasOption
                                    ? current.selectedOptionIds.filter(
                                        (id) => id !== option.id
                                      )
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
                              {option.preview ? (
                                <div className="mt-2 rounded-xl border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                                  {option.preview}
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
                              {option.preview ? (
                                <div className="mt-2 rounded-xl border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                                  {option.preview}
                                </div>
                              ) : null}
                            </div>
                          </div>
                        </div>
                      )
                    })}

                    {question.allowOther ? (
                      canResolveUserInput ? (
                        <div className="space-y-1">
                          <div className="text-xs font-medium text-muted-foreground">
                            Other
                          </div>
                          <Textarea
                            value={draft.otherText}
                            onChange={(event) =>
                              updateDraftAnswer(question.id, (current) => ({
                                ...current,
                                otherText: event.target.value,
                                selectedOptionIds:
                                  question.type === "single_select" &&
                                  event.target.value.trim()
                                    ? []
                                    : current.selectedOptionIds,
                              }))
                            }
                            placeholder="Add another answer"
                            disabled={Boolean(submittingAction)}
                            className="min-h-20 resize-y rounded-2xl bg-background"
                          />
                        </div>
                      ) : question.answer?.otherText ? (
                        <div className="rounded-xl border border-border/70 bg-background px-3 py-2 text-sm whitespace-pre-wrap text-foreground">
                          {`Other: ${question.answer.otherText}`}
                        </div>
                      ) : null
                    ) : null}

                    {!canResolve &&
                    !questionAnswerText &&
                    !question.answer?.otherText ? (
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

        {canResolveUserInput && !isSimpleSingleSelect ? (
          <div className="flex items-center gap-2">
            <Button
              type="button"
              disabled={Boolean(submittingAction)}
              onClick={() =>
                void submitResolution("submit_answers", {
                  answers: buildUserInputAnswerPayload(),
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

  if (
    interaction.kind === INTERACTION_REQUEST_KIND.PLAN_APPROVAL &&
    interaction.planApproval
  ) {
    const planApproval = interaction.planApproval

    return (
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge
            variant="outline"
            className="rounded-full border-primary/20 bg-primary/5 text-primary"
          >
            <GitBranch className="mr-1 h-3 w-3" />
            Plan Approval
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
          <p className="text-sm leading-6 font-medium text-foreground">
            {planApproval.title}
          </p>
          {planApproval.summary ? (
            <p className="text-xs leading-5 text-muted-foreground">
              {planApproval.summary}
            </p>
          ) : null}
        </div>

        <div className="rounded-2xl border border-border/70 bg-background px-4 py-3">
          <div className="prose prose-sm max-w-none text-foreground prose-p:my-2 prose-li:my-1 prose-ul:my-2 prose-ol:my-2">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {planApproval.planMarkdown}
            </ReactMarkdown>
          </div>
        </div>

        {planApproval.checklist?.length ? (
          <div className="space-y-2 rounded-2xl border border-border/70 bg-muted/20 px-4 py-3">
            {planApproval.checklist.map((step, index) => (
              <div
                key={`${step.step}-${index}`}
                className="flex items-center justify-between gap-3 text-sm"
              >
                <div className="min-w-0 text-foreground">{step.step}</div>
                <Badge
                  variant="outline"
                  className="rounded-full border-border/70 bg-background/70 text-[10px] text-muted-foreground"
                >
                  {step.status}
                </Badge>
              </div>
            ))}
          </div>
        ) : null}

        {canResolvePlanApproval ? (
          <div className="space-y-2">
            <Textarea
              value={resolutionNoteDraft}
              onChange={(event) => setResolutionNoteDraft(event.target.value)}
              placeholder="Optional approval note or revision feedback"
              disabled={Boolean(submittingAction)}
              className="min-h-24 resize-y rounded-2xl bg-background"
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                disabled={Boolean(submittingAction)}
                onClick={() =>
                  void submitResolution("approve_plan", {
                    decision: "approve",
                    note: resolutionNoteDraft.trim() || undefined,
                  })
                }
                className="rounded-full"
              >
                {submittingAction === "approve_plan" ? (
                  <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                ) : (
                  <CheckCircle2 className="mr-1 h-4 w-4" />
                )}
                Approve Plan
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={Boolean(submittingAction)}
                onClick={() =>
                  void submitResolution("revise_plan", {
                    decision: "revise",
                    note: resolutionNoteDraft.trim() || undefined,
                  })
                }
                className="rounded-full"
              >
                {submittingAction === "revise_plan" ? (
                  <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                ) : (
                  <RotateCcw className="mr-1 h-4 w-4" />
                )}
                Request Changes
              </Button>
            </div>
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

  if (
    interaction.kind === INTERACTION_REQUEST_KIND.RELAY_AUTHORIZATION &&
    interaction.relayAuthorization
  ) {
    const relayAuthorization = interaction.relayAuthorization
    if (!relayAuthorization) {
      return null
    }

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
          <p className="text-sm leading-6 font-medium text-foreground">
            {`Authorize ${relayAuthorization.relayToolStableKey} on ${relayAuthorization.deviceDisplayName}`}
          </p>
          <p className="text-xs leading-5 text-muted-foreground">
            {relayAuthorization.reason}
          </p>
        </div>

        <div className="grid gap-2">
          <div className="rounded-2xl border border-border/70 bg-muted/20 px-4 py-3">
            <div className="text-[11px] font-medium tracking-[0.08em] text-muted-foreground/70 uppercase">
              Exposure
            </div>
            <div className="mt-1 text-sm text-foreground">
              {relayAuthorization.exposureDisplayName}
            </div>
          </div>
          <div className="rounded-2xl border border-border/70 bg-muted/20 px-4 py-3">
            <div className="text-[11px] font-medium tracking-[0.08em] text-muted-foreground/70 uppercase">
              Requested Action
            </div>
            <div className="mt-2">
              {(() => {
                const described = describeRelayAuthorizationRequestedAction(
                  relayAuthorization.requestedAction
                )
                const RequestedIcon = described.icon
                return (
                  <div className="flex items-start gap-2 text-sm text-foreground">
                    <RequestedIcon className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                    <div className="min-w-0">
                      <div>{described.summary}</div>
                      {described.detail ? (
                        <div className="mt-0.5 whitespace-pre-wrap break-all text-xs text-muted-foreground">
                          {described.detail}
                        </div>
                      ) : null}
                    </div>
                  </div>
                )
              })()}
            </div>
          </div>
          {relayAuthorization.approvedGrant ? (
            <div className="rounded-2xl border border-emerald-500/25 bg-emerald-500/10 px-4 py-3">
              <div className="text-[11px] font-medium tracking-[0.08em] text-emerald-700/80 uppercase">
                Approved Authorization
              </div>
              <div className="mt-2 space-y-2">
                {(() => {
                  const described = describeRelayAuthorizationSpec(
                    relayAuthorization.approvedGrant
                  )
                  const ApprovedIcon = described.icon
                  return (
                    <div className="flex items-start gap-2 text-sm text-foreground">
                      <ApprovedIcon className="mt-0.5 h-4 w-4 shrink-0 text-emerald-700" />
                      <div className="min-w-0">
                        <div>{described.summary}</div>
                        {described.detail ? (
                          <div className="mt-0.5 whitespace-pre-wrap break-all text-xs text-muted-foreground">
                            {described.detail}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  )
                })()}
                {relayAuthorization.approvedPreset ? (
                  <div className="text-[11px] text-emerald-700/80">
                    {formatRelayAuthorizationPresetLabel(
                      relayAuthorization.approvedPreset
                    )}
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>

        {canResolve ? (
          <div className="space-y-3">
            <div className="rounded-2xl border border-border/70 bg-muted/20 px-4 py-3">
              <div className="text-[11px] font-medium tracking-[0.08em] text-muted-foreground/70 uppercase">
                Authorization Range
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                {relayAuthorization.grantOptions.map((option) => {
                  const selected = selectedRelayGrantOptionId === option.id
                  return (
                    <Button
                      key={option.id}
                      type="button"
                      variant={selected ? "default" : "outline"}
                      size="sm"
                      disabled={Boolean(submittingAction)}
                      onClick={() => setSelectedRelayGrantOptionId(option.id)}
                      className="rounded-full"
                      title={option.detail}
                    >
                      {selected ? (
                        <CheckCircle2 className="mr-1 h-4 w-4" />
                      ) : (
                        <ChevronRight className="mr-1 h-4 w-4" />
                      )}
                      {option.summary}
                    </Button>
                  )
                })}
              </div>
            </div>

            <div className="rounded-2xl border border-border/70 bg-muted/20 px-4 py-3">
              <div className="text-[11px] font-medium tracking-[0.08em] text-muted-foreground/70 uppercase">
                Applies To
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                {relayAuthorization.availablePresets.map((preset) => (
                  <Badge key={preset} variant="outline" className="rounded-full">
                    {formatRelayAuthorizationPresetLabel(preset)}
                  </Badge>
                ))}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {relayAuthorization.availablePresets.map((preset) => (
                <Button
                  key={preset}
                  type="button"
                  variant={preset === "once" ? "default" : "outline"}
                  disabled={Boolean(submittingAction) || !selectedRelayGrantOptionId}
                  onClick={() =>
                    void submitResolution(`approve_${preset}`, {
                      decision: "approve",
                      preset,
                      selectedGrantOptionId:
                        selectedRelayGrantOptionId || undefined,
                      note: resolutionNoteDraft.trim() || undefined,
                    })
                  }
                  className="rounded-full"
                >
                  {submittingAction === `approve_${preset}` ? (
                    <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                  ) : (
                    <CheckCircle2 className="mr-1 h-4 w-4" />
                  )}
                  {formatRelayAuthorizationPresetLabel(preset)}
                </Button>
              ))}
              <Button
                type="button"
                variant="outline"
                disabled={Boolean(submittingAction)}
                onClick={() =>
                  void submitResolution("reject", {
                    decision: "reject",
                    note: resolutionNoteDraft.trim() || undefined,
                  })
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

type FileRefBlock = Extract<CanonicalContentBlock, { type: "file_ref" }>
type MentionBlock = Extract<CanonicalContentBlock, { type: "mention" }>
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
  | {
      id: string
      type: "mention"
      block: MentionBlock
    }

const MENTION_MARKDOWN_PREFIX = "synapse-mention://"

const AUDIO_EXTENSIONS = [
  ".wav",
  ".mp3",
  ".ogg",
  ".m4a",
  ".flac",
  ".aac",
  ".wma",
]

function resolveMentionMember(
  mention: ConversationEntityRef,
  conversationMembers: ConversationMember[] | undefined,
  workspaceActors: MessageBubbleProps["workspaceActors"]
) {
  const members = conversationMembers || []
  const matchedMember =
    members.find(
      (member) =>
        (mention.participantId &&
          member.participantId === mention.participantId) ||
        (mention.actorId &&
          member.type === "actor" &&
          member.id === mention.actorId) ||
        (mention.workspaceMemberId &&
          member.type === "workspace_member" &&
          member.id === mention.workspaceMemberId) ||
        (mention.externalUserKey &&
          member.type === "external" &&
          member.externalUserKey === mention.externalUserKey)
    ) || null

  if (matchedMember) return matchedMember

  if (mention.participantType === "actor") {
    const actor = workspaceActors?.find(
      (candidate) => candidate.id === mention.actorId
    )
    const fallbackId = mention.actorId || mention.participantId || "unknown-actor"

    return {
      participantId: mention.participantId || fallbackId,
      type: "actor" as const,
      id: mention.actorId || actor?.id || fallbackId,
      name: mention.name || actor?.name || "Unknown actor",
      role: mention.role || actor?.role,
      title: mention.title || actor?.title,
      emoji: mention.avatarEmoji || actor?.emoji,
      avatarUrl: mention.avatarUrl || actor?.avatarUrl,
    }
  }

  if (mention.participantType === "workspace_member") {
    const fallbackId =
      mention.workspaceMemberId || mention.participantId || "unknown-user"

    return {
      participantId: mention.participantId || fallbackId,
      type: "workspace_member" as const,
      id: mention.workspaceMemberId || fallbackId,
      name: mention.name || "Unknown user",
      role: mention.role,
      title: mention.title,
      emoji: mention.avatarEmoji,
      avatarUrl: mention.avatarUrl,
    }
  }

  const fallbackId =
    mention.externalUserKey || mention.participantId || "unknown-external"

  return {
    participantId: mention.participantId || fallbackId,
    type: "external" as const,
    id: fallbackId,
    name: mention.name || "Unknown participant",
    role: mention.role,
    title: mention.title,
    emoji: mention.avatarEmoji,
    avatarUrl: mention.avatarUrl,
    externalUserKey: mention.externalUserKey,
  }
}

type InlineRenderedMessageBlock = Extract<
  RenderedMessageBlock,
  { type: "text" | "mention" }
>

function groupRenderedMessageBlocks(blocks: RenderedMessageBlock[]) {
  const groups: Array<
    | {
        id: string
        type: "inline"
        blocks: InlineRenderedMessageBlock[]
      }
    | {
        id: string
        type: "file_ref"
        block: FileRefBlock
      }
  > = []
  let inlineBlocks: InlineRenderedMessageBlock[] = []

  function flushInlineBlocks() {
    if (inlineBlocks.length === 0) return
    groups.push({
      id: inlineBlocks.map((block) => block.id).join(":"),
      type: "inline",
      blocks: inlineBlocks,
    })
    inlineBlocks = []
  }

  for (const block of blocks) {
    if (block.type === "file_ref") {
      flushInlineBlocks()
      groups.push({
        id: block.id,
        type: "file_ref",
        block: block.block,
      })
      continue
    }

    inlineBlocks.push(block)
  }

  flushInlineBlocks()
  return groups
}

function serializeInlineBlocksToMarkdown(blocks: InlineRenderedMessageBlock[]) {
  const mentionBlocksById: Record<string, MentionBlock> = {}
  const markdown = blocks
    .map((block, index) => {
      if (block.type === "text") {
        return block.text
      }

      const mentionId = block.id || String(index)
      const href = `${MENTION_MARKDOWN_PREFIX}${encodeURIComponent(mentionId)}`
      mentionBlocksById[mentionId] = block.block
      return `[mention-${index}](${href})`
    })
    .join("")

  return {
    markdown,
    mentionBlocksById,
  }
}

function getMentionBlockFromHref(
  href: string | undefined,
  mentionBlocksById?: Record<string, MentionBlock>
) {
  if (!href || !mentionBlocksById) {
    return undefined
  }

  if (!href.startsWith(MENTION_MARKDOWN_PREFIX)) {
    return undefined
  }

  const encodedId = href.slice(MENTION_MARKDOWN_PREFIX.length)
  const mentionId = decodeURIComponent(encodedId)
  return mentionBlocksById[mentionId]
}

function getSelectedTextWithinContainer(container: HTMLElement) {
  if (typeof window === "undefined") {
    return undefined
  }

  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return undefined
  }

  const text = selection.toString().trim()
  if (!text) {
    return undefined
  }

  const range = selection.getRangeAt(0)
  if (
    !container.contains(range.startContainer) ||
    !container.contains(range.endContainer)
  ) {
    return undefined
  }

  return text
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
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                <FileIcon className="h-4 w-4 text-primary" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs text-foreground/80">
                  {block.originalName}
                </div>
                <div className="text-[10px] text-muted-foreground/50">
                  {formatBytes(block.sizeBytes)}
                </div>
              </div>
              <Download className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40 transition-colors group-hover/file:text-primary" />
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
  isUser = false,
  enableTablePreview,
  conversationMembers,
  workspaceActors,
  contactBasePath,
  mentionBlocksById,
}: {
  text: string
  isUser?: boolean
  enableTablePreview: boolean
  conversationMembers?: ConversationMember[]
  workspaceActors?: MessageBubbleProps["workspaceActors"]
  contactBasePath?: string
  mentionBlocksById?: Record<string, MentionBlock>
}) {
  const [expandedTable, setExpandedTable] =
    useState<TablePreviewContent | null>(null)

  function openTablePreview(table: TablePreviewContent) {
    setExpandedTable(table)
  }

  if (!text) return null

  return (
    <>
      <TwemojiScope className="prose prose-sm prose-p:my-1.5 prose-headings:text-foreground prose-code:rounded prose-code:bg-primary/10 prose-code:px-1.5 prose-code:py-0.5 prose-code:text-xs prose-code:text-primary prose-code:before:content-none prose-code:after:content-none prose-pre:rounded-2xl prose-pre:border prose-pre:border-border prose-pre:bg-muted prose-strong:text-foreground dark:prose-invert max-w-full min-w-0 break-words [&_a]:[overflow-wrap:anywhere] [&_a]:break-words [&_code]:[overflow-wrap:anywhere] [&_code]:break-words [&_li]:[overflow-wrap:anywhere] [&_p]:[overflow-wrap:anywhere] [&_pre]:max-w-full [&_pre]:overflow-x-auto">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          urlTransform={(url) =>
            url.startsWith(MENTION_MARKDOWN_PREFIX)
              ? url
              : defaultUrlTransform(url)
          }
          components={{
            img: ({ src, alt, ...props }) => (
              <ExpandableImage src={src} alt={alt} {...props} />
            ),
            a: ({ href, children, ...props }) => {
              const mentionBlock = getMentionBlockFromHref(
                href,
                mentionBlocksById
              )
              if (mentionBlock) {
                return (
                  <MentionInlineBlock
                    block={mentionBlock}
                    isUser={isUser}
                    conversationMembers={conversationMembers}
                    workspaceActors={workspaceActors}
                    contactBasePath={contactBasePath}
                  />
                )
              }

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
                      "cursor-zoom-in focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-none"
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
                  "min-w-[7rem] border-b border-border/70 px-3 py-2 text-left align-top font-medium whitespace-nowrap text-foreground",
                  className
                )}
                {...props}
              />
            ),
            td: ({ className, ...props }) => (
              <td
                className={cn(
                  "min-w-[7rem] border-b border-border/70 px-3 py-2 align-top [overflow-wrap:anywhere] break-words",
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
                  "[overflow-wrap:anywhere] break-words"
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
      </TwemojiScope>

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
  conversationMembers,
  workspaceActors,
  contactBasePath,
}: {
  blocks: RenderedMessageBlock[]
  isUser: boolean
  enableTablePreview: boolean
  conversationMembers?: ConversationMember[]
  workspaceActors?: MessageBubbleProps["workspaceActors"]
  contactBasePath?: string
}) {
  if (blocks.length === 0) return null

  const groupedBlocks = groupRenderedMessageBlocks(blocks)

  return (
    <div className="max-w-full min-w-0 space-y-2">
      {groupedBlocks.map((group) =>
        group.type === "file_ref" ? (
          <FileBlockPreview key={group.id} blocks={[group.block]} />
        ) : (
          <InlineMessageSequence
            key={group.id}
            blocks={group.blocks}
            isUser={isUser}
            enableTablePreview={enableTablePreview}
            conversationMembers={conversationMembers}
            workspaceActors={workspaceActors}
            contactBasePath={contactBasePath}
          />
        )
      )}
    </div>
  )
}

function MentionInlineBlock({
  block,
  isUser,
  conversationMembers,
  workspaceActors,
  contactBasePath,
}: {
  block: MentionBlock
  isUser: boolean
  conversationMembers?: ConversationMember[]
  workspaceActors?: MessageBubbleProps["workspaceActors"]
  contactBasePath?: string
}) {
  const member = resolveMentionMember(
    block.mention,
    conversationMembers,
    workspaceActors
  )
  const name = member?.name || block.mention.name?.trim() || "Unknown"

  return (
    <ChatParticipantHoverCard member={member} contactBasePath={contactBasePath}>
      <span
        className={cn(
          "inline-flex max-w-full cursor-help items-center rounded-md px-1.5 py-0.5 align-baseline text-[0.95em] font-medium ring-1 transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-none",
          isUser
            ? "bg-white/16 text-white ring-white/18 hover:bg-white/24"
            : "bg-sky-500/12 text-sky-700 ring-sky-500/15 hover:bg-sky-500/18 dark:text-sky-300"
        )}
        tabIndex={0}
      >
        @{name}
      </span>
    </ChatParticipantHoverCard>
  )
}

function InlineMessageSequence({
  blocks,
  isUser,
  enableTablePreview,
  conversationMembers,
  workspaceActors,
  contactBasePath,
}: {
  blocks: InlineRenderedMessageBlock[]
  isUser: boolean
  enableTablePreview: boolean
  conversationMembers?: ConversationMember[]
  workspaceActors?: MessageBubbleProps["workspaceActors"]
  contactBasePath?: string
}) {
  if (
    blocks.length === 1 &&
    blocks[0]?.type === "text" &&
    !blocks.some((block) => block.type === "mention")
  ) {
    return isUser ? (
      blocks[0].text ? (
        <TwemojiScope
          as="p"
          className="[overflow-wrap:anywhere] break-words whitespace-pre-wrap"
        >
          {blocks[0].text}
        </TwemojiScope>
      ) : null
    ) : (
      <MarkdownTextBlock
        text={blocks[0].text}
        isUser={isUser}
        enableTablePreview={enableTablePreview}
        conversationMembers={conversationMembers}
        workspaceActors={workspaceActors}
        contactBasePath={contactBasePath}
      />
    )
  }

  if (!isUser) {
    const { markdown, mentionBlocksById } = serializeInlineBlocksToMarkdown(
      blocks
    )

    return (
      <MarkdownTextBlock
        text={markdown}
        isUser={false}
        enableTablePreview={enableTablePreview}
        conversationMembers={conversationMembers}
        workspaceActors={workspaceActors}
        contactBasePath={contactBasePath}
        mentionBlocksById={mentionBlocksById}
      />
    )
  }

  return (
    <TwemojiScope
      as="div"
      className="leading-7 [overflow-wrap:anywhere] break-words whitespace-pre-wrap"
    >
      {blocks.map((block) =>
        block.type === "mention" ? (
          <MentionInlineBlock
            key={block.id}
            block={block.block}
            isUser={isUser}
            conversationMembers={conversationMembers}
            workspaceActors={workspaceActors}
            contactBasePath={contactBasePath}
          />
        ) : (
          <span key={block.id}>{block.text}</span>
        )
      )}
    </TwemojiScope>
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
              <div className="flex items-center gap-1.5 text-[11px] text-primary">
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
                      className="group/link flex items-start gap-1.5 text-[10px] text-muted-foreground/60 transition-colors hover:text-primary"
                    >
                      <ExternalLink className="mt-0.5 h-2.5 w-2.5 shrink-0 opacity-0 transition-opacity group-hover/link:opacity-100" />
                      <span className="truncate">
                        <span className="text-foreground/60 group-hover/link:text-primary">
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
  kind = "message",
  messageId,
  role,
  messageType,
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
  conversationMembers,
  restrictedAudienceParticipantIds,
  replyTo,
  workspaceActors,
  transport,
  transportDeliveries,
  interaction,
  enableTablePreview = false,
  viewerWorkspaceMemberId,
  contactBasePath = "/dashboard/contacts",
  retryPending = false,
  onParticipantClick,
  onQuoteMessage,
  onRetryModelError,
  onResolveInteraction,
}: MessageBubbleProps) {
  const router = useRouter()
  const isMobile = useIsMobile()
  const isChildResult = role === "child_result"
  const isSystem = role === "system"
  const isError = role === "error"
  const textContent = useMemo(() => extractText(contentBlocks), [contentBlocks])
  const viewerUserMember = useMemo(() => {
    if (!viewerWorkspaceMemberId) return undefined
    return conversationMembers?.find(
      (member) =>
        member.type === "workspace_member" &&
        member.id === viewerWorkspaceMemberId
    )
  }, [conversationMembers, viewerWorkspaceMemberId])
  const authorMember = useMemo(
    () => resolveAuthorMember(author, conversationMembers),
    [author, conversationMembers]
  )
  const authorContactHref = useMemo(
    () => getAuthorContactHref(author, conversationMembers, contactBasePath),
    [author, contactBasePath, conversationMembers]
  )
  const canOpenAuthorDetails = Boolean(
    isMobile && authorMember && onParticipantClick
  )
  const authorEntityType = useMemo(() => {
    if (author?.participantType === "external") return "external" as const
    if (author?.participantType === "workspace_member")
      return "workspace_member" as const
    return "actor" as const
  }, [author?.participantType])
  const resolvedAuthorName = useMemo(() => {
    if (author?.participantType === "workspace_member") {
      if (
        author.workspaceMemberId &&
        author.workspaceMemberId === viewerWorkspaceMemberId
      )
        return "You"
      return author.name || authorMember?.name || "User"
    }
    if (author?.participantType === "external") {
      return author.name || authorMember?.name || "External participant"
    }
    if (author?.participantType === "actor") {
      return author.name || actorName || authorMember?.name || "Actor"
    }
    return actorName || (isUser ? "You" : "Member")
  }, [actorName, author, authorMember, isUser, viewerWorkspaceMemberId])
  const resolvedAuthorAvatarUrl =
    authorEntityType === "actor"
      ? actorAvatarUrl || author?.avatarUrl || authorMember?.avatarUrl
      : authorMember?.avatarUrl || author?.avatarUrl
  const resolvedAuthorEmoji =
    authorEntityType === "actor"
      ? actorEmoji || author?.avatarEmoji || authorMember?.emoji
      : authorMember?.emoji || author?.avatarEmoji
  const resolvedAuthorSubtitle = useMemo(() => {
    if (author?.participantType === "actor") {
      return (
        actorRole ||
        author?.title ||
        author?.role ||
        authorMember?.title ||
        authorMember?.role ||
        "Actor"
      )
    }
    if (author?.participantType === "external") {
      return authorMember
        ? getConversationMemberSubtitle(authorMember)
        : "External participant"
    }
    if (author?.participantType === "workspace_member") {
      return (
        author.workspaceMemberId &&
        author.workspaceMemberId === viewerWorkspaceMemberId
      )
        ? "You"
        : "Workspace member"
    }
    return undefined
  }, [actorRole, author, authorMember, viewerWorkspaceMemberId])

  const { blocks: renderedBlocks, sources } = useMemo(
    () => buildRenderedMessageBlocks(contentBlocks, citationSources),
    [citationSources, contentBlocks]
  )
  const [compactExpanded, setCompactExpanded] = useState(false)
  const compactPreview = useMemo(
    () => getCompactMessagePreview(textContent, renderedBlocks),
    [renderedBlocks, textContent]
  )
  const contextMenuRef = useRef<HTMLDivElement | null>(null)
  const [contextMenu, setContextMenu] = useState<{
    x: number
    y: number
    selectedText?: string
  } | null>(null)
  const canCopyMessage = kind === "message" && !interaction
  const canQuoteMessage =
    kind === "message" &&
    !interaction &&
    !messageId.startsWith("local:") &&
    Boolean(onQuoteMessage)
  const canOpenMessageMenu = canCopyMessage || canQuoteMessage

  useEffect(() => {
    if (!contextMenu) {
      return
    }

    function handlePointerDown(event: MouseEvent) {
      if (contextMenuRef.current?.contains(event.target as Node)) {
        return
      }
      setContextMenu(null)
    }

    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setContextMenu(null)
      }
    }

    function handleScroll() {
      setContextMenu(null)
    }

    window.addEventListener("pointerdown", handlePointerDown)
    window.addEventListener("keydown", handleEscape)
    window.addEventListener("scroll", handleScroll, true)

    return () => {
      window.removeEventListener("pointerdown", handlePointerDown)
      window.removeEventListener("keydown", handleEscape)
      window.removeEventListener("scroll", handleScroll, true)
    }
  }, [contextMenu])

  function openContextMenu(event: ReactMouseEvent<HTMLDivElement>) {
    if (!canOpenMessageMenu) {
      return
    }

    event.preventDefault()

    const selectedText = getSelectedTextWithinContainer(event.currentTarget)

    const menuWidth = 176
    const optionCount =
      (selectedText ? 1 : 0) + (canCopyMessage ? 1 : 0) + (canQuoteMessage ? 1 : 0)
    const menuHeight = Math.max(52, optionCount * 40 + 8)
    const nextX = Math.max(
      12,
      Math.min(event.clientX, window.innerWidth - menuWidth - 12)
    )
    const nextY = Math.max(
      12,
      Math.min(event.clientY, window.innerHeight - menuHeight - 12)
    )

    setContextMenu({
      x: nextX,
      y: nextY,
      selectedText,
    })
  }

  async function copyText(text: string) {
    try {
      await navigator.clipboard.writeText(text)
      toast.success("Copied")
    } catch {
      toast.error("Failed to copy")
    } finally {
      setContextMenu(null)
    }
  }

  async function handleCopyMessage() {
    const text = buildReplyPreviewText(
      buildMessageReplyRef({
        messageId,
        messageType,
        author,
        content: textContent,
        contentBlocks,
        createdAt: timestamp,
      })
    )

    if (!text) {
      setContextMenu(null)
      return
    }

    await copyText(text)
  }

  async function handleCopySelection() {
    const text = contextMenu?.selectedText?.trim()
    if (!text) {
      setContextMenu(null)
      return
    }

    await copyText(text)
  }

  function handleQuoteMessage() {
    if (!canQuoteMessage || !onQuoteMessage) {
      setContextMenu(null)
      return
    }

    onQuoteMessage(
      buildMessageReplyRef({
        messageId,
        messageType,
        author,
        content: textContent,
        contentBlocks,
        createdAt: timestamp,
      })
    )
    setContextMenu(null)
  }

  const contextMenuNode =
    contextMenu && typeof document !== "undefined"
      ? createPortal(
          <div
            ref={contextMenuRef}
            className="fixed z-[140] min-w-44 overflow-hidden rounded-2xl border border-border bg-popover p-1 shadow-2xl"
            style={{
              left: contextMenu.x,
              top: contextMenu.y,
            }}
          >
            {contextMenu?.selectedText ? (
              <button
                type="button"
                onClick={() => void handleCopySelection()}
                className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm text-foreground transition-colors hover:bg-muted"
              >
                <Copy className="size-4" />
                Copy selection
              </button>
            ) : null}
            {canCopyMessage ? (
              <button
                type="button"
                onClick={() => void handleCopyMessage()}
                className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm text-foreground transition-colors hover:bg-muted"
              >
                <Copy className="size-4" />
                Copy
              </button>
            ) : null}
            {canQuoteMessage ? (
              <button
                type="button"
                onClick={handleQuoteMessage}
                className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm text-foreground transition-colors hover:bg-muted"
              >
                <CornerUpLeft className="size-4" />
                Quote
              </button>
            ) : null}
          </div>,
          document.body
        )
      : null

  if (isError) {
    return (
      <div className="flex w-full max-w-full min-w-0 gap-3">
        <div className="text-destructive-foreground mt-1 flex size-8 shrink-0 items-center justify-center rounded-2xl bg-destructive shadow-sm">
          <AlertTriangle className="h-4 w-4 text-white" />
        </div>
        <div className="flex w-full max-w-[75%] min-w-0 flex-col items-start">
          <div className="rounded-3xl rounded-tl-sm border border-destructive/20 bg-destructive/10 px-4 py-3 text-sm leading-relaxed text-destructive shadow-sm">
            <TwemojiScope
              as="p"
              className="[overflow-wrap:anywhere] break-words whitespace-pre-wrap"
            >
              {textContent}
            </TwemojiScope>
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
      <div className="my-2 flex w-full max-w-full min-w-0 justify-center">
        <TwemojiScope className="max-w-[80%] text-center text-xs text-muted-foreground/75">
          {textContent.length > 200
            ? textContent.substring(0, 200) + "..."
            : textContent}
        </TwemojiScope>
      </div>
    )
  }

  const hasServerToolCalls = serverToolCalls && serverToolCalls.length > 0
  const hasToolsUsed = toolsUsed && toolsUsed.length > 0
  const hasCitations = sources.length > 0
  const isRetrying = isUser && status === "retrying"
  const viewerParticipantId = viewerUserMember?.participantId
  const canRetryModelError = Boolean(
    messageType === "model_error_notice" &&
    viewerParticipantId &&
    restrictedAudienceParticipantIds?.includes(viewerParticipantId) &&
    onRetryModelError
  )
  const shouldRenderCompact = !interaction && !isUser && coordination

  // Coordination traffic stays compact so the main thread focuses on the main exchange.
  if (shouldRenderCompact) {
    return (
      <>
        <div className="ml-10 flex w-[calc(100%-2.5rem)] max-w-full min-w-0 gap-2 opacity-70">
          <div
            className="flex w-full max-w-[70%] min-w-0 items-start gap-2"
            onContextMenu={canOpenMessageMenu ? openContextMenu : undefined}
          >
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
                            className="text-[11px] font-medium text-muted-foreground/80 transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-none"
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
                            className="shrink-0 font-medium text-muted-foreground/80 transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-none"
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
                        className="min-w-0 flex-1 text-left transition-colors hover:text-foreground/80"
                        aria-expanded={compactExpanded}
                      >
                        <TwemojiScope as="span" className="block truncate">
                          {compactPreview}
                        </TwemojiScope>
                      </button>
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  className="shrink-0 text-muted-foreground/45 transition-colors hover:text-foreground/70"
                  onClick={() => setCompactExpanded((current) => !current)}
                  aria-expanded={compactExpanded}
                  aria-label={
                    compactExpanded ? "Collapse message" : "Expand message"
                  }
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
                    {replyTo ? (
                      <MessageReplyPreview replyTo={replyTo} isUser={false} />
                    ) : null}
                    <MessageContentBlocks
                      blocks={renderedBlocks}
                      isUser={false}
                      enableTablePreview={enableTablePreview}
                      conversationMembers={conversationMembers}
                      workspaceActors={workspaceActors}
                      contactBasePath={contactBasePath}
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
                  </div>
                </>
              ) : null}
            </div>
          </div>
        </div>
        {contextMenuNode}
      </>
    )
  }

  return (
    <>
      <div
        className={`flex w-full max-w-full min-w-0 gap-3 ${isUser ? "flex-row-reverse" : "flex-row"}`}
      >
      {isUser ? (
        <ChatAvatar
          name={viewerUserMember?.name || resolvedAuthorName}
          avatarUrl={viewerUserMember?.avatarUrl || resolvedAuthorAvatarUrl}
          entityType="workspace_member"
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
            className="mt-1 block shrink-0 rounded-full transition-opacity hover:opacity-90 focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-none"
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
                authorEntityType === "actor"
                  ? getRuntimeLabel(actorRuntime)
                  : undefined
              }
              statusDetail={
                authorEntityType === "actor"
                  ? getRuntimeDetail(actorRuntime)
                  : undefined
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
              authorEntityType === "actor"
                ? getRuntimeLabel(actorRuntime)
                : undefined
            }
            statusDetail={
              authorEntityType === "actor"
                ? getRuntimeDetail(actorRuntime)
                : undefined
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
            authorEntityType === "actor"
              ? getRuntimeLabel(actorRuntime)
              : undefined
          }
          statusDetail={
            authorEntityType === "actor"
              ? getRuntimeDetail(actorRuntime)
              : undefined
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
                  className="transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-none"
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
            className={`flex w-full max-w-full min-w-0 items-end gap-2 ${isUser ? "justify-end" : "justify-start"}`}
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
            onContextMenu={canOpenMessageMenu ? openContextMenu : undefined}
          >
            {interaction ? (
              <InteractionCard
                interaction={interaction}
                onResolveInteraction={onResolveInteraction}
              />
            ) : (
              <>
                {replyTo ? (
                  <MessageReplyPreview replyTo={replyTo} isUser={isUser} />
                ) : null}
                <MessageContentBlocks
                  blocks={renderedBlocks}
                  isUser={isUser}
                  enableTablePreview={enableTablePreview}
                  conversationMembers={conversationMembers}
                  workspaceActors={workspaceActors}
                  contactBasePath={contactBasePath}
                />
              </>
            )}

            {/* Citation sources footer */}
            {!interaction && hasCitations && (
              <CitationFooter sources={sources} />
            )}

            {/* Server tool calls (web_search / web_fetch) — inside the bubble */}
            {!interaction && hasServerToolCalls && (
              <ServerToolCallDisplay calls={serverToolCalls} />
            )}
          </div>
        </div>
          <div
            className={`mt-1 inline-flex max-w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-1 ${isUser ? "flex-row-reverse justify-start self-end" : "justify-start self-start"}`}
          >
          {timestamp && (
            <span className="text-[10px] text-muted-foreground/50">
              {new Date(timestamp).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
          )}
          {canRetryModelError ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-5 w-5 rounded-full text-muted-foreground/60 hover:text-foreground"
                  disabled={retryPending}
                  onClick={async () => {
                    await onRetryModelError?.(messageId)
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
      {contextMenuNode}
    </>
  )
}
