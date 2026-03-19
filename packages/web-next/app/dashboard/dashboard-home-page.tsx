"use client"

import { startTransition, useEffect, useRef, useState } from "react"
import { APP_NAME, type WorkspaceChiefActorPreference } from "@synapse/shared"
import { Bot, ChevronDown, Send } from "lucide-react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import ChatAvatar from "@/app/dashboard/chat/chat-avatar"
import ChiefActorPickerDialog from "@/app/dashboard/chief-actor-picker-dialog"
import { useWorkspace } from "@/app/dashboard/workspace-provider"
import { Button } from "@/components/ui/button"
import {
  Field,
  FieldContent,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Textarea } from "@/components/ui/textarea"
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
}

function getErrorMessage(error: unknown) {
  if (error instanceof ApiError) return error.message
  if (error instanceof Error) return error.message
  return "Something went wrong."
}

function emptyPreference(workspaceId: string): WorkspaceChiefActorPreference {
  return {
    workspaceId,
    userId: "",
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
  }
}

const SEND_BUTTON_ANIMATION_MS = 1280

export default function DashboardHomePage() {
  const router = useRouter()
  const { workspaceId, workspaceName } = useWorkspace()
  const { createGroup, selectGroup } = useChatStore()
  const sendAnimationTimerRef = useRef<number | null>(null)

  const [draft, setDraft] = useState("")
  const [pendingPrompt, setPendingPrompt] = useState("")
  const [preference, setPreference] =
    useState<WorkspaceChiefActorPreference | null>(null)
  const [loadingPreference, setLoadingPreference] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerMode, setPickerMode] = useState<PickerMode>("launch")
  const [pickerIntent, setPickerIntent] = useState<PickerIntent>("submit")
  const [launchActor, setLaunchActor] = useState<LaunchActor | null>(null)
  const [sendAnimating, setSendAnimating] = useState(false)

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
    setLaunchActor(toLaunchActor(preference?.chiefActor))
  }, [preference])

  useEffect(() => {
    return () => {
      if (sendAnimationTimerRef.current !== null) {
        window.clearTimeout(sendAnimationTimerRef.current)
      }
    }
  }, [])

  function handlePickerOpenChange(nextOpen: boolean) {
    setPickerOpen(nextOpen)
    if (!nextOpen && !submitting) {
      setPendingPrompt("")
    }
  }

  async function launchFromDraft() {
    const message = draft.trim()
    if (!message) {
      setErrorMessage("Enter a first message to start a conversation.")
      return
    }

    setErrorMessage(null)
    setPendingPrompt(message)

    if (launchActor) {
      await handleLaunch(launchActor, false)
      return
    }

    setPickerMode("launch")
    setPickerIntent("submit")
    setPickerOpen(true)
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

  async function handleLaunch(actor: LaunchActor, saveAsDefault: boolean) {
    if (!workspaceId) return

    const message = pendingPrompt.trim() || draft.trim()
    if (!message) {
      setErrorMessage("Enter a first message to start a conversation.")
      return
    }

    setSubmitting(true)
    setErrorMessage(null)
    const flightPromise = playSendFlight()

    const [[groupResult, preferenceResult]] = await Promise.all([
      Promise.allSettled([
        createGroup(workspaceId, [actor.id], message, actor.id),
        saveAsDefault
          ? api.updateWorkspaceChiefActorPreference(workspaceId, {
              chiefActorId: actor.id,
            })
          : Promise.resolve(null),
      ]),
      flightPromise,
    ])

    setSubmitting(false)

    if (groupResult.status === "rejected") {
      setErrorMessage(getErrorMessage(groupResult.reason))
      return
    }

    let nextLaunchActor = toLaunchActor(preference?.chiefActor)

    if (preferenceResult.status === "fulfilled" && preferenceResult.value) {
      setPreference(preferenceResult.value)
      nextLaunchActor = toLaunchActor(preferenceResult.value.chiefActor)
    } else if (preferenceResult.status === "rejected") {
      toast.error("Conversation started, but saving your chief actor failed.")
    }

    const groupId = groupResult.value
    selectGroup(groupId)
    setDraft("")
    setPendingPrompt("")
    setPickerOpen(false)
    setLaunchActor(nextLaunchActor)
    startTransition(() => {
      router.push(`/dashboard/chat?group=${groupId}`)
    })
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    await launchFromDraft()
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
          <div className="flex flex-col gap-8 text-center">
            <div className="flex flex-col items-center gap-2">
              <p className="text-xs font-medium uppercase tracking-[0.24em] text-muted-foreground">
                {workspaceName || "Workspace"}
              </p>
              <h1 className="font-display text-5xl font-semibold tracking-tight text-foreground lg:text-6xl">
                {APP_NAME}
              </h1>
            </div>

            <form onSubmit={(event) => void handleSubmit(event)}>
              <FieldGroup className="gap-5">
                <Field>
                  <FieldLabel
                    htmlFor="dashboard-launcher-input"
                    className="sr-only"
                  >
                    Your first message
                  </FieldLabel>
                  <FieldContent className="items-center">
                    <div className="relative w-full">
                      <button
                        type="button"
                        onClick={() => {
                          setErrorMessage(null)
                          setPendingPrompt("")
                          setPickerMode("launch")
                          setPickerIntent("target")
                          setPickerOpen(true)
                        }}
                        disabled={loadingPreference || submitting}
                        className="absolute left-5 top-4 z-10 inline-flex max-w-[calc(100%-8rem)] items-center gap-2 text-left text-sm text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
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
                        <span className="text-xs uppercase tracking-[0.18em] text-muted-foreground">
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
                      <Textarea
                        id="dashboard-launcher-input"
                        value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                        placeholder="Ask anything..."
                        className="min-h-36 resize-none rounded-[28px] border-border bg-card px-5 pb-16 pt-16 text-base shadow-sm"
                        onKeyDown={(event) => {
                          if (
                            event.key === "Enter" &&
                            (event.metaKey || event.ctrlKey)
                          ) {
                            event.preventDefault()
                            void launchFromDraft()
                          }
                        }}
                      />
                      <div className="absolute inset-x-0 bottom-0 flex justify-end px-3 py-3">
                        <Button
                          type="submit"
                          size="sm"
                          disabled={!draft.trim() || submitting}
                          data-flight={sendAnimating ? "true" : "false"}
                          className={cn(
                            "home-send-button min-w-[112px] rounded-full px-4 pr-11 shadow-sm"
                          )}
                        >
                          <span className="home-send-button__label">Send</span>
                          <span className="home-send-button__plane" aria-hidden="true">
                            <Send className="size-4" />
                          </span>
                        </Button>
                      </div>
                    </div>
                    {errorMessage ? (
                      <FieldError className="text-center">
                        {errorMessage}
                      </FieldError>
                    ) : null}
                  </FieldContent>
                </Field>
              </FieldGroup>
            </form>
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

          setLaunchActor(payload.actor)
          await handleLaunch(payload.actor, payload.saveAsDefault)
        }}
      />
    </>
  )
}
