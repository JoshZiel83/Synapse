"use client"

import type {
  ActorRuntimeState,
  ActorRuntimeTurnActivityDetail,
  CanonicalContentBlock,
} from "@synapse/shared"
import {
  getActorRuntimeCurrentTool,
  getActorRuntimeProcessingTargets,
  resolvePresentation,
} from "@synapse/shared"
import { useEffect, useMemo, useState } from "react"
import {
  AlertTriangle,
  Check,
  ChevronRight,
  FileIcon,
  Loader2,
  UserRound,
  X,
} from "lucide-react"
import { api } from "@/lib/api"
import { cn, resolveContentUrl } from "@/lib/utils"
import type { ConversationMember } from "@/stores/chat-store"
import {
  runtimePhaseToBadgePhase,
  runtimeToAvatarStatus,
} from "@/stores/chat-store"
import ChatAvatar from "./chat-avatar"
import { ToolIcon } from "./tool-icon"

function formatTargetsLabel(runtime: ActorRuntimeState) {
  const names = getActorRuntimeProcessingTargets(runtime)
    .map((target) => target.name)
    .filter(Boolean)
  if (names.length === 0) return "working"
  if (names.length <= 2) return `for ${names.join(", ")}`
  return `for ${names.slice(0, 2).join(", ")} +${names.length - 2}`
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
      return "Done"
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

// Restrained status: a single colored glyph, no bordered pill.
function StatusGlyph({
  state,
  className,
}: {
  state: string
  className?: string
}) {
  const cls = cn("size-3.5 shrink-0", className)
  switch (state) {
    case "completed":
      return <Check className={cn(cls, "text-emerald-600")} />
    case "failed":
    case "cancelled":
      return <X className={cn(cls, "text-destructive")} />
    case "input_required":
      return <AlertTriangle className={cn(cls, "text-amber-600")} />
    default:
      return (
        <Loader2 className={cn(cls, "animate-spin text-muted-foreground")} />
      )
  }
}

// Call / result payload — a clean monospace block, no nested card chrome.
function ActivityBlocks({ blocks }: { blocks: CanonicalContentBlock[] }) {
  if (blocks.length === 0) {
    return <div className="text-xs text-muted-foreground/70 italic">—</div>
  }

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {blocks.map((block) => {
        if (block.type === "text") {
          return (
            <pre
              key={block.id}
              className="min-w-0 overflow-x-auto rounded-md bg-muted/60 px-2.5 py-1.5 font-mono text-xs break-words whitespace-pre-wrap text-foreground/90"
            >
              {block.text}
            </pre>
          )
        }

        if (block.type === "mention") {
          return (
            <span
              key={block.id}
              className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground"
            >
              <UserRound className="size-3" />
              {block.mention.name || block.mention.participantType}
            </span>
          )
        }

        return (
          <a
            key={block.id}
            href={resolveContentUrl(block.sha256)}
            target="_blank"
            rel="noreferrer"
            className="inline-flex w-fit items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            <FileIcon className="size-3.5" />
            <span className="truncate underline-offset-2 hover:underline">
              {block.name}
            </span>
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
    const done = preview.completedToolCallCount
    const total = preview.totalToolCallCount
    const failed = preview.failedToolCallCount
    return failed > 0
      ? `${done}/${total} · ${failed} failed`
      : `${done}/${total}`
  }, [preview])

  const toolTitle = previewTool
    ? (resolvePresentation(previewTool.titlePresentation) ??
      previewTool.displayTitle)
    : "Working…"

  const canExpand = Boolean(preview?.turnId)

  return (
    <div className="flex w-full max-w-full min-w-0 gap-3">
      <ChatAvatar
        name={runtime.actorDisplayName}
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
        className="mt-0.5"
      />

      <div className="flex min-w-0 flex-1 flex-col gap-1 pt-0.5">
        {/* Actor name, same as any other message's sender label. */}
        <div className="ml-1 text-xs text-muted-foreground/70">
          {runtime.actorDisplayName}
        </div>

        {/* Compact, collapsed-by-default activity row (Claude/Cursor style). */}
        <button
          type="button"
          disabled={!canExpand}
          onClick={() => setExpanded((current) => !current)}
          aria-expanded={expanded}
          className={cn(
            "group inline-flex w-fit max-w-full min-w-0 items-center gap-1.5 rounded-lg px-2 py-1 text-left text-xs text-muted-foreground transition-colors",
            canExpand ? "hover:bg-muted/60" : "cursor-default"
          )}
        >
          <StatusGlyph state={previewTool?.state ?? "running"} />
          {previewTool ? (
            <ToolIcon
              name={previewTool.icon}
              className="size-3.5 shrink-0 text-muted-foreground"
            />
          ) : null}
          <span className="min-w-0 truncate font-medium text-foreground">
            {toolTitle}
          </span>
          {previewTool?.source?.displayName ? (
            <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
              {previewTool.source.displayName}
            </span>
          ) : null}
          {countsLabel ? (
            <span className="shrink-0 tabular-nums">· {countsLabel}</span>
          ) : null}
          {canExpand ? (
            <ChevronRight
              className={cn(
                "size-3.5 shrink-0 transition-transform",
                expanded && "rotate-90"
              )}
            />
          ) : null}
        </button>

        {expanded ? (
          <div className="min-w-0">
            {loading && !detail ? (
              <div className="flex items-center gap-2 py-1.5 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
                Loading activity…
              </div>
            ) : error ? (
              <div className="text-xs text-destructive">{error}</div>
            ) : detail && detail.items.length > 0 ? (
              <ol className="ml-1.5 flex flex-col gap-3 border-l border-border/60 pl-3.5">
                {detail.items.map((item) => (
                  <li key={item.toolCallId} className="relative min-w-0">
                    {/* node on the timeline rail */}
                    <span className="absolute top-0.5 -left-[1.375rem] flex size-4 items-center justify-center rounded-full border border-border bg-background">
                      <StatusGlyph state={item.state} className="size-2.5" />
                    </span>
                    <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs">
                      <ToolIcon
                        name={item.icon}
                        className="size-3.5 shrink-0 text-muted-foreground"
                      />
                      <span className="font-medium text-foreground">
                        {resolvePresentation(item.titlePresentation) ??
                          item.displayTitle}
                      </span>
                      {item.source?.displayName ? (
                        <span className="rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
                          {item.source.displayName}
                        </span>
                      ) : null}
                      <span className="text-muted-foreground">
                        {formatToolStateLabel(item.state)}
                      </span>
                    </div>
                    {item.displayDetail ? (
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        {item.displayDetail}
                      </div>
                    ) : null}
                    <div className="mt-1.5 flex min-w-0 flex-col gap-1.5">
                      <ActivityBlocks blocks={item.requestBlocks} />
                      {resolvePresentation(item.resultSummary) ? (
                        <div className="text-xs text-foreground/90">
                          {resolvePresentation(item.resultSummary)}
                        </div>
                      ) : null}
                      <ActivityBlocks blocks={item.resultBlocks} />
                    </div>
                  </li>
                ))}
              </ol>
            ) : (
              <div className="py-1 text-xs text-muted-foreground">
                No tool activity in this turn yet.
              </div>
            )}
          </div>
        ) : null}
      </div>
    </div>
  )
}
