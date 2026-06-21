"use client"

import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"
import { Plus, Search } from "lucide-react"
import ChatAvatar from "./chat-avatar"
import TransportKindIcon from "./transport-kind-icon"
import type {
  ConversationRuntimeMap,
  ConversationSummary,
} from "@/stores/chat-store"
import { summarizeRuntimePreview } from "./runtime-ui"
import { formatChatTimestamp } from "@synapse/shared/datetime"

/**
 * Read the browser locale only on the client, AFTER mount. Reading it at module
 * scope would diverge between SSR (undefined) and hydration (e.g. "en-US"),
 * causing a hydration mismatch on the >7d date fallback. Returning `undefined`
 * lets the shared formatter use its stable default (zh-CN) for the first paint.
 */
function useBrowserLocale(): string | undefined {
  const [locale, setLocale] = useState<string | undefined>(undefined)
  useEffect(() => {
    if (typeof navigator !== "undefined" && navigator.language) {
      setLocale(navigator.language)
    }
  }, [])
  return locale
}

interface ConversationListProps {
  conversations: ConversationSummary[]
  selectedId: string | null
  runtimeMap: ConversationRuntimeMap
  onSelect: (id: string) => void
  onNewConversation: () => void
  className?: string
  title?: string
  loading?: boolean
}

function ConversationListSkeletonRows({
  isMobileHeader,
}: {
  isMobileHeader: boolean
}) {
  return (
    <div className="divide-y divide-border/70">
      {Array.from({ length: isMobileHeader ? 6 : 8 }, (_, index) => (
        <div key={index} className="flex items-center gap-3 px-4 py-3">
          <Skeleton className="size-11 shrink-0 rounded-2xl" />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <div className="flex items-center justify-between gap-3">
              <Skeleton
                className={cn(
                  "h-4 rounded-full",
                  index % 3 === 0 ? "w-28" : index % 3 === 1 ? "w-36" : "w-24"
                )}
              />
              <Skeleton className="h-3 w-10 shrink-0 rounded-full" />
            </div>
            <Skeleton
              className={cn(
                "h-3.5 rounded-full",
                index % 2 === 0 ? "w-full max-w-[15rem]" : "w-[72%]"
              )}
            />
          </div>
        </div>
      ))}
    </div>
  )
}

export default function ConversationList({
  conversations,
  selectedId,
  runtimeMap,
  onSelect,
  onNewConversation,
  className,
  title,
  loading = false,
}: ConversationListProps) {
  const [search, setSearch] = useState("")
  const browserLocale = useBrowserLocale()
  const formatRelativeTime = (dateStr: string) =>
    formatChatTimestamp(dateStr, "relative", { locale: browserLocale })
  const headerTitle = title || "Messages"

  const filtered = search
    ? conversations.filter((conversation) => {
        const s = search.toLowerCase()
        return (
          conversation.title?.toLowerCase().includes(s) ||
          conversation.participants.some((participant) =>
            participant.name.toLowerCase().includes(s)
          ) ||
          conversation.lastMessage?.content.toLowerCase().includes(s)
        )
      })
    : conversations

  return (
    <div
      className={cn(
        "flex h-full min-h-0 flex-col border-r border-border bg-muted/20",
        className
      )}
    >
      <div className="border-b border-border px-4 py-4">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold tracking-tight text-foreground">
            {headerTitle}
          </h2>
          <Button
            variant="ghost"
            size="icon"
            className="size-8 shrink-0 rounded-full text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            onClick={onNewConversation}
            title="New Conversation"
          >
            <Plus className="size-5" />
          </Button>
        </div>
        <div className="relative">
          <Search className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-gray-400 dark:text-gray-500" />
          <Input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search conversations..."
            className="pl-9"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <ConversationListSkeletonRows isMobileHeader={false} />
        ) : (
          filtered.map((conversation) => {
            const isSelected = conversation.id === selectedId
            const runtimePreview = summarizeRuntimePreview(
              runtimeMap[conversation.id]
            )
            const name =
              conversation.title ||
              conversation.participants
                .map((participant) => participant.name)
                .join(", ")

            const preview = conversation.lastMessage
              ? `${conversation.lastMessage.role === "user" ? "You" : conversation.lastMessage.actorName || "Actor"}: ${conversation.lastMessage.content}`
              : ""
            const previewTrunc =
              preview.length > 50 ? preview.substring(0, 50) + "..." : preview

            const timeStr =
              conversation.lastMessage?.createdAt || conversation.createdAt

            return (
              <button
                key={conversation.id}
                onClick={() => onSelect(conversation.id)}
                className={`relative w-full px-4 py-3 text-left transition-colors ${
                  isSelected ? "bg-accent" : "hover:bg-accent/70"
                } `}
              >
                {isSelected ? (
                  <div className="absolute top-1/2 left-0 h-8 w-1 -translate-y-1/2 rounded-r-full bg-primary" />
                ) : null}

                <div className="flex items-center gap-3">
                  {/* Avatar */}
                  <div className="relative shrink-0">
                    <ChatAvatar
                      name={name}
                      avatarUrl={conversation.avatarUrl}
                      entityType="conversation"
                      size="lg"
                    />
                    <TransportKindIcon
                      kind={conversation.transportKind}
                      size={14}
                      className="absolute -right-1 -bottom-1 size-5 p-0.5"
                    />
                    {conversation.unreadCount > 0 ? (
                      <span className="absolute -top-1 -right-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">
                        {conversation.unreadCount > 99
                          ? "99+"
                          : conversation.unreadCount}
                      </span>
                    ) : null}
                  </div>

                  {/* Content */}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <span
                        className={`truncate text-sm font-semibold ${
                          isSelected ? "text-primary" : "text-foreground"
                        }`}
                      >
                        {name}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {formatRelativeTime(timeStr)}
                      </span>
                    </div>
                    <p className="mt-0.5 truncate text-sm text-muted-foreground">
                      {runtimePreview || previewTrunc || "No messages yet"}
                    </p>
                  </div>
                </div>
              </button>
            )
          })
        )}

        {!loading && filtered.length === 0 ? (
          <div className="py-8 text-center">
            <p className="text-xs text-muted-foreground">
              {search
                ? "No conversations match your search"
                : "No conversations yet"}
            </p>
          </div>
        ) : null}
      </div>
    </div>
  )
}
