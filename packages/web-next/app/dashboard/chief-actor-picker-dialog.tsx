"use client"

import { useDeferredValue, useEffect, useState } from "react"
import { type Actor } from "@synapse/shared"
import { Bot, Search } from "lucide-react"

import ChatAvatar from "@/app/dashboard/chat/chat-avatar"
import {
  type ChiefActorOption as ActorOption,
  normalizeChiefActorOption,
} from "@/app/dashboard/chief-actor-picker-shared"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { api } from "@/lib/api"

type ChiefActorPickerMode = "launch" | "settings"

type ChiefActorPickerDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspaceId: string
  mode: ChiefActorPickerMode
  initialActorId?: string
  initialSaveAsDefault?: boolean
  busy?: boolean
  onConfirm: (payload: {
    actorId: string
    actor: {
      id: string
      displayName: string
      role: string
      title: string
      avatarUrl?: string
      emoji?: string
    }
    saveAsDefault: boolean
  }) => Promise<void> | void
}

function ChiefActorPickerDialogBody({
  onOpenChange,
  workspaceId,
  mode,
  initialActorId,
  initialSaveAsDefault,
  busy,
  onConfirm,
}: Omit<ChiefActorPickerDialogProps, "open">) {
  const [actors, setActors] = useState<ActorOption[]>([])
  const [selectedActorId, setSelectedActorId] = useState(initialActorId || "")
  const [saveAsDefault, setSaveAsDefault] = useState(
    Boolean(initialSaveAsDefault)
  )
  const [search, setSearch] = useState("")
  const [loading, setLoading] = useState(true)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const deferredSearch = useDeferredValue(search)

  useEffect(() => {
    let cancelled = false

    void api
      .getActors(workspaceId)
      .then((response) => {
        if (cancelled) return
        const nextActors: ActorOption[] = (response?.actors || response || [])
          .map((actor: Actor) => normalizeChiefActorOption(actor))
          .filter((actor: ActorOption) => actor.isActive)
          .sort((left: ActorOption, right: ActorOption) =>
            left.displayName.localeCompare(right.displayName)
          )

        setActors(nextActors)
        if (!initialActorId && nextActors.length === 1) {
          setSelectedActorId(nextActors[0]!.id)
        }
      })
      .catch((error) => {
        if (cancelled) return
        console.error("Failed to load chief actor candidates:", error)
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
  }, [initialActorId, workspaceId])

  const normalizedQuery = deferredSearch.trim().toLowerCase()
  const visibleActors = normalizedQuery
    ? actors.filter((actor) => {
        const haystack = [
          actor.displayName,
          actor.title,
          actor.role,
          actor.summary || "",
        ]
          .join(" ")
          .toLowerCase()
        return haystack.includes(normalizedQuery)
      })
    : actors

  async function handleConfirm() {
    if (!selectedActorId) return
    const selectedActor = actors.find((actor) => actor.id === selectedActorId)
    if (!selectedActor) return
    await onConfirm({
      actorId: selectedActorId,
      actor: {
        id: selectedActor.id,
        displayName: selectedActor.displayName,
        role: selectedActor.role,
        title: selectedActor.title,
        avatarUrl: selectedActor.avatarUrl,
        emoji: selectedActor.emoji,
      },
      saveAsDefault: mode === "settings" ? true : saveAsDefault,
    })
  }

  const primaryLabel = mode === "settings" ? "Save chief actor" : "Continue"

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {mode === "settings"
            ? "Choose your chief actor"
            : "Choose who should take this conversation"}
        </DialogTitle>
        <DialogDescription>
          {mode === "settings"
            ? "This actor becomes the default launch target for new conversations from the dashboard home page."
            : "Pick one actor for this new conversation. You can also save the choice as your default chief actor."}
        </DialogDescription>
      </DialogHeader>

      <div className="flex flex-col gap-4">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search actors"
            className="pl-9"
          />
        </div>

        <ScrollArea className="h-[420px] pr-3">
          <div className="flex flex-col gap-3">
            {visibleActors.map((actor) => {
              const active = actor.id === selectedActorId
              return (
                <button
                  key={actor.id}
                  type="button"
                  onClick={() => setSelectedActorId(actor.id)}
                  className={[
                    "flex w-full items-start gap-3 rounded-3xl border px-4 py-4 text-left transition-colors",
                    active
                      ? "border-primary bg-primary/5"
                      : "border-border hover:bg-muted/40",
                  ].join(" ")}
                >
                  <ChatAvatar
                    name={actor.displayName}
                    avatarUrl={actor.avatarUrl}
                    emoji={actor.emoji}
                    entityType="actor"
                    size="lg"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-foreground">
                        {actor.displayName}
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
                      "mt-1 size-4 rounded-full border transition-colors",
                      active
                        ? "border-primary bg-primary"
                        : "border-muted-foreground/40",
                    ].join(" ")}
                  />
                </button>
              )
            })}

            {loading ? (
              <div className="rounded-3xl border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
                Loading actors...
              </div>
            ) : null}

            {!loading && visibleActors.length === 0 ? (
              <div className="rounded-3xl border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
                <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-2xl bg-muted">
                  <Bot className="size-5" />
                </div>
                {normalizedQuery
                  ? "No actors matched your search."
                  : "No active actors are available in this workspace."}
              </div>
            ) : null}
          </div>
        </ScrollArea>

        {mode === "launch" ? (
          <FieldGroup>
            <Field orientation="horizontal">
              <Checkbox
                id="save-chief-actor"
                checked={saveAsDefault}
                onCheckedChange={(checked) =>
                  setSaveAsDefault(Boolean(checked))
                }
              />
              <FieldContent>
                <FieldLabel htmlFor="save-chief-actor">
                  Save as my chief actor
                </FieldLabel>
                <FieldDescription>
                  Future conversations started from the dashboard home page will
                  launch directly to this actor.
                </FieldDescription>
              </FieldContent>
            </Field>
          </FieldGroup>
        ) : null}

        {errorMessage ? (
          <p className="text-sm text-destructive">{errorMessage}</p>
        ) : null}
      </div>

      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          onClick={() => onOpenChange(false)}
          disabled={busy}
        >
          Cancel
        </Button>
        <Button
          type="button"
          onClick={() => void handleConfirm()}
          disabled={!selectedActorId || loading || busy}
        >
          {primaryLabel}
        </Button>
      </DialogFooter>
    </>
  )
}

export default function ChiefActorPickerDialog({
  open,
  onOpenChange,
  workspaceId,
  mode,
  initialActorId,
  initialSaveAsDefault,
  busy = false,
  onConfirm,
}: ChiefActorPickerDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        {open ? (
          <ChiefActorPickerDialogBody
            key={[
              workspaceId,
              mode,
              initialActorId || "",
              initialSaveAsDefault ? "default" : "temporary",
            ].join(":")}
            onOpenChange={onOpenChange}
            workspaceId={workspaceId}
            mode={mode}
            initialActorId={initialActorId}
            initialSaveAsDefault={initialSaveAsDefault}
            busy={busy}
            onConfirm={onConfirm}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
