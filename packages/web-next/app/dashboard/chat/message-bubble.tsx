"use client"

import type { ComponentPropsWithoutRef } from "react"
import type { ActorRuntimeState } from "@synapse/shared"
import { useMemo, useState } from "react"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
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
} from "lucide-react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import type { CanonicalContentBlock } from "@synapse/shared"
import { extractText } from "@synapse/shared"
import { runtimeToAvatarStatus } from "@/stores/chat-store"
import type { ServerToolCall } from "@/stores/chat-store"
import type { GroupMember } from "@/stores/chat-store"
import { cn, resolveFileUrl } from "@/lib/utils"
import ChatAvatar from "./chat-avatar"
import {
  TablePreviewOverlay,
  type TablePreviewContent,
} from "./table-preview-overlay"

interface MessageBubbleProps {
  role: string
  contentBlocks: CanonicalContentBlock[]
  actorName?: string
  actorAvatarUrl?: string
  actorEmoji?: string
  actorRole?: string
  actorRuntime?: ActorRuntimeState
  timestamp?: string
  isUser: boolean
  fromUserId?: string
  status?: "sending" | "retrying" | "sent"
  toolsUsed?: string[]
  serverToolCalls?: ServerToolCall[]
  citationSources?: Record<string, { url: string; title: string }>
  coordination?: boolean
  groupMembers?: GroupMember[]
  targetActorIds?: string[]
  targetUserIds?: string[]
  enableTablePreview?: boolean
  viewerUserId?: string
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

type MessageRecipient = Pick<
  GroupMember,
  "id" | "type" | "name" | "title" | "role" | "emoji" | "avatarUrl"
>

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
  targetActorIds: string[] | undefined,
  targetUserIds: string[] | undefined
) {
  const actorIds = Array.from(new Set(targetActorIds || []))
  const userIds = Array.from(new Set(targetUserIds || []))
  const actorMap = new Map<string, GroupMember>()
  const userMap = new Map<string, GroupMember>()

  for (const member of groupMembers || []) {
    if (member.type === "actor") {
      actorMap.set(member.id, member)
      continue
    }
    userMap.set(member.id, member)
  }

  const recipients: MessageRecipient[] = []
  for (const actorId of actorIds) {
    const member = actorMap.get(actorId)
    recipients.push({
      id: actorId,
      type: "actor",
      name: member?.name || "Unknown actor",
      title: member?.title,
      role: member?.role,
      emoji: member?.emoji,
      avatarUrl: member?.avatarUrl,
    })
  }
  for (const userId of userIds) {
    const member = userMap.get(userId)
    recipients.push({
      id: userId,
      type: "user",
      name: member?.name || "Unknown user",
      avatarUrl: member?.avatarUrl,
    })
  }

  return recipients
}

function RecipientChip({ recipient }: { recipient: MessageRecipient }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="cursor-help text-foreground/70 transition-colors hover:text-foreground">
          @{recipient.name}
        </span>
      </TooltipTrigger>
      <TooltipContent
        side="top"
        className="flex max-w-64 items-start gap-2 px-3 py-2"
      >
        <ChatAvatar
          name={recipient.name}
          avatarUrl={recipient.avatarUrl}
          emoji={recipient.emoji}
          entityType={recipient.type === "actor" ? "actor" : "user"}
          size="sm"
          className="shrink-0"
        />
        <div className="min-w-0">
          <div className="font-medium">{recipient.name}</div>
          <div className="text-background/80">
            {recipient.type === "actor"
              ? recipient.title || recipient.role || "Actor"
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
}: {
  recipients: MessageRecipient[]
  hasExplicitTargets: boolean
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
}: React.ImgHTMLAttributes<HTMLImageElement>) {
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
  role,
  contentBlocks,
  actorName,
  actorAvatarUrl,
  actorEmoji,
  actorRuntime,
  timestamp,
  isUser,
  fromUserId,
  status,
  toolsUsed,
  serverToolCalls,
  citationSources,
  coordination,
  groupMembers,
  targetActorIds,
  targetUserIds,
  enableTablePreview = false,
  viewerUserId,
}: MessageBubbleProps) {
  const isChildResult = role === "child_result"
  const isSystem = role === "system"
  const isError = role === "error"
  const textContent = useMemo(() => extractText(contentBlocks), [contentBlocks])
  const recipients = useMemo(
    () => resolveRecipients(groupMembers, targetActorIds, targetUserIds),
    [groupMembers, targetActorIds, targetUserIds]
  )
  const hasExplicitTargets =
    (targetActorIds?.length || 0) + (targetUserIds?.length || 0) > 0
  const userSender = useMemo(() => {
    const senderUserId = fromUserId || viewerUserId
    if (!senderUserId) return undefined
    return groupMembers?.find(
      (member) => member.type === "user" && member.id === senderUserId
    )
  }, [fromUserId, groupMembers, viewerUserId])

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

  if (isSystem) {
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
  const isDirectToViewer = Boolean(
    viewerUserId && targetUserIds?.includes(viewerUserId)
  )
  const shouldRenderCompact =
    !isUser && (coordination || (hasExplicitTargets && !isDirectToViewer))

  // Non-direct actor traffic stays compact so the main thread focuses on viewer-facing messages.
  if (shouldRenderCompact) {
    return (
      <div className="ml-10 flex w-[calc(100%-2.5rem)] min-w-0 max-w-full gap-2 opacity-70">
        <div className="flex w-full max-w-[70%] min-w-0 items-start gap-2">
          <AtSign className="mt-1 h-3 w-3 shrink-0 text-primary/60" />
          <div className="min-w-0 flex-1">
            <button
              type="button"
              className="flex w-full min-w-0 items-start gap-1.5 text-left text-xs text-muted-foreground/70 transition-colors hover:text-foreground/80"
              onClick={() => setCompactExpanded((current) => !current)}
              aria-expanded={compactExpanded}
            >
              <div className="min-w-0 flex-1">
                {compactExpanded ? (
                  <div className="mb-0.5 flex items-center gap-1.5">
                    <span className="text-[11px] font-medium text-muted-foreground/80">
                      {actorName || "Actor"}
                    </span>
                  </div>
                ) : (
                  <div className="truncate">
                    <span className="font-medium text-muted-foreground/80">
                      {actorName || "Actor"}
                    </span>
                    <span className="mx-1 text-muted-foreground/40">·</span>
                    <span>{compactPreview}</span>
                  </div>
                )}
              </div>
              {compactExpanded ? (
                <ChevronDown className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground/45" />
              ) : (
                <ChevronRight className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground/45" />
              )}
            </button>

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
                  <RecipientSummary
                    recipients={recipients}
                    hasExplicitTargets={hasExplicitTargets}
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
          name={userSender?.name || "You"}
          avatarUrl={userSender?.avatarUrl}
          entityType="user"
          className="mt-1 shrink-0"
        />
      ) : isChildResult ? (
        <Avatar className="mt-1 h-8 w-8 shrink-0">
          <AvatarFallback className="bg-amber-500 text-xs text-white">
            <GitBranch className="h-4 w-4" />
          </AvatarFallback>
        </Avatar>
      ) : (
        <ChatAvatar
          name={actorName}
          avatarUrl={actorAvatarUrl}
          emoji={actorEmoji}
          entityType="actor"
          className="mt-1 shrink-0"
          statusState={runtimeToAvatarStatus(actorRuntime)}
          statusLabel={getRuntimeLabel(actorRuntime)}
          statusDetail={getRuntimeDetail(actorRuntime)}
        />
      )}

      <div
        className={`flex w-full max-w-[75%] min-w-0 flex-col ${isUser ? "items-end" : "items-start"}`}
      >
        {!isUser && actorName && (
          <span className="mb-1 ml-1 self-start text-xs text-muted-foreground/70">
            {actorName}
          </span>
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
            <MessageContentBlocks
              blocks={renderedBlocks}
              isUser={isUser}
              enableTablePreview={enableTablePreview}
            />

            {/* Citation sources footer */}
            {hasCitations && <CitationFooter sources={sources} />}

            {/* Server tool calls (web_search / web_fetch) — inside the bubble */}
            {hasServerToolCalls && (
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
          <RecipientSummary
            recipients={recipients}
            hasExplicitTargets={hasExplicitTargets}
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
