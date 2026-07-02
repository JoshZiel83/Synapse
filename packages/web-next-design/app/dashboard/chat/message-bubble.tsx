"use client"

import type {
  ComponentPropsWithoutRef,
  MouseEvent as ReactMouseEvent,
} from "react"
import type {
  ActorRuntimeState,
  CanonicalContentBlock,
  ConversationEntityRef,
  ConversationFeedItemSubtype,
  ConversationMessageTransportContext,
  ConversationMessageTransportDelivery,
  ConversationReplyRef,
  TaskSummary,
  RemoteAgentRuntimeState,
  Timestamp,
} from "@synapse/shared"
import {
  CONVERSATION_MESSAGE_SUBTYPE,
  CONVERSATION_PARTICIPANT_TYPE,
  TASK_REQUEST_KIND,
} from "@synapse/shared"
import {
  assertIsoInstant,
  type IsoInstantString,
} from "@synapse/shared/datetime"
import type {
  SharedRuntimeAuthorizationGrantSpec,
  RuntimeAuthorizationPreset,
  RuntimeAuthorizationRequestedAction,
} from "@synapse/shared/types"
import { useRouter } from "next/navigation"
import { createPortal } from "react-dom"
import { useEffect, useMemo, useRef, useState } from "react"
import dynamic from "next/dynamic"
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
  Download,
  Eye,
  AlertTriangle,
  AtSign,
  Copy,
  Check,
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
import {
  remoteAgentRuntimeToAvatarStatus,
  runtimeToAvatarStatus,
} from "@/stores/chat-store"
import type { ServerToolCall } from "@synapse/shared"
import type { ConversationMember } from "@/stores/chat-store"
import type { ChatTaskResolveInput, ChatTaskResolvePayload } from "@/lib/api"
import { cn, resolveContentUrl } from "@/lib/utils"
import ChatAvatar from "./chat-avatar"
import { isPreviewable, resolveFileType } from "./file-type"
import { getRuntimeDetail, getRuntimeLabel } from "./runtime-ui"
import { ToolIcon } from "./tool-icon"
import { buildReplyPreviewText, getEntityDisplayName } from "./reply-utils"
import { useConnectorMetadata } from "@/lib/im-connector-metadata"
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

type TaskResolutionDraftPayload = ChatTaskResolvePayload

interface MessageBubbleProps {
  kind?: "message" | "event"
  messageId: string
  role: string
  messageType?: ConversationFeedItemSubtype
  author?: ConversationEntityRef
  contentBlocks: CanonicalContentBlock[]
  actorName?: string
  actorAvatarUrl?: string
  actorEmoji?: string
  actorRole?: string
  actorRuntime?: ActorRuntimeState
  remoteAgentRuntime?: RemoteAgentRuntimeState
  timestamp?: Timestamp
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
  task?: TaskSummary
  enableTablePreview?: boolean
  viewerWorkspaceMemberId?: string
  contactBasePath?: string
  retryPending?: boolean
  onParticipantClick?: (member: ConversationMember) => void
  onQuoteMessage?: (replyTo: ConversationReplyRef) => void
  onRetryModelError?: (itemId: string) => Promise<void> | void
  onResolveTask?: (
    taskId: string,
    payload: ChatTaskResolveInput
  ) => Promise<TaskSummary | void> | TaskSummary | void
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
  const connectorMetadata = useConnectorMetadata()
  const inboundLabel =
    transport?.direction === "inbound" && transport.transportKind
      ? `via ${formatTransportKindLabel(
          transport.transportKind,
          connectorMetadata
        )}`
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
        const transportLabel = formatTransportKindLabel(
          delivery.transportKind,
          connectorMetadata
        )
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
  messageType?: ConversationFeedItemSubtype
  author?: ConversationEntityRef
  content: string
  contentBlocks: CanonicalContentBlock[]
  createdAt?: IsoInstantString
}) {
  return {
    itemId: input.messageId,
    itemType: "message" as const,
    subtype: input.messageType || CONVERSATION_MESSAGE_SUBTYPE.CHAT_MESSAGE,
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

type TaskDisplayState =
  | "pending"
  | "answered"
  | "approved"
  | "rejected"
  | "expired"
  | "cancelled"
  | "failed"

function isTaskOpen(task: TaskSummary) {
  return (
    task.lifecycleStatus === "submitted" ||
    task.lifecycleStatus === "working" ||
    task.lifecycleStatus === "input_required" ||
    task.lifecycleStatus === "auth_required"
  )
}

function getTaskDisplayState(task: TaskSummary): TaskDisplayState {
  if (isTaskOpen(task)) return "pending"
  if (task.lifecycleStatus === "cancelled") return "cancelled"
  if (task.lifecycleStatus === "expired") return "expired"
  if (task.lifecycleStatus === "failed") return "failed"
  if (task.kind === TASK_REQUEST_KIND.USER_INPUT) return "answered"
  if (task.kind === TASK_REQUEST_KIND.PLAN_APPROVAL) {
    return task.outcome === "approved" ? "approved" : "rejected"
  }
  return task.outcome === "granted" ? "approved" : "rejected"
}

function getTaskStateLabel(state: TaskDisplayState) {
  switch (state) {
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
    case "cancelled":
      return "Cancelled"
    case "failed":
      return "Failed"
    default:
      return state
  }
}

function getTaskStateBadgeClassName(state: TaskDisplayState) {
  switch (state) {
    case "answered":
    case "approved":
      return "border-emerald-500/25 bg-emerald-500/10 text-emerald-700"
    case "rejected":
    case "expired":
    case "cancelled":
    case "failed":
      return "border-destructive/25 bg-destructive/10 text-destructive"
    default:
      return "border-amber-500/25 bg-amber-500/10 text-amber-700"
  }
}

// Quiet, glanceable state indicator: a colored dot + label. Pending is implied
// by the action buttons, so it renders nothing (no redundant "Pending" chip).
function TaskStateChip({
  task,
  className,
}: {
  task: TaskSummary
  className?: string
}) {
  const state = getTaskDisplayState(task)
  if (state === "pending") return null
  const tone =
    state === "approved" || state === "answered"
      ? "text-emerald-600"
      : state === "rejected" ||
          state === "failed" ||
          state === "expired" ||
          state === "cancelled"
        ? "text-destructive"
        : "text-muted-foreground"
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-xs font-medium",
        tone,
        className
      )}
    >
      <span className="size-1.5 rounded-full bg-current" />
      {getTaskStateLabel(state)}
    </span>
  )
}

// Radio (single-select) or checkbox (multi-select) mark, in the accent color.
function OptionMark({
  multi,
  selected,
  submitting,
}: {
  multi: boolean
  selected: boolean
  submitting?: boolean
}) {
  if (submitting) {
    return (
      <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground" />
    )
  }
  if (multi) {
    return (
      <span
        className={cn(
          "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-[5px] border-2 transition-colors",
          selected
            ? "border-primary bg-primary text-primary-foreground"
            : "border-muted-foreground/35"
        )}
      >
        {selected ? <Check className="size-3" strokeWidth={3} /> : null}
      </span>
    )
  }
  return (
    <span
      className={cn(
        "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border-2 transition-colors",
        selected ? "border-primary" : "border-muted-foreground/35"
      )}
    >
      {selected ? <span className="size-1.5 rounded-full bg-primary" /> : null}
    </span>
  )
}

function formatRuntimeAuthorizationPresetLabel(
  preset: RuntimeAuthorizationPreset
) {
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

function getRuntimeAuthorizationCapabilityIcon(
  capability: SharedRuntimeAuthorizationGrantSpec["capability"]
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

function describeRuntimeAuthorizationSpec(
  scope: SharedRuntimeAuthorizationGrantSpec
) {
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
    // Use `"program" in cmd` as the narrowing predicate instead of
    // `cmd.executor === "exec_file"`. Both work when the shared
    // CommandlinePolicy discriminated union is correctly typed, but
    // the executor comparison surfaces a TS2367 "no overlap" error
    // if a consumer has a stale @synapse/shared dist (the kind a
    // monorepo can produce when shared isn't rebuilt before web-next
    // type-checks). The structural check is stable across those
    // builds and remains a true discriminator at runtime — only the
    // exec_file branch has `program`.
    const cmd = scope.commandline
    if ("program" in cmd) {
      const argv = cmd.argvPrefix ?? []
      const argvSummary = argv.length === 0 ? "" : ` ${argv.join(" ")}`
      const summaryLabel =
        cmd.commandMatchType === "argv_exact"
          ? "exec_file exact"
          : cmd.commandMatchType === "argv_prefix"
            ? "exec_file prefix"
            : "exec_file (preapproved)"
      return {
        icon: Wrench,
        summary: `${summaryLabel}: ${cmd.program}${argvSummary}`,
        detail: [
          cmd.workingDirectory
            ? `Working directory: ${cmd.workingDirectory}`
            : null,
          cmd.allowBundledToolchain
            ? "Bundled toolchain fallback allowed"
            : null,
          cmd.allowedEnv && cmd.allowedEnv.length > 0
            ? `Inherits env: ${cmd.allowedEnv.join(", ")}`
            : null,
        ]
          .filter((v): v is string => Boolean(v))
          .join("\n"),
      }
    }
    if (cmd.executor === "sandbox") {
      return {
        icon: Wrench,
        summary: "sandbox (confined shell)",
        detail: [
          "Any command inside the bwrap sandbox (no network)",
          cmd.workingDirectory
            ? `Working directory: ${cmd.workingDirectory}`
            : null,
          cmd.allowedEnv && cmd.allowedEnv.length > 0
            ? `Inherits env: ${cmd.allowedEnv.join(", ")}`
            : null,
        ]
          .filter((v): v is string => Boolean(v))
          .join("\n"),
      }
    }
    return {
      icon: Wrench,
      summary:
        cmd.commandMatchType === "exact"
          ? `${cmd.executor} exact`
          : cmd.commandMatchType === "prefix"
            ? `${cmd.executor} prefix`
            : `${cmd.executor} tool`,
      detail: [
        cmd.commandText || cmd.executor,
        cmd.workingDirectory
          ? `Working directory: ${cmd.workingDirectory}`
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

function describeRuntimeAuthorizationRequestedAction(
  action: RuntimeAuthorizationRequestedAction
) {
  return {
    icon: getRuntimeAuthorizationCapabilityIcon(action.capability),
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
  task: TaskSummary
): Record<string, DraftQuestionAnswer> {
  if (task.kind !== TASK_REQUEST_KIND.USER_INPUT || !task.userInput) {
    return {}
  }

  return Object.fromEntries(
    task.userInput.questions.map((question) => [
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
  question: NonNullable<TaskSummary["userInput"]>["questions"][number]
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

function TaskStatusNote({
  task,
  viewerCanResolve,
}: {
  task: TaskSummary
  viewerCanResolve: boolean
}) {
  const targetName = task.target?.name || "the selected user"
  const taskState = getTaskDisplayState(task)

  if (task.kind === TASK_REQUEST_KIND.USER_INPUT) {
    if (taskState === "pending") {
      return (
        <p className="text-xs text-muted-foreground">
          {viewerCanResolve
            ? "Only you can answer this input request."
            : `Waiting for ${targetName} to answer.`}
        </p>
      )
    }
    if (taskState === "answered") {
      const questionCount = task.userInput?.questions.length || 0
      const answerSummary =
        task.userInput?.questions
          .map((question) => {
            const summary = summarizeQuestionFieldAnswer(question)
            if (!summary) return ""
            return questionCount > 1
              ? `${question.prompt}: ${summary}`
              : summary
          })
          .filter((value) => value.length > 0)
          .join(" | ") || "a response"
      return (
        <p className="text-xs text-muted-foreground">
          {`${task.resolvedBy?.name || targetName} answered: ${answerSummary}.`}
        </p>
      )
    }
    return null
  }

  if (task.kind === TASK_REQUEST_KIND.PLAN_APPROVAL) {
    if (taskState === "pending") {
      return (
        <p className="text-xs text-muted-foreground">
          {viewerCanResolve
            ? "Approve the plan or request revisions."
            : `Waiting for ${targetName} to review the plan.`}
        </p>
      )
    }
    if (taskState === "approved") {
      return (
        <p className="text-xs text-muted-foreground">
          {`${task.resolvedBy?.name || targetName} approved the plan.`}
        </p>
      )
    }
    if (taskState === "rejected") {
      return (
        <p className="text-xs text-muted-foreground">
          {`${task.resolvedBy?.name || targetName} requested revisions.`}
        </p>
      )
    }
    return null
  }

  if (taskState === "pending") {
    return (
      <p className="text-xs text-muted-foreground">
        {viewerCanResolve
          ? "You can choose how broadly to allow this device action if you have runtime authorization permission."
          : "Waiting for an authorized user to approve or reject."}
      </p>
    )
  }
  if (taskState === "approved") {
    return (
      <p className="text-xs text-muted-foreground">
        The runtime authorization is active and the blocked action can continue.
      </p>
    )
  }
  if (taskState === "rejected") {
    return (
      <p className="text-xs text-muted-foreground">
        The authorization request was rejected.
      </p>
    )
  }
  if (taskState === "expired") {
    return (
      <p className="text-xs text-muted-foreground">
        This authorization request expired before it was resolved.
      </p>
    )
  }
  return null
}

function TaskCard({
  task,
  onResolveTask,
}: {
  task: TaskSummary
  onResolveTask?: MessageBubbleProps["onResolveTask"]
}) {
  const [submittingAction, setSubmittingAction] = useState<string | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [resolutionNoteDraft, setResolutionNoteDraft] = useState("")
  const [draftAnswers, setDraftAnswers] = useState<
    Record<string, DraftQuestionAnswer>
  >(() => buildDraftQuestionAnswers(task))
  const [selectedRuntimeGrantOptionId, setSelectedRuntimeGrantOptionId] =
    useState<string | null>(
      task.runtimeAuthorization?.grantOptions[0]?.id || null
    )

  const viewerCanResolve = task.viewerCanResolve === true
  const taskIsOpen = isTaskOpen(task)
  const canResolveUserInput =
    task.kind === TASK_REQUEST_KIND.USER_INPUT &&
    Boolean(onResolveTask) &&
    viewerCanResolve &&
    taskIsOpen
  const canResolvePlanApproval =
    task.kind === TASK_REQUEST_KIND.PLAN_APPROVAL &&
    Boolean(onResolveTask) &&
    viewerCanResolve &&
    taskIsOpen
  const canResolveRuntimeAuthorization =
    task.kind === TASK_REQUEST_KIND.RUNTIME_AUTHORIZATION &&
    Boolean(onResolveTask) &&
    viewerCanResolve &&
    taskIsOpen
  const canResolve =
    canResolveUserInput ||
    canResolvePlanApproval ||
    canResolveRuntimeAuthorization

  useEffect(() => {
    setSubmittingAction(null)
    setSubmitError(null)
    setResolutionNoteDraft("")
    setDraftAnswers(buildDraftQuestionAnswers(task))
    setSelectedRuntimeGrantOptionId(
      task.runtimeAuthorization?.grantOptions[0]?.id || null
    )
  }, [task.id, task.revision, task.lifecycleStatus, task.outcome])

  async function submitResolution(
    actionKey: string,
    payload: TaskResolutionDraftPayload
  ) {
    if (!onResolveTask || !canResolve) return
    setSubmittingAction(actionKey)
    setSubmitError(null)
    try {
      const commandId =
        typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : `task-${Date.now().toString(36)}-${Math.random()
              .toString(16)
              .slice(2)}`
      await onResolveTask(task.id, {
        ...payload,
        commandId,
        baseRevision: task.revision,
      })
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
    if (task.kind !== TASK_REQUEST_KIND.USER_INPUT || !task.userInput) {
      return []
    }

    return task.userInput.questions.map((question) => {
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

  if (task.kind === TASK_REQUEST_KIND.USER_INPUT && task.userInput) {
    const userInput = task.userInput
    const questions = userInput.questions
    const isSimpleSingleSelect =
      canResolveUserInput &&
      questions.length === 1 &&
      questions[0]?.type === "single_select" &&
      !questions[0]?.allowOther

    return (
      <div className="space-y-2.5">
        <div className="flex items-center gap-2">
          <MousePointerClick className="size-4 shrink-0 text-muted-foreground" />
          <span className="text-sm font-medium text-foreground">
            Input request
          </span>
          <TaskStateChip task={task} className="ml-auto" />
        </div>

        <div className="space-y-0.5">
          <p className="text-sm font-medium text-foreground">
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
              <div key={question.id} className="space-y-2">
                {shouldShowFieldHeading ? (
                  <div className="space-y-0.5">
                    <div className="text-sm font-medium text-foreground">
                      {question.prompt}
                      {question.required ? (
                        <span className="ml-1 text-muted-foreground">*</span>
                      ) : null}
                    </div>
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
                      className="min-h-20 resize-y rounded-lg bg-background text-sm"
                    />
                  ) : questionAnswerText ? (
                    <div className="text-sm whitespace-pre-wrap text-foreground">
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
                        // Single yes/no-style prompt: tapping an option submits
                        // immediately (no separate submit button).
                        return (
                          <Button
                            key={option.id}
                            type="button"
                            variant="outline"
                            size="sm"
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
                            className="h-auto w-full justify-start rounded-lg px-3 py-2 text-left font-normal"
                          >
                            {isSubmitting ? (
                              <Loader2 className="mr-2 size-4 shrink-0 animate-spin" />
                            ) : null}
                            <div className="min-w-0">
                              <div className="text-sm font-medium whitespace-normal">
                                {option.label}
                              </div>
                              {option.description ? (
                                <div className="mt-0.5 text-xs whitespace-normal text-muted-foreground">
                                  {option.description}
                                </div>
                              ) : null}
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
                              "flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors",
                              isSelected ? "bg-primary/8" : "hover:bg-muted/50"
                            )}
                          >
                            <OptionMark
                              multi={question.type === "multi_select"}
                              selected={isSelected}
                            />
                            <div className="min-w-0">
                              <div className="text-sm text-foreground">
                                {option.label}
                              </div>
                              {option.description ? (
                                <div className="mt-0.5 text-xs text-muted-foreground">
                                  {option.description}
                                </div>
                              ) : null}
                              {option.preview ? (
                                <div className="mt-1 font-mono text-xs text-muted-foreground">
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
                            "flex items-start gap-2.5 rounded-lg px-2.5 py-2",
                            isSelected ? "bg-primary/8" : "opacity-55"
                          )}
                        >
                          <OptionMark
                            multi={question.type === "multi_select"}
                            selected={isSelected}
                          />
                          <div className="min-w-0">
                            <div className="text-sm text-foreground">
                              {option.label}
                            </div>
                            {option.description ? (
                              <div className="mt-0.5 text-xs text-muted-foreground">
                                {option.description}
                              </div>
                            ) : null}
                            {option.preview ? (
                              <div className="mt-1 font-mono text-xs text-muted-foreground">
                                {option.preview}
                              </div>
                            ) : null}
                          </div>
                        </div>
                      )
                    })}

                    {question.allowOther ? (
                      canResolveUserInput ? (
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
                          placeholder="其它…"
                          disabled={Boolean(submittingAction)}
                          className="min-h-9 resize-y rounded-lg bg-background text-sm"
                        />
                      ) : question.answer?.otherText ? (
                        <div className="text-sm whitespace-pre-wrap text-foreground">
                          {`其它：${question.answer.otherText}`}
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
          <div className="flex items-center gap-2 pt-0.5">
            <Button
              type="button"
              size="sm"
              disabled={Boolean(submittingAction)}
              onClick={() =>
                void submitResolution("submit_answers", {
                  answers: buildUserInputAnswerPayload(),
                })
              }
            >
              {submittingAction === "submit_answers" ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <CheckCircle2 className="mr-1 h-4 w-4" />
              )}
              Submit response
            </Button>
          </div>
        ) : null}

        {!canResolveUserInput ? (
          <TaskStatusNote task={task} viewerCanResolve={viewerCanResolve} />
        ) : null}
        {task.resolutionNote ? (
          <p className="text-xs text-muted-foreground">
            “{task.resolutionNote}”
          </p>
        ) : null}
        {submitError ? (
          <p className="text-xs text-destructive">{submitError}</p>
        ) : null}
      </div>
    )
  }

  if (task.kind === TASK_REQUEST_KIND.PLAN_APPROVAL && task.planApproval) {
    const planApproval = task.planApproval

    return (
      <div className="space-y-2.5">
        {/* One header line: the type + a quiet state dot. No competing badges. */}
        <div className="flex items-center gap-2">
          <GitBranch className="size-4 shrink-0 text-muted-foreground" />
          <span className="text-sm font-medium text-foreground">
            Plan approval
          </span>
          <TaskStateChip task={task} className="ml-auto" />
        </div>

        <div className="space-y-0.5">
          <p className="text-sm font-medium text-foreground">
            {planApproval.title}
          </p>
          {planApproval.summary ? (
            <p className="text-xs leading-5 text-muted-foreground">
              {planApproval.summary}
            </p>
          ) : null}
        </div>

        {/* De-nested: the bubble is already a surface, so the plan is a subtle
            tinted panel, not a bordered card inside a card. */}
        <div className="prose prose-sm prose-p:my-1.5 prose-li:my-0.5 prose-ul:my-1.5 prose-ol:my-1.5 prose-headings:text-foreground max-w-none rounded-lg bg-muted/40 px-3.5 py-2.5 text-foreground">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {planApproval.planMarkdown}
          </ReactMarkdown>
        </div>

        {planApproval.checklist?.length ? (
          <ul className="space-y-1">
            {planApproval.checklist.map((step, index) => (
              <li
                key={`${step.step}-${index}`}
                className="flex items-center justify-between gap-3 text-sm"
              >
                <span className="min-w-0 truncate text-foreground">
                  {step.step}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {step.status}
                </span>
              </li>
            ))}
          </ul>
        ) : null}

        {canResolvePlanApproval ? (
          <div className="space-y-2 pt-0.5">
            <Textarea
              value={resolutionNoteDraft}
              onChange={(event) => setResolutionNoteDraft(event.target.value)}
              placeholder="Add a note (optional)"
              disabled={Boolean(submittingAction)}
              className="min-h-16 resize-y rounded-lg bg-background text-sm"
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="sm"
                disabled={Boolean(submittingAction)}
                onClick={() =>
                  void submitResolution("approve_plan", {
                    decision: "approve",
                    note: resolutionNoteDraft.trim() || undefined,
                  })
                }
              >
                {submittingAction === "approve_plan" ? (
                  <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                ) : (
                  <CheckCircle2 className="mr-1 h-4 w-4" />
                )}
                Approve plan
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={Boolean(submittingAction)}
                onClick={() =>
                  void submitResolution("revise_plan", {
                    decision: "revise",
                    note: resolutionNoteDraft.trim() || undefined,
                  })
                }
              >
                {submittingAction === "revise_plan" ? (
                  <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                ) : (
                  <RotateCcw className="mr-1 h-4 w-4" />
                )}
                Request changes
              </Button>
            </div>
          </div>
        ) : (
          // The action buttons already say what to do, so only surface a status
          // line when the viewer can't act (resolved, or waiting on someone).
          <TaskStatusNote task={task} viewerCanResolve={viewerCanResolve} />
        )}

        {task.resolutionNote ? (
          <p className="text-xs text-muted-foreground">
            “{task.resolutionNote}”
          </p>
        ) : null}
        {submitError ? (
          <p className="text-xs text-destructive">{submitError}</p>
        ) : null}
      </div>
    )
  }

  if (
    task.kind === TASK_REQUEST_KIND.RUNTIME_AUTHORIZATION &&
    task.runtimeAuthorization
  ) {
    const runtimeAuthorization = task.runtimeAuthorization
    if (!runtimeAuthorization) {
      return null
    }

    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Shield className="size-4 shrink-0 text-muted-foreground" />
          <span className="text-sm font-medium text-foreground">
            Runtime authorization
          </span>
          <TaskStateChip task={task} className="ml-auto" />
        </div>

        <div className="space-y-0.5">
          <p className="text-sm font-medium text-foreground">
            {`Authorize ${runtimeAuthorization.deviceToolStableKey} on ${runtimeAuthorization.deviceDisplayName}`}
          </p>
          <p className="text-xs leading-5 text-muted-foreground">
            {runtimeAuthorization.reason}
          </p>
        </div>

        <div className="grid gap-2 rounded-lg bg-muted/40 px-3.5 py-2.5">
          <div>
            <div className="text-xs text-muted-foreground">Exposure</div>
            <div className="mt-0.5 text-sm text-foreground">
              {runtimeAuthorization.exposureDisplayName}
            </div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">
              Requested action
            </div>
            <div className="mt-1">
              {(() => {
                const described = describeRuntimeAuthorizationRequestedAction(
                  runtimeAuthorization.requestedAction
                )
                const RequestedIcon = described.icon
                return (
                  <div className="flex items-start gap-2 text-sm text-foreground">
                    <RequestedIcon className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                    <div className="min-w-0">
                      <div>{described.summary}</div>
                      {described.detail ? (
                        <div className="mt-0.5 text-xs break-all whitespace-pre-wrap text-muted-foreground">
                          {described.detail}
                        </div>
                      ) : null}
                    </div>
                  </div>
                )
              })()}
            </div>
          </div>
          {runtimeAuthorization.approvedGrant ? (
            <div className="rounded-2xl border border-emerald-500/25 bg-emerald-500/10 px-4 py-3">
              <div className="text-[11px] font-medium tracking-[0.08em] text-emerald-700/80 uppercase">
                Approved Authorization
              </div>
              <div className="mt-2 space-y-2">
                {(() => {
                  const described = describeRuntimeAuthorizationSpec(
                    runtimeAuthorization.approvedGrant
                  )
                  const ApprovedIcon = described.icon
                  return (
                    <div className="flex items-start gap-2 text-sm text-foreground">
                      <ApprovedIcon className="mt-0.5 h-4 w-4 shrink-0 text-emerald-700" />
                      <div className="min-w-0">
                        <div>{described.summary}</div>
                        {described.detail ? (
                          <div className="mt-0.5 text-xs break-all whitespace-pre-wrap text-muted-foreground">
                            {described.detail}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  )
                })()}
                {runtimeAuthorization.approvedPreset ? (
                  <div className="text-[11px] text-emerald-700/80">
                    {formatRuntimeAuthorizationPresetLabel(
                      runtimeAuthorization.approvedPreset
                    )}
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>

        {canResolve ? (
          <div className="space-y-3">
            {runtimeAuthorization.grantOptions.length === 0 ? (
              // v3.1 §clarification #33: scope-less runtime_active_page tools
              // surface here with grantOptions:[]. Show a manual-grant
              // explainer instead of a useless empty approve UI.
              <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-foreground">
                <div className="text-[11px] font-medium tracking-[0.08em] text-amber-800 uppercase dark:text-amber-300">
                  Manual grant required
                </div>
                <p className="mt-2 text-sm">
                  This tool needs a target origin/scope you haven&apos;t
                  granted. Open{" "}
                  <a
                    href="/dashboard/settings/runtime-authorizations"
                    className="font-medium underline underline-offset-2"
                  >
                    Settings → Runtime Authorizations
                  </a>{" "}
                  to add a grant for this capability, then re-trigger the tool.
                </p>
                {(() => {
                  const ra = runtimeAuthorization.requestedAction as {
                    browser?: { scopeSource?: string }
                  }
                  const src = ra.browser?.scopeSource
                  return src ? (
                    <p className="mt-2 text-[11px] text-muted-foreground">
                      scopeSource: <code>{src}</code>
                    </p>
                  ) : null
                })()}
              </div>
            ) : (
              <div className="rounded-2xl border border-border/70 bg-muted/20 px-4 py-3">
                <div className="text-[11px] font-medium tracking-[0.08em] text-muted-foreground/70 uppercase">
                  Authorization Range
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {runtimeAuthorization.grantOptions.map((option) => {
                    const selected = selectedRuntimeGrantOptionId === option.id
                    return (
                      <Button
                        key={option.id}
                        type="button"
                        variant={selected ? "default" : "outline"}
                        size="sm"
                        disabled={Boolean(submittingAction)}
                        onClick={() =>
                          setSelectedRuntimeGrantOptionId(option.id)
                        }
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
            )}

            {runtimeAuthorization.grantOptions.length > 0 ? (
              <div className="rounded-2xl border border-border/70 bg-muted/20 px-4 py-3">
                <div className="text-[11px] font-medium tracking-[0.08em] text-muted-foreground/70 uppercase">
                  Applies To
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {runtimeAuthorization.availablePresets.map((preset) => (
                    <Badge
                      key={preset}
                      variant="outline"
                      className="rounded-full"
                    >
                      {formatRuntimeAuthorizationPresetLabel(preset)}
                    </Badge>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="flex flex-wrap items-center gap-2">
              {runtimeAuthorization.grantOptions.length > 0
                ? runtimeAuthorization.availablePresets.map((preset) => (
                    <Button
                      key={preset}
                      type="button"
                      variant={preset === "once" ? "default" : "outline"}
                      disabled={
                        Boolean(submittingAction) ||
                        !selectedRuntimeGrantOptionId
                      }
                      onClick={() =>
                        selectedRuntimeGrantOptionId
                          ? void submitResolution(`approve_${preset}`, {
                              decision: "approve",
                              preset,
                              selectedGrantOptionId:
                                selectedRuntimeGrantOptionId,
                              note: resolutionNoteDraft.trim() || undefined,
                            })
                          : undefined
                      }
                      className="rounded-full"
                    >
                      {submittingAction === `approve_${preset}` ? (
                        <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                      ) : (
                        <CheckCircle2 className="mr-1 h-4 w-4" />
                      )}
                      {formatRuntimeAuthorizationPresetLabel(preset)}
                    </Button>
                  ))
                : null}
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

        <TaskStatusNote task={task} viewerCanResolve={viewerCanResolve} />
        {task.resolutionNote ? (
          <div className="rounded-xl border border-border/70 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
            {task.resolutionNote}
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
          member.participantType === CONVERSATION_PARTICIPANT_TYPE.ACTOR &&
          member.id === mention.actorId) ||
        (mention.workspaceMemberId &&
          member.participantType ===
            CONVERSATION_PARTICIPANT_TYPE.WORKSPACE_MEMBER &&
          member.id === mention.workspaceMemberId) ||
        (mention.externalUserKey &&
          member.participantType === CONVERSATION_PARTICIPANT_TYPE.EXTERNAL &&
          member.externalUserKey === mention.externalUserKey)
    ) || null

  if (matchedMember) return matchedMember

  if (mention.participantType === CONVERSATION_PARTICIPANT_TYPE.ACTOR) {
    const actor = workspaceActors?.find(
      (candidate) => candidate.id === mention.actorId
    )
    const fallbackId =
      mention.actorId || mention.participantId || "unknown-actor"

    return {
      participantId: mention.participantId || fallbackId,
      participantType: CONVERSATION_PARTICIPANT_TYPE.ACTOR,
      id: mention.actorId || actor?.id || fallbackId,
      name: mention.name || actor?.name || "Unknown actor",
      role: mention.role || actor?.role,
      title: mention.title || actor?.title,
      emoji: mention.avatarEmoji || actor?.emoji,
      avatarUrl: mention.avatarUrl || actor?.avatarUrl,
    }
  }

  if (
    mention.participantType === CONVERSATION_PARTICIPANT_TYPE.WORKSPACE_MEMBER
  ) {
    const fallbackId =
      mention.workspaceMemberId || mention.participantId || "unknown-user"

    return {
      participantId: mention.participantId || fallbackId,
      participantType: CONVERSATION_PARTICIPANT_TYPE.WORKSPACE_MEMBER,
      id: mention.workspaceMemberId || fallbackId,
      name: mention.name || "Unknown user",
      role: mention.role,
      title: mention.title,
      emoji: mention.avatarEmoji,
      avatarUrl: mention.avatarUrl,
    }
  }

  if (mention.participantType === CONVERSATION_PARTICIPANT_TYPE.REMOTE_AGENT) {
    const fallbackId =
      mention.remoteAgentId || mention.participantId || "unknown-remote-agent"

    return {
      participantId: mention.participantId || fallbackId,
      participantType: CONVERSATION_PARTICIPANT_TYPE.REMOTE_AGENT,
      id: mention.remoteAgentId || fallbackId,
      name: mention.name || "Unknown remote agent",
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
    participantType: CONVERSATION_PARTICIPANT_TYPE.EXTERNAL,
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

// Dynamic, client-only media viewers — each mounts a browser-only engine (Web
// Audio, video custom elements, pdf.js worker), so keep them out of SSR and the
// message-timeline bundle; they load when a bubble/viewer first mounts.
const VoiceBubble = dynamic(() => import("./media/voice-bubble"), {
  ssr: false,
  loading: () => (
    <div className="h-[52px] w-64 max-w-full animate-pulse rounded-lg bg-muted" />
  ),
})
const VideoPlayer = dynamic(() => import("./media/video-player"), {
  ssr: false,
  loading: () => (
    <div className="aspect-video w-80 max-w-full animate-pulse rounded-lg bg-muted" />
  ),
})
const ImageLightbox = dynamic(() => import("./media/image-lightbox"), {
  ssr: false,
})
const DocumentPreview = dynamic(() => import("./media/document-preview"), {
  ssr: false,
})

// A flat typed document launcher card. Previewable types (pdf/docx/xlsx/…) open
// the in-app viewer; everything else is a plain download link. The glyph + tint
// are keyed to the file type, always paired with an uppercase EXT label so type
// never rides on color alone.
function DocumentCard({
  block,
  url,
  onPreview,
}: {
  block: FileRefBlock
  url?: string
  onPreview: () => void
}) {
  const ft = resolveFileType(block.name, block.category)
  const canPreview = isPreviewable(ft.ext)
  const cls =
    "group/file flex w-full max-w-xs items-center gap-3 rounded-xl border border-gray-200 bg-gray-50 px-3 py-2.5 text-left transition-colors hover:bg-gray-100 dark:border-white/[0.06] dark:bg-white/[0.03] dark:hover:bg-white/[0.06]"
  const inner = (
    <>
      <div
        className={cn(
          "flex size-10 shrink-0 items-center justify-center rounded-lg",
          ft.tile
        )}
      >
        <ft.Icon className={cn("size-[22px]", ft.tint)} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-foreground/90">
          {block.name}
        </div>
        <div className="text-xs text-muted-foreground">
          {ft.ext} · {formatBytes(block.sizeBytes)}
        </div>
      </div>
      {canPreview ? (
        <Eye className="size-4 shrink-0 text-muted-foreground/40 transition-colors group-hover/file:text-primary" />
      ) : (
        <Download className="size-4 shrink-0 text-muted-foreground/40 transition-colors group-hover/file:text-primary" />
      )}
    </>
  )
  return canPreview ? (
    <button type="button" onClick={onPreview} className={cls}>
      {inner}
    </button>
  ) : (
    <a href={url} target="_blank" rel="noopener noreferrer" className={cls}>
      {inner}
    </a>
  )
}

function FileBlockPreview({ blocks }: { blocks: FileRefBlock[] }) {
  // Every image in the message forms one paginated lightbox gallery.
  const imageBlocks = useMemo(
    () => blocks.filter((b) => b.category === "image"),
    [blocks]
  )
  const slides = useMemo(
    () =>
      imageBlocks.map((b) => ({
        src: resolveContentUrl(b.sha256) ?? "",
        title: b.name,
      })),
    [imageBlocks]
  )
  const [lightboxIndex, setLightboxIndex] = useState(-1)
  const [previewDoc, setPreviewDoc] = useState<{
    url?: string
    name: string
    ext: string
  } | null>(null)

  if (blocks.length === 0) return null

  return (
    <>
      <div className="space-y-2">
        {blocks.map((block) => {
          const cat = block.category
          const resolvedUrl = resolveContentUrl(block.sha256)

          if (cat === "image") {
            const idx = imageBlocks.indexOf(block)
            return (
              <div key={block.id}>
                <img
                  src={resolvedUrl}
                  alt={block.name}
                  className="max-h-80 max-w-xs cursor-pointer rounded-lg border border-gray-200 object-contain transition-opacity hover:opacity-90 dark:border-white/[0.06]"
                  onClick={() => setLightboxIndex(idx)}
                />
              </div>
            )
          }

          if (cat === "audio") {
            return (
              <VoiceBubble key={block.id} url={resolvedUrl} name={block.name} />
            )
          }

          if (cat === "video") {
            return (
              <VideoPlayer
                key={block.id}
                url={resolvedUrl}
                mimeType={block.mimeType}
                title={block.name}
              />
            )
          }

          return (
            <DocumentCard
              key={block.id}
              block={block}
              url={resolvedUrl}
              onPreview={() =>
                setPreviewDoc({
                  url: resolvedUrl,
                  name: block.name,
                  ext: resolveFileType(block.name, cat).ext,
                })
              }
            />
          )
        })}
      </div>

      {slides.length > 0 && (
        <ImageLightbox
          slides={slides}
          index={lightboxIndex}
          onClose={() => setLightboxIndex(-1)}
        />
      )}
      {previewDoc && (
        <DocumentPreview
          url={previewDoc.url}
          name={previewDoc.name}
          ext={previewDoc.ext}
          open
          onClose={() => setPreviewDoc(null)}
        />
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
    const { markdown, mentionBlocksById } =
      serializeInlineBlocksToMarkdown(blocks)

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
      {expanded ? (
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
      ) : null}
    </>
  )
}

function ServerToolCallDisplay({ calls }: { calls: ServerToolCall[] }) {
  const [expanded, setExpanded] = useState(false)

  if (calls.length === 0) return null

  // Data-driven: render the server-computed display model (icon + title +
  // optional detail + clickable result links) — no per-tool-type branching. The
  // API (from-generate-text) owns the labels; the FE only renders structure.
  const totalResults = calls.reduce(
    (sum, c) =>
      sum + (c.display?.resultLinks?.length || c.results?.length || 0),
    0
  )
  const summary =
    `${calls.length} 个工具调用` +
    (totalResults > 0 ? ` · ${totalResults} 个结果` : "")

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
        <span className="font-medium">{summary}</span>
      </button>

      {expanded ? (
        <div className="mt-2 space-y-2">
          {calls.map((call, i) => {
            const links = call.display?.resultLinks ?? call.results ?? []
            return (
              <div
                key={i}
                className="rounded-lg bg-gray-50 p-2.5 ring-1 ring-gray-200 dark:bg-white/[0.03] dark:ring-white/[0.06]"
              >
                <div className="flex items-center gap-1.5 text-[11px] text-primary">
                  <ToolIcon name={call.display?.icon} className="h-3 w-3" />
                  <span className="font-medium">
                    {call.display?.displayTitle ?? call.toolName ?? call.type}
                  </span>
                  {call.display?.displayDetail ? (
                    <span className="text-muted-foreground/60">
                      · {call.display.displayDetail}
                    </span>
                  ) : null}
                </div>
                {links.length > 0 ? (
                  <div className="mt-1.5 space-y-1">
                    {links.slice(0, 5).map((r, j) => (
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
                          {r.pageAge ? (
                            <span className="ml-1 text-muted-foreground/40">
                              · {r.pageAge}
                            </span>
                          ) : null}
                        </span>
                      </a>
                    ))}
                    {links.length > 5 ? (
                      <span className="ml-4 text-[10px] text-muted-foreground/40">
                        +{links.length - 5} 更多结果
                      </span>
                    ) : null}
                  </div>
                ) : null}
                {call.url && links.length === 0 ? (
                  <a
                    href={call.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-1 block truncate text-[10px] text-muted-foreground/60 transition-colors hover:text-primary"
                  >
                    {call.url}
                  </a>
                ) : null}
              </div>
            )
          })}
        </div>
      ) : null}
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
  remoteAgentRuntime,
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
  task,
  enableTablePreview = false,
  viewerWorkspaceMemberId,
  contactBasePath = "/dashboard/contacts",
  retryPending = false,
  onParticipantClick,
  onQuoteMessage,
  onRetryModelError,
  onResolveTask,
}: MessageBubbleProps) {
  const router = useRouter()
  const isMobile = useIsMobile()
  const connectorMetadata = useConnectorMetadata()
  const isChildResult = role === "child_result"
  const isSystem = role === "system"
  const isError = role === "error"
  const textContent = useMemo(() => extractText(contentBlocks), [contentBlocks])
  const viewerUserMember = useMemo(() => {
    if (!viewerWorkspaceMemberId) return undefined
    return conversationMembers?.find(
      (member) =>
        member.participantType ===
          CONVERSATION_PARTICIPANT_TYPE.WORKSPACE_MEMBER &&
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
    if (author?.participantType === CONVERSATION_PARTICIPANT_TYPE.EXTERNAL) {
      return CONVERSATION_PARTICIPANT_TYPE.EXTERNAL
    }
    if (
      author?.participantType === CONVERSATION_PARTICIPANT_TYPE.WORKSPACE_MEMBER
    ) {
      return CONVERSATION_PARTICIPANT_TYPE.WORKSPACE_MEMBER
    }
    if (
      author?.participantType === CONVERSATION_PARTICIPANT_TYPE.REMOTE_AGENT
    ) {
      return CONVERSATION_PARTICIPANT_TYPE.REMOTE_AGENT
    }
    return CONVERSATION_PARTICIPANT_TYPE.ACTOR
  }, [author?.participantType])
  const resolvedAuthorName = useMemo(() => {
    if (
      author?.participantType === CONVERSATION_PARTICIPANT_TYPE.WORKSPACE_MEMBER
    ) {
      if (
        author.workspaceMemberId &&
        author.workspaceMemberId === viewerWorkspaceMemberId
      )
        return "You"
      return author.name || authorMember?.name || "User"
    }
    if (author?.participantType === CONVERSATION_PARTICIPANT_TYPE.EXTERNAL) {
      return author.name || authorMember?.name || "External participant"
    }
    if (
      author?.participantType === CONVERSATION_PARTICIPANT_TYPE.REMOTE_AGENT
    ) {
      return author.name || authorMember?.name || "Remote agent"
    }
    if (author?.participantType === CONVERSATION_PARTICIPANT_TYPE.ACTOR) {
      return author.name || actorName || authorMember?.name || "Actor"
    }
    return actorName || (isUser ? "You" : "Member")
  }, [actorName, author, authorMember, isUser, viewerWorkspaceMemberId])
  const resolvedAuthorAvatarUrl =
    authorEntityType === CONVERSATION_PARTICIPANT_TYPE.ACTOR
      ? actorAvatarUrl || author?.avatarUrl || authorMember?.avatarUrl
      : authorMember?.avatarUrl || author?.avatarUrl
  const resolvedAuthorEmoji =
    authorEntityType === CONVERSATION_PARTICIPANT_TYPE.ACTOR
      ? actorEmoji || author?.avatarEmoji || authorMember?.emoji
      : authorMember?.emoji || author?.avatarEmoji
  const resolvedAuthorSubtitle = useMemo(() => {
    if (author?.participantType === CONVERSATION_PARTICIPANT_TYPE.ACTOR) {
      return (
        actorRole ||
        author?.title ||
        author?.role ||
        authorMember?.title ||
        authorMember?.role ||
        "Actor"
      )
    }
    if (author?.participantType === CONVERSATION_PARTICIPANT_TYPE.EXTERNAL) {
      return authorMember
        ? getConversationMemberSubtitle(authorMember, connectorMetadata)
        : "External participant"
    }
    if (
      author?.participantType === CONVERSATION_PARTICIPANT_TYPE.REMOTE_AGENT
    ) {
      return (
        author?.title ||
        author?.role ||
        authorMember?.title ||
        authorMember?.role ||
        "Remote agent"
      )
    }
    if (
      author?.participantType === CONVERSATION_PARTICIPANT_TYPE.WORKSPACE_MEMBER
    ) {
      return author.workspaceMemberId &&
        author.workspaceMemberId === viewerWorkspaceMemberId
        ? "You"
        : "Workspace member"
    }
    return undefined
  }, [actorRole, author, authorMember, viewerWorkspaceMemberId])
  const authorStatusState =
    authorEntityType === CONVERSATION_PARTICIPANT_TYPE.ACTOR
      ? runtimeToAvatarStatus(actorRuntime)
      : authorEntityType === CONVERSATION_PARTICIPANT_TYPE.REMOTE_AGENT
        ? remoteAgentRuntimeToAvatarStatus(remoteAgentRuntime)
        : undefined
  const authorStatusLabel =
    authorEntityType === CONVERSATION_PARTICIPANT_TYPE.ACTOR ||
    authorEntityType === CONVERSATION_PARTICIPANT_TYPE.REMOTE_AGENT
      ? getRuntimeLabel(
          authorEntityType === CONVERSATION_PARTICIPANT_TYPE.ACTOR
            ? actorRuntime
            : remoteAgentRuntime
        )
      : undefined
  const authorStatusDetail =
    authorEntityType === CONVERSATION_PARTICIPANT_TYPE.ACTOR ||
    authorEntityType === CONVERSATION_PARTICIPANT_TYPE.REMOTE_AGENT
      ? getRuntimeDetail(
          authorEntityType === CONVERSATION_PARTICIPANT_TYPE.ACTOR
            ? actorRuntime
            : remoteAgentRuntime
        )
      : undefined

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
  const canCopyMessage = kind === "message" && !task
  const canQuoteMessage =
    kind === "message" &&
    !task &&
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
      (selectedText ? 1 : 0) +
      (canCopyMessage ? 1 : 0) +
      (canQuoteMessage ? 1 : 0)
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
        createdAt: timestamp ? assertIsoInstant(timestamp) : undefined,
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
        createdAt: timestamp ? assertIsoInstant(timestamp) : undefined,
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
          {timestamp ? (
            <span className="mt-1 text-[10px] text-muted-foreground/50">
              {new Date(timestamp).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
          ) : null}
        </div>
      </div>
    )
  }

  if (isSystem && !task) {
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
    messageType === CONVERSATION_MESSAGE_SUBTYPE.MODEL_ERROR_NOTICE &&
    viewerParticipantId &&
    restrictedAudienceParticipantIds?.includes(viewerParticipantId) &&
    onRetryModelError
  )
  const shouldRenderCompact = !task && !isUser && coordination

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
                      <span className="shrink-0 text-muted-foreground/40">
                        ·
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          setCompactExpanded((current) => !current)
                        }
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
            entityType={CONVERSATION_PARTICIPANT_TYPE.WORKSPACE_MEMBER}
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
            statusState={authorStatusState}
            statusLabel={authorStatusLabel}
            statusDetail={authorStatusDetail}
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
                statusState={authorStatusState}
                suppressStatusTooltip
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
              statusState={authorStatusState}
              statusLabel={authorStatusLabel}
              statusDetail={authorStatusDetail}
            />
          </button>
        ) : (
          <ChatAvatar
            name={resolvedAuthorName}
            avatarUrl={resolvedAuthorAvatarUrl}
            emoji={resolvedAuthorEmoji}
            entityType={authorEntityType}
            className="mt-1 shrink-0"
            statusState={authorStatusState}
            statusLabel={authorStatusLabel}
            statusDetail={authorStatusDetail}
          />
        )}

        <div
          className={`flex w-full max-w-[75%] min-w-0 flex-col ${isUser ? "items-end" : "items-start"}`}
        >
          {!isUser && resolvedAuthorName ? (
            <div className="mb-1 ml-1 self-start text-xs text-muted-foreground/70">
              {authorMember && !isMobile ? (
                <ChatParticipantHoverCard
                  member={authorMember}
                  contactBasePath={contactBasePath}
                  statusState={authorStatusState}
                  statusLabel={authorStatusLabel}
                  statusDetail={authorStatusDetail}
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
          ) : null}
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
              {task ? (
                <TaskCard task={task} onResolveTask={onResolveTask} />
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
              {!task && hasCitations ? (
                <CitationFooter sources={sources} />
              ) : null}

              {/* Server tool calls (web_search / web_fetch) — inside the bubble */}
              {!task && hasServerToolCalls ? (
                <ServerToolCallDisplay calls={serverToolCalls} />
              ) : null}
            </div>
          </div>
          <div
            className={`mt-1 inline-flex max-w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-1 ${isUser ? "flex-row-reverse justify-start self-end" : "justify-start self-start"}`}
          >
            {timestamp ? (
              <span className="text-[10px] text-muted-foreground/50">
                {new Date(timestamp).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
            ) : null}
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
            {status === "sending" ? (
              <span className="text-[10px] text-muted-foreground/40">
                Sending...
              </span>
            ) : null}
            {status === "retrying" ? (
              <span className="text-[10px] text-destructive/80">
                Retrying...
              </span>
            ) : null}
            {hasToolsUsed && !hasServerToolCalls ? (
              <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground/50">
                <Wrench className="h-2.5 w-2.5" />
                {formatToolsUsed(toolsUsed)}
              </span>
            ) : null}
          </div>
        </div>
      </div>
      {contextMenuNode}
    </>
  )
}
