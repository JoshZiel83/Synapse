"use client"

import { startTransition, useEffect, useMemo, useRef, useState } from "react"
import {
  APP_NAME,
  type Actor,
  type WorkspaceChiefActorPreference,
} from "@synapse/shared"
import { Bot, ChevronDown, Send } from "lucide-react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import { normalizeChiefActorOption } from "@/app/dashboard/chief-actor-picker-shared"
import ChatAvatar from "@/app/dashboard/chat/chat-avatar"
import ChiefActorPickerDialog from "@/app/dashboard/chief-actor-picker-dialog"
import { useWorkspace } from "@/app/dashboard/workspace-provider"
import ChatComposer, {
  type ChatComposerParticipant,
  type ChatComposerSubmitPayload,
} from "@/components/chat-composer"
import { Button } from "@/components/ui/button"
import {
  Field,
  FieldContent,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { api, ApiError } from "@/lib/api"
import { cn } from "@/lib/utils"
import { useChatStore } from "@/stores/chat-store"

type PickerMode = "launch"
type PickerIntent = "submit" | "target"
type LaunchActor = {
  id: string
  name: string
  role: string
  title: string
  avatarUrl?: string
  emoji?: string
  summary?: string
}

function getErrorMessage(error: unknown) {
  if (error instanceof ApiError) return error.message
  if (error instanceof Error) return error.message
  return "Something went wrong."
}

function emptyPreference(workspaceId: string): WorkspaceChiefActorPreference {
  return {
    workspaceId,
    workspaceMemberId: "",
  }
}

function toLaunchActor(
  actor?: WorkspaceChiefActorPreference["chiefActor"] | null
): LaunchActor | null {
  if (!actor) return null

  return {
    id: actor.id,
    name: actor.name,
    role: actor.role,
    title: actor.title,
    avatarUrl: actor.avatarUrl,
    summary: actor.title || actor.role,
  }
}

const SEND_BUTTON_ANIMATION_MS = 1280

export default function DashboardHomePage() {
  const router = useRouter()
  const { workspaceId, workspaceName } = useWorkspace()
  const { createWorkspaceThread, selectConversation } = useChatStore()
  const sendAnimationTimerRef = useRef<number | null>(null)

  const [pendingLaunchPayload, setPendingLaunchPayload] =
    useState<ChatComposerSubmitPayload | null>(null)
  const [preference, setPreference] =
    useState<WorkspaceChiefActorPreference | null>(null)
  const [loadingPreference, setLoadingPreference] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerMode, setPickerMode] = useState<PickerMode>("launch")
  const [pickerIntent, setPickerIntent] = useState<PickerIntent>("submit")
  const [launchActor, setLaunchActor] = useState<LaunchActor | null>(null)
  const [availableActors, setAvailableActors] = useState<LaunchActor[]>([])
  const [sendAnimating, setSendAnimating] = useState(false)
  const [composerResetSignal, setComposerResetSignal] = useState(0)

  useEffect(() => {
    if (!workspaceId) {
      setPreference(null)
      return
    }

    let cancelled = false
    setLoadingPreference(true)
    setErrorMessage(null)

    void api
      .getWorkspaceChiefActorPreference(workspaceId)
      .then((result) => {
        if (!cancelled) {
          setPreference(result)
        }
      })
      .catch((error) => {
        if (!cancelled) {
          console.error("Failed to load chief actor preference:", error)
          setPreference(emptyPreference(workspaceId))
          setErrorMessage("Failed to load your chief actor preference.")
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingPreference(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [workspaceId])

  useEffect(() => {
    if (!workspaceId) {
      setAvailableActors([])
      return
    }

    let cancelled = false

    void api
      .getActors(workspaceId)
      .then((response) => {
        if (cancelled) return
        const actors = Array.isArray(response)
          ? (response as Actor[])
          : ((response?.actors || []) as Actor[])
        const nextActors = actors
          .filter((actor) => actor.isActive !== false)
          .map((actor) => {
            const normalized = normalizeChiefActorOption(actor)
            return {
              id: normalized.id,
              name: normalized.name,
              role: normalized.role,
              title: normalized.title,
              avatarUrl: normalized.avatarUrl,
              emoji: normalized.emoji,
              summary: normalized.summary,
            } satisfies LaunchActor
          })
          .sort((left, right) => left.name.localeCompare(right.name))

        setAvailableActors(nextActors)
      })
      .catch((error) => {
        if (cancelled) return
        console.error("Failed to load available dashboard actors:", error)
        setAvailableActors([])
      })

    return () => {
      cancelled = true
    }
  }, [workspaceId])

  useEffect(() => {
    setLaunchActor(toLaunchActor(preference?.chiefActor))
  }, [preference])

  useEffect(() => {
    return () => {
      if (sendAnimationTimerRef.current !== null) {
        window.clearTimeout(sendAnimationTimerRef.current)
      }
    }
  }, [])

  const composerParticipants = useMemo<ChatComposerParticipant[]>(
    () =>
      availableActors.map((actor) => ({
        id: actor.id,
        name: actor.name,
        type: "actor",
        targetType: "actor",
        actorId: actor.id,
        role: actor.role,
        title: actor.title,
        avatarUrl: actor.avatarUrl,
        emoji: actor.emoji,
        description: actor.summary || actor.title || actor.role,
        searchTerms: [actor.name, actor.title, actor.role, actor.summary || ""],
      })),
    [availableActors]
  )

  function resolveLaunchActors(primaryActor?: LaunchActor | null) {
    return primaryActor ? [primaryActor] : []
  }

  function handlePickerOpenChange(nextOpen: boolean) {
    setPickerOpen(nextOpen)
  }

  function playSendFlight(): Promise<void> {
    if (typeof window === "undefined") {
      return Promise.resolve()
    }

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setSendAnimating(false)
      return Promise.resolve()
    }

    if (sendAnimationTimerRef.current !== null) {
      window.clearTimeout(sendAnimationTimerRef.current)
    }

    setSendAnimating(true)

    return new Promise((resolve) => {
      sendAnimationTimerRef.current = window.setTimeout(() => {
        setSendAnimating(false)
        sendAnimationTimerRef.current = null
        resolve()
      }, SEND_BUTTON_ANIMATION_MS)
    })
  }

  async function handleLaunch(
    primaryActor: LaunchActor | null,
    groupedActors: LaunchActor[],
    saveAsDefault: boolean,
    payload?: ChatComposerSubmitPayload | null
  ) {
    if (!workspaceId) return

    const launchPayload = payload ?? pendingLaunchPayload
    const message = launchPayload?.plainText.trim() || ""
    const actorIds = Array.from(
      new Set(groupedActors.map((actor) => actor.id).filter(Boolean))
    )
    const threadTitle = groupedActors
      .map((actor) => actor.name.trim())
      .filter(Boolean)
      .join(", ")

    if (!launchPayload || launchPayload.contentBlocks.length === 0) {
      setErrorMessage("Enter a first message to start a conversation.")
      return false
    }

    if (actorIds.length === 0) {
      setErrorMessage("Select or mention at least one actor to start.")
      return false
    }

    setSubmitting(true)
    setErrorMessage(null)
    const flightPromise = playSendFlight()

    const [[groupResult, preferenceResult]] = await Promise.all([
      Promise.allSettled([
        createWorkspaceThread(
          workspaceId,
          "group",
          actorIds,
          message || undefined,
          launchPayload.contentBlocks,
          threadTitle || undefined
        ),
        saveAsDefault && primaryActor
          ? api.updateWorkspaceChiefActorPreference(workspaceId, {
              chiefActorId: primaryActor.id,
            })
          : Promise.resolve(null),
      ]),
      flightPromise,
    ])

    setSubmitting(false)

    if (groupResult.status === "rejected") {
      setErrorMessage(getErrorMessage(groupResult.reason))
      return false
    }

    let nextLaunchActor = toLaunchActor(preference?.chiefActor)

    if (preferenceResult.status === "fulfilled" && preferenceResult.value) {
      setPreference(preferenceResult.value)
      nextLaunchActor = toLaunchActor(preferenceResult.value.chiefActor)
    } else if (preferenceResult.status === "rejected") {
      toast.error("Conversation started, but saving your chief actor failed.")
    }

    const conversationId = groupResult.value
    selectConversation(conversationId)
    setPendingLaunchPayload(null)
    setPickerOpen(false)
    setLaunchActor(nextLaunchActor)
    setComposerResetSignal((currentValue) => currentValue + 1)
    startTransition(() => {
      router.push(`/dashboard/chat?conversation=${conversationId}`)
    })
    return true
  }

  async function handleComposerSubmit(payload: ChatComposerSubmitPayload) {
    if (payload.contentBlocks.length === 0) {
      setErrorMessage("Enter a first message to start a conversation.")
      return false
    }

    setErrorMessage(null)
    setPendingLaunchPayload(payload)

    const launchActors = resolveLaunchActors(launchActor)
    if (launchActors.length > 0) {
      return handleLaunch(launchActor, launchActors, false, payload)
    }

    setPickerMode("launch")
    setPickerIntent("submit")
    setPickerOpen(true)
    return false
  }

  async function handleSelectLaunchActor(
    actor: LaunchActor,
    saveAsDefault: boolean
  ) {
    setLaunchActor(actor)

    if (!saveAsDefault || !workspaceId) {
      setPickerOpen(false)
      return
    }

    setSubmitting(true)
    setErrorMessage(null)

    try {
      const nextPreference = await api.updateWorkspaceChiefActorPreference(
        workspaceId,
        { chiefActorId: actor.id }
      )
      setPreference(nextPreference)
      setLaunchActor(toLaunchActor(nextPreference.chiefActor) || actor)
      setPickerOpen(false)
      toast.success("Chief actor updated.")
    } catch (error) {
      setErrorMessage(getErrorMessage(error))
    } finally {
      setSubmitting(false)
    }
  }

  if (!workspaceId) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <p className="text-sm text-muted-foreground">
          Select a workspace to start a conversation.
        </p>
      </div>
    )
  }

  const targetLabel = launchActor?.title || launchActor?.role

  return (
    <>
      <div className="flex min-h-[calc(100vh-10rem)] items-center justify-center py-8">
        <div className="w-full max-w-3xl -translate-y-8 lg:-translate-y-12">
          <div className="flex flex-col gap-8">
            <div className="flex flex-col items-center gap-2 text-center">
              <p className="text-xs font-medium tracking-[0.24em] text-muted-foreground uppercase">
                {workspaceName || "Workspace"}
              </p>
              <h1 className="font-display text-5xl font-semibold tracking-tight text-foreground lg:text-6xl">
                {APP_NAME}
              </h1>
            </div>

            <FieldGroup className="gap-5">
              <Field>
                <FieldLabel className="sr-only">Your first message</FieldLabel>
                <FieldContent className="items-start">
                  <ChatComposer
                    workspaceId={workspaceId}
                    participants={composerParticipants}
                    disabled={submitting}
                    placeholder="Ask anything..."
                    resetSignal={composerResetSignal}
                    className="w-full rounded-[28px] border-border bg-card text-left"
                    editorClassName="[&_.ProseMirror]:min-h-36 [&_.ProseMirror]:text-left [&_.ProseMirror]:text-base"
                    header={
                      <button
                        type="button"
                        onClick={() => {
                          setErrorMessage(null)
                          setPickerMode("launch")
                          setPickerIntent("target")
                          setPickerOpen(true)
                        }}
                        disabled={loadingPreference || submitting}
                        className="inline-flex w-full max-w-full items-center justify-start gap-2 text-left text-sm text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {launchActor ? (
                          <ChatAvatar
                            name={launchActor.name}
                            avatarUrl={launchActor.avatarUrl}
                            emoji={launchActor.emoji}
                            entityType="actor"
                            size="sm"
                          />
                        ) : (
                          <Bot className="size-4 shrink-0" />
                        )}
                        <span className="text-xs tracking-[0.18em] text-muted-foreground uppercase">
                          To
                        </span>
                        <span className="min-w-0 truncate font-medium text-foreground">
                          {launchActor ? launchActor.name : "Select actor"}
                        </span>
                        {targetLabel ? (
                          <span className="hidden max-w-36 truncate text-xs sm:inline">
                            {targetLabel}
                          </span>
                        ) : null}
                        <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
                      </button>
                    }
                    renderSubmitButton={({ disabled }) => (
                      <Button
                        type="submit"
                        size="sm"
                        disabled={disabled}
                        data-flight={sendAnimating ? "true" : "false"}
                        className={cn(
                          "home-send-button min-w-[112px] rounded-full px-4 pr-11 shadow-sm"
                        )}
                      >
                        <span className="home-send-button__label">Send</span>
                        <span
                          className="home-send-button__plane"
                          aria-hidden="true"
                        >
                          <Send className="size-4" />
                        </span>
                      </Button>
                    )}
                    onSubmit={handleComposerSubmit}
                  />
                  {errorMessage ? (
                    <FieldError className="text-left">
                      {errorMessage}
                    </FieldError>
                  ) : null}
                </FieldContent>
              </Field>
            </FieldGroup>
          </div>
        </div>
      </div>

      <ChiefActorPickerDialog
        open={pickerOpen}
        onOpenChange={handlePickerOpenChange}
        workspaceId={workspaceId}
        mode={pickerMode}
        initialActorId={launchActor?.id || preference?.chiefActorId}
        busy={submitting}
        onConfirm={async (payload) => {
          if (pickerIntent === "target") {
            await handleSelectLaunchActor(payload.actor, payload.saveAsDefault)
            return
          }

          const groupedActors = resolveLaunchActors(payload.actor)
          await handleLaunch(
            payload.actor,
            groupedActors,
            payload.saveAsDefault,
            pendingLaunchPayload
          )
        }}
      />
    </>
  )
}
