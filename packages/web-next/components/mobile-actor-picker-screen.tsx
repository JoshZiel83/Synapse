"use client"

import { useDeferredValue, useEffect, useMemo, useState } from "react"
import { type Actor } from "@synapse/shared"
import { ArrowLeft, Bot, Check, Search } from "lucide-react"

import ChatAvatar from "@/app/dashboard/chat/chat-avatar"
import {
  type ChiefActorOption,
  normalizeChiefActorOption,
} from "@/app/dashboard/chief-actor-picker-shared"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { api, ApiError } from "@/lib/api"

export type MobileActorPickerSelectionMode = "single" | "multiple"
type MobileActorPickerSelectionBehavior = "confirm" | "immediate"

type SaveAsDefaultConfig = {
  label: string
  description: string
}

export type MobileActorPickerScreenProps = {
  workspaceId: string
  title: string
  description?: string
  initialActorIds?: string[]
  initialSearch?: string
  selectionMode?: MobileActorPickerSelectionMode
  selectionBehavior?: MobileActorPickerSelectionBehavior
  searchPlaceholder?: string
  confirmLabel: string
  confirmPendingLabel: string
  saveAsDefaultConfig?: SaveAsDefaultConfig
  onBack: () => void
  onConfirm: (payload: {
    selectedActors: ChiefActorOption[]
    saveAsDefault: boolean
  }) => Promise<void> | void
}

function getErrorMessage(error: unknown) {
  if (error instanceof ApiError) return error.message
  if (error instanceof Error) return error.message
  return "Something went wrong."
}

export function MobileActorPickerScreen({
  workspaceId,
  title,
  description,
  initialActorIds = [],
  initialSearch = "",
  selectionMode = "single",
  selectionBehavior = "confirm",
  searchPlaceholder = "Search actors",
  confirmLabel,
  confirmPendingLabel,
  saveAsDefaultConfig,
  onBack,
  onConfirm,
}: MobileActorPickerScreenProps) {
  const [actors, setActors] = useState<ChiefActorOption[]>([])
  const [selectedActorIds, setSelectedActorIds] = useState<string[]>([])
  const [search, setSearch] = useState(initialSearch)
  const [saveAsDefault, setSaveAsDefault] = useState(false)
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const deferredSearch = useDeferredValue(search)

  useEffect(() => {
    setSearch(initialSearch)
  }, [initialSearch])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setErrorMessage(null)

    void api
      .getActors(workspaceId)
      .then((response) => {
        if (cancelled) return

        const nextActors: ChiefActorOption[] = (response?.actors || response || [])
          .map((actor: Actor) => normalizeChiefActorOption(actor))
          .filter((actor: ChiefActorOption) => actor.isActive)
          .sort((left: ChiefActorOption, right: ChiefActorOption) =>
            left.name.localeCompare(right.name)
          )

        setActors(nextActors)
      })
      .catch((error) => {
        if (cancelled) return
        console.error("Failed to load mobile actor candidates:", error)
        setActors([])
        setErrorMessage("Failed to load available actors.")
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [workspaceId])

  const normalizedInitialActorIds = useMemo(
    () => Array.from(new Set(initialActorIds)).filter(Boolean),
    [initialActorIds]
  )

  useEffect(() => {
    const nextSelectedActorIds = normalizedInitialActorIds.filter((actorId) =>
      actors.some((actor) => actor.id === actorId)
    )

    if (nextSelectedActorIds.length > 0) {
      setSelectedActorIds(
        selectionMode === "multiple"
          ? nextSelectedActorIds
          : [nextSelectedActorIds[0]!]
      )
      return
    }

    if (selectionMode === "single" && actors.length === 1) {
      setSelectedActorIds([actors[0]!.id])
      return
    }

    setSelectedActorIds([])
  }, [actors, normalizedInitialActorIds, selectionMode])

  const visibleActors = useMemo(() => {
    const normalizedQuery = deferredSearch.trim().toLowerCase()
    if (!normalizedQuery) return actors

    return actors.filter((actor) => {
      const haystack = [
        actor.name,
        actor.title,
        actor.role,
        actor.summary || "",
      ]
        .join(" ")
        .toLowerCase()

      return haystack.includes(normalizedQuery)
    })
  }, [actors, deferredSearch])

  async function handleActorPress(actorId: string) {
    const nextSelectedActorIds =
      selectionMode === "single"
        ? [actorId]
        : selectedActorIds.includes(actorId)
          ? selectedActorIds.filter((currentId) => currentId !== actorId)
          : [...selectedActorIds, actorId]

    setSelectedActorIds(nextSelectedActorIds)

    if (selectionBehavior !== "immediate") {
      return
    }

    const selectedActors = actors.filter((actor) =>
      nextSelectedActorIds.includes(actor.id)
    )
    if (selectedActors.length === 0) return

    setSubmitting(true)
    setErrorMessage(null)

    try {
      await onConfirm({
        selectedActors,
        saveAsDefault,
      })
    } catch (error) {
      setErrorMessage(getErrorMessage(error))
    } finally {
      setSubmitting(false)
    }
  }

  async function handleConfirm() {
    const selectedActors = actors.filter((actor) =>
      selectedActorIds.includes(actor.id)
    )
    if (selectedActors.length === 0) return

    setSubmitting(true)
    setErrorMessage(null)

    try {
      await onConfirm({
        selectedActors,
        saveAsDefault,
      })
    } catch (error) {
      setErrorMessage(getErrorMessage(error))
    } finally {
      setSubmitting(false)
    }
  }

  const hasFooterContent =
    Boolean(saveAsDefaultConfig) ||
    Boolean(errorMessage) ||
    selectionBehavior === "confirm"

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
          {visibleActors.map((actor) => {
            const active = selectedActorIds.includes(actor.id)

            return (
              <button
                key={actor.id}
                type="button"
                onClick={() => {
                  void handleActorPress(actor.id)
                }}
                className="flex w-full items-start gap-3 px-4 py-4 text-left transition-colors hover:bg-muted/25"
                disabled={submitting}
              >
                <ChatAvatar
                  name={actor.name}
                  avatarUrl={actor.avatarUrl}
                  emoji={actor.emoji}
                  entityType="actor"
                  size="lg"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-foreground">
                      {actor.name}
                    </span>
                    <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                      {actor.title || actor.role}
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {actor.summary || actor.title || actor.role}
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

          {loading ? (
            <div className="rounded-[24px] border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
              Loading actors...
            </div>
          ) : null}

          {!loading && visibleActors.length === 0 ? (
            <div className="rounded-[24px] border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
              <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-2xl bg-muted">
                <Bot className="size-5" />
              </div>
              {deferredSearch.trim()
                ? "No actors matched your search."
                : "No active actors are available in this workspace."}
            </div>
          ) : null}
        </div>
      </div>

      {hasFooterContent ? (
        <div className="sticky bottom-0 border-t border-border bg-background px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-4">
          <div className="space-y-4">
            {saveAsDefaultConfig ? (
              <label className="flex items-start gap-3 rounded-[22px] bg-muted/30 px-3 py-3">
                <Checkbox
                  checked={saveAsDefault}
                  onCheckedChange={(checked) => setSaveAsDefault(Boolean(checked))}
                />
                <div>
                  <div className="text-sm font-medium text-foreground">
                    {saveAsDefaultConfig.label}
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {saveAsDefaultConfig.description}
                  </p>
                </div>
              </label>
            ) : null}

            {errorMessage ? (
              <p className="text-sm text-destructive">{errorMessage}</p>
            ) : null}

            {selectionBehavior === "confirm" ? (
              <Button
                type="button"
                className="h-12 w-full rounded-full"
                disabled={selectedActorIds.length === 0 || loading || submitting}
                onClick={() => void handleConfirm()}
              >
                {submitting ? confirmPendingLabel : confirmLabel}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}
