"use client"

import type {
  ActorRuntimeState,
  ActorRuntimeTurnActivityDetail,
  CanonicalContentBlock,
} from "@synapse/shared"
import {
  getActorRuntimeCurrentTool,
  getActorRuntimeProcessingTargets,
} from "@synapse/shared"
import { useEffect, useMemo, useState } from "react"
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FileIcon,
  Loader2,
  UserRound,
  XCircle,
} from "lucide-react"
import { api } from "@/lib/api"
import { cn, resolveContentUrl } from "@/lib/utils"
import type { ConversationMember } from "@/stores/chat-store"
import {
  runtimePhaseToBadgePhase,
  runtimeToAvatarStatus,
} from "@/stores/chat-store"
import ChatAvatar from "./chat-avatar"

function formatTargetsLabel(runtime: ActorRuntimeState) {
  const targets = getActorRuntimeProcessingTargets(runtime)
  if (targets.length === 0) {
    return "Active in the current turn"
  }

  const names = targets.map((target) => target.name).filter(Boolean)
  if (names.length <= 2) {
    return `Processing ${names.join(", ")}`
  }
  return `Processing ${names.slice(0, 2).join(", ")} +${names.length - 2}`
}

function formatToolStateLabel(state: string) {
  switch (state) {
    case "running":
      return "Running"
    case "pending":
      return "Pending"
    case "input_required":
      return "Needs input"
    case "completed":
      return "Completed"
    case "failed":
      return "Failed"
    case "cancelled":
      return "Cancelled"
    case "skipped":
      return "Skipped"
    default:
      return "Working"
  }
}

function getToolStateTone(state: string) {
  switch (state) {
    case "completed":
      return "text-emerald-600 bg-emerald-500/10 border-emerald-500/20"
    case "failed":
    case "cancelled":
      return "text-destructive bg-destructive/10 border-destructive/20"
    case "input_required":
      return "text-amber-700 bg-amber-500/10 border-amber-500/20"
    default:
      return "text-sky-700 bg-sky-500/10 border-sky-500/20"
  }
}

function ToolStateIcon({ state }: { state: string }) {
  switch (state) {
    case "completed":
      return <CheckCircle2 className="size-3.5" />
    case "failed":
    case "cancelled":
      return <XCircle className="size-3.5" />
    case "input_required":
      return <AlertTriangle className="size-3.5" />
    default:
      return <Loader2 className="size-3.5 animate-spin" />
  }
}

function ActivityBlocks({ blocks }: { blocks: CanonicalContentBlock[] }) {
  if (blocks.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
        No detail yet
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      {blocks.map((block) => {
        if (block.type === "text") {
          return (
            <pre
              key={block.id}
              className="rounded-2xl border border-border/70 bg-background px-3 py-2 text-xs break-words whitespace-pre-wrap text-foreground"
            >
              {block.text}
            </pre>
          )
        }

        if (block.type === "mention") {
          return (
            <div
              key={block.id}
              className="inline-flex w-fit items-center gap-1 rounded-full border border-border bg-background px-2.5 py-1 text-xs text-foreground"
            >
              <UserRound className="size-3" />
              <span>{block.mention.name || block.mention.participantType}</span>
            </div>
          )
        }

        return (
          <a
            key={block.id}
            href={resolveContentUrl(block.sha256)}
            target="_blank"
            rel="noreferrer"
            className="inline-flex w-fit items-center gap-2 rounded-2xl border border-border bg-background px-3 py-2 text-xs text-foreground transition-colors hover:border-primary/40 hover:text-primary"
          >
            <FileIcon className="size-3.5" />
            <span className="truncate">{block.name}</span>
          </a>
        )
      })}
    </div>
  )
}

interface ActorActivityBubbleProps {
  conversationId: string
  workspaceId?: string
  runtime: ActorRuntimeState
  member?: ConversationMember
}

export default function ActorActivityBubble({
  conversationId,
  workspaceId,
  runtime,
  member,
}: ActorActivityBubbleProps) {
  const preview = runtime.currentTurnPreview
  const previewTool = getActorRuntimeCurrentTool(runtime)
  const [expanded, setExpanded] = useState(false)
  const [detail, setDetail] = useState<ActorRuntimeTurnActivityDetail | null>(
    null
  )
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setExpanded(false)
    setDetail(null)
    setError(null)
  }, [runtime.actorId, preview?.turnId])

  useEffect(() => {
    if (!expanded || !workspaceId || !preview?.turnId) {
      return
    }

    let cancelled = false
    setLoading(true)

    void api
      .getChatConversationRuntimeTurnDetail(
        workspaceId,
        conversationId,
        runtime.actorId,
        preview.turnId
      )
      .then((response) => {
        if (cancelled) return
        setDetail(response)
        setError(null)
      })
      .catch((fetchError) => {
        if (cancelled) return
        setError(
          fetchError instanceof Error
            ? fetchError.message
            : "Failed to load activity detail"
        )
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [
    conversationId,
    expanded,
    preview?.turnId,
    runtime.actorId,
    runtime.updatedAt,
    workspaceId,
  ])

  const countsLabel = useMemo(() => {
    if (!preview || preview.totalToolCallCount === 0) return null
    const parts = [
      `${preview.totalToolCallCount} tool${preview.totalToolCallCount === 1 ? "" : "s"}`,
    ]
    if (preview.completedToolCallCount > 0) {
      parts.push(`${preview.completedToolCallCount} done`)
    }
    if (preview.failedToolCallCount > 0) {
      parts.push(`${preview.failedToolCallCount} failed`)
    }
    return parts.join(" · ")
  }, [preview])

  return (
    <div className="flex w-full max-w-full min-w-0 gap-3">
      <ChatAvatar
        name={runtime.actorName}
        avatarUrl={member?.avatarUrl}
        emoji={member?.emoji}
        entityType="actor"
        size="default"
        statusState={runtimeToAvatarStatus(runtime)}
        statusPhase={runtimePhaseToBadgePhase(runtime)}
        statusLabel={
          previewTool ? formatToolStateLabel(previewTool.state) : "Active"
        }
        statusDetail={formatTargetsLabel(runtime)}
        className="mt-1"
      />
      <div className="flex max-w-[85%] min-w-0 flex-1 flex-col gap-2">
        <button
          type="button"
          disabled={!preview?.turnId}
          onClick={() => setExpanded((current) => !current)}
          className={cn(
            "flex min-w-0 flex-col gap-2 rounded-[28px] border border-border bg-background px-4 py-3 text-left shadow-sm transition-colors",
            preview?.turnId
              ? "hover:border-primary/35"
              : "cursor-default opacity-95"
          )}
        >
          <div className="flex min-w-0 items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-foreground">
                {runtime.actorName}
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                {formatTargetsLabel(runtime)}
              </div>
            </div>
            {preview?.turnId ? (
              expanded ? (
                <ChevronDown className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              ) : (
                <ChevronRight className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              )
            ) : null}
          </div>

          {previewTool ? (
            <div className="flex flex-wrap items-center gap-2">
              <div
                className={cn(
                  "inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[11px] font-medium",
                  getToolStateTone(previewTool.state)
                )}
              >
                <ToolStateIcon state={previewTool.state} />
                <span>{formatToolStateLabel(previewTool.state)}</span>
              </div>
              <div className="min-w-0 text-xs text-foreground">
                <span className="font-medium">{previewTool.displayTitle}</span>
                {previewTool.displayDetail ? (
                  <span className="text-muted-foreground">
                    {" "}
                    · {previewTool.displayDetail}
                  </span>
                ) : null}
              </div>
            </div>
          ) : null}

          {countsLabel ? (
            <div className="text-[11px] text-muted-foreground">
              {countsLabel}
            </div>
          ) : null}
        </button>

        {expanded ? (
          <div className="rounded-[28px] border border-border/80 bg-background/90 p-3 shadow-sm">
            {loading && !detail ? (
              <div className="flex items-center gap-2 px-1 py-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                <span>Loading current-turn activity…</span>
              </div>
            ) : error ? (
              <div className="rounded-2xl border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                {error}
              </div>
            ) : detail && detail.items.length > 0 ? (
              <div className="flex flex-col gap-3">
                {detail.items.map((item) => (
                  <div
                    key={item.toolCallId}
                    className="rounded-3xl border border-border/70 bg-muted/20 px-3 py-3"
                  >
                    <div className="mb-3 flex flex-wrap items-center gap-2">
                      <div
                        className={cn(
                          "inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[11px] font-medium",
                          getToolStateTone(item.state)
                        )}
                      >
                        <ToolStateIcon state={item.state} />
                        <span>{formatToolStateLabel(item.state)}</span>
                      </div>
                      <div className="text-sm font-medium text-foreground">
                        {item.displayTitle}
                      </div>
                      {item.displayDetail ? (
                        <div className="text-xs text-muted-foreground">
                          {item.displayDetail}
                        </div>
                      ) : null}
                    </div>
                    <div className="flex flex-col gap-3">
                      <div>
                        <div className="mb-1 text-[11px] font-medium tracking-[0.08em] text-muted-foreground uppercase">
                          Call
                        </div>
                        <ActivityBlocks blocks={item.requestBlocks} />
                      </div>
                      <div>
                        <div className="mb-1 text-[11px] font-medium tracking-[0.08em] text-muted-foreground uppercase">
                          Result
                        </div>
                        <ActivityBlocks blocks={item.resultBlocks} />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded-2xl border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
                No tool activity in this turn yet
              </div>
            )}
          </div>
        ) : null}
      </div>
    </div>
  )
}
