"use client"

import { useDeferredValue, useEffect, useMemo, useState } from "react"
import { ArrowLeft, AtSign, Check, Search } from "lucide-react"

import type { MentionableParticipant } from "@/app/dashboard/chat/chat-mentions-input"
import ChatAvatar from "@/app/dashboard/chat/chat-avatar"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

export type MobileParticipantPickerSelectionMode = "single" | "multiple"
type MobileParticipantPickerSelectionBehavior = "confirm" | "immediate"

export type MobileParticipantPickerScreenProps = {
  title: string
  description?: string
  participants: MentionableParticipant[]
  initialParticipantIds?: string[]
  initialSearch?: string
  selectionMode?: MobileParticipantPickerSelectionMode
  selectionBehavior?: MobileParticipantPickerSelectionBehavior
  searchPlaceholder?: string
  confirmLabel: string
  confirmPendingLabel: string
  onBack: () => void
  onConfirm: (payload: {
    selectedParticipantIds: string[]
  }) => Promise<void> | void
}

function getSearchHaystack(participant: MentionableParticipant) {
  return [
    participant.name,
    participant.description || "",
    ...(participant.searchTerms || []),
  ]
    .join(" ")
    .toLowerCase()
}

export function MobileParticipantPickerScreen({
  title,
  description,
  participants,
  initialParticipantIds = [],
  initialSearch = "",
  selectionMode = "single",
  selectionBehavior = "confirm",
  searchPlaceholder = "Search participants",
  confirmLabel,
  confirmPendingLabel,
  onBack,
  onConfirm,
}: MobileParticipantPickerScreenProps) {
  const [selectedParticipantIds, setSelectedParticipantIds] = useState<string[]>([])
  const [search, setSearch] = useState(initialSearch)
  const [submitting, setSubmitting] = useState(false)
  const deferredSearch = useDeferredValue(search)

  useEffect(() => {
    setSearch(initialSearch)
  }, [initialSearch])

  const normalizedInitialParticipantIds = useMemo(
    () => Array.from(new Set(initialParticipantIds)).filter(Boolean),
    [initialParticipantIds]
  )

  useEffect(() => {
    const nextSelectedParticipantIds = normalizedInitialParticipantIds.filter(
      (participantId) =>
        participants.some((participant) => participant.id === participantId)
    )

    if (nextSelectedParticipantIds.length > 0) {
      setSelectedParticipantIds(
        selectionMode === "multiple"
          ? nextSelectedParticipantIds
          : [nextSelectedParticipantIds[0]!]
      )
      return
    }

    setSelectedParticipantIds([])
  }, [normalizedInitialParticipantIds, participants, selectionMode])

  const visibleParticipants = useMemo(() => {
    const normalizedQuery = deferredSearch.trim().toLowerCase()
    if (!normalizedQuery) return participants

    return participants.filter((participant) =>
      getSearchHaystack(participant).includes(normalizedQuery)
    )
  }, [deferredSearch, participants])

  async function commitSelection(nextSelectedParticipantIds: string[]) {
    if (nextSelectedParticipantIds.length === 0) return
    setSubmitting(true)
    try {
      await onConfirm({
        selectedParticipantIds: nextSelectedParticipantIds,
      })
    } finally {
      setSubmitting(false)
    }
  }

  async function handleParticipantPress(participantId: string) {
    const nextSelectedParticipantIds =
      selectionMode === "single"
        ? [participantId]
        : selectedParticipantIds.includes(participantId)
          ? selectedParticipantIds.filter((currentId) => currentId !== participantId)
          : [...selectedParticipantIds, participantId]

    setSelectedParticipantIds(nextSelectedParticipantIds)

    if (selectionBehavior !== "immediate") {
      return
    }

    await commitSelection(nextSelectedParticipantIds)
  }

  async function handleConfirm() {
    await commitSelection(selectedParticipantIds)
  }

  return (
    <div className="flex min-h-svh flex-col bg-background">
      <header className="sticky top-0 z-20 border-b border-border bg-background px-4 pb-4 pt-[max(1rem,env(safe-area-inset-top))]">
        <div className="flex items-center gap-3">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-10 rounded-full"
            onClick={onBack}
          >
            <ArrowLeft className="size-4" />
          </Button>
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold text-foreground">
              {title}
            </h1>
            {description ? (
              <p className="truncate text-sm text-muted-foreground">
                {description}
              </p>
            ) : null}
          </div>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={searchPlaceholder}
            className="h-11 rounded-2xl border-border/70 bg-muted/35 pl-9 shadow-none"
          />
        </div>

        <div className="mt-4 divide-y divide-border/70 border-y border-border/70 bg-background/80 pb-4">
          {visibleParticipants.map((participant) => {
            const active = selectedParticipantIds.includes(participant.id)

            return (
              <button
                key={participant.id}
                type="button"
                onClick={() => {
                  void handleParticipantPress(participant.id)
                }}
                className="flex w-full items-start gap-3 px-4 py-4 text-left transition-colors hover:bg-muted/25"
                disabled={submitting}
              >
                <ChatAvatar
                  name={participant.name}
                  avatarUrl={participant.avatarUrl}
                  emoji={participant.emoji}
                  entityType={participant.type}
                  size="lg"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-foreground">
                      {participant.name}
                    </span>
                    <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                      {participant.type === "workspace_member"
                        ? "member"
                        : participant.type === "remote_agent"
                          ? "remote agent"
                          : participant.type}
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {participant.description ||
                      (participant.type === "workspace_member"
                        ? "member"
                        : participant.type === "remote_agent"
                          ? "remote agent"
                          : participant.type)}
                  </p>
                </div>
                <div
                  className={[
                    "mt-1 flex size-5 shrink-0 items-center justify-center rounded-full border transition-colors",
                    active
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-muted-foreground/40 text-transparent",
                  ].join(" ")}
                >
                  <Check className="size-3.5" />
                </div>
              </button>
            )
          })}

          {visibleParticipants.length === 0 ? (
            <div className="rounded-[24px] border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
              <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-2xl bg-muted">
                <AtSign className="size-5" />
              </div>
              {deferredSearch.trim()
                ? "No participants matched your search."
                : "No mentionable participants are available in this conversation."}
            </div>
          ) : null}
        </div>
      </div>

      {selectionBehavior === "confirm" ? (
        <div className="sticky bottom-0 border-t border-border bg-background px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-4">
          <Button
            type="button"
            className="h-12 w-full rounded-full"
            disabled={selectedParticipantIds.length === 0 || submitting}
            onClick={() => void handleConfirm()}
          >
            {submitting ? confirmPendingLabel : confirmLabel}
          </Button>
        </div>
      ) : null}
    </div>
  )
}
