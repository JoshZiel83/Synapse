"use client"

import Link from "next/link"
import { startTransition, useEffect, useState } from "react"
import { APP_NAME, type WorkspaceChiefActorPreference } from "@synapse/shared"
import {
  Bot,
  ChevronRight,
  MessageSquareText,
  Send,
} from "lucide-react"
import { useRouter } from "next/navigation"

import ChatAvatar from "@/app/dashboard/chat/chat-avatar"
import type { ChiefActorOption } from "@/app/dashboard/chief-actor-picker-shared"
import {
  clearStoredMobileLaunchActor,
  type MobileLaunchActor,
  readStoredMobileLaunchActor,
  writeStoredMobileLaunchActor,
} from "@/app/m/mobile-launcher-state"
import { useWorkspace } from "@/app/dashboard/workspace-provider"
import { MobileActorPickerDialog } from "@/components/mobile-actor-picker-dialog"
import { MobileHeaderActions } from "@/components/mobile-header-actions"
import { MobilePageHeader } from "@/components/mobile-page-header"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"
import { api, ApiError } from "@/lib/api"
import { useChatStore } from "@/stores/chat-store"

type PickerIntent = "submit" | "target"

function emptyPreference(workspaceId: string): WorkspaceChiefActorPreference {
  return {
    workspaceId,
    workspaceMemberId: "",
  }
}

function toLaunchActor(
  actor?: WorkspaceChiefActorPreference["chiefActor"] | null
): MobileLaunchActor | null {
  if (!actor) return null

  return {
    id: actor.id,
    name: actor.name,
    role: actor.role,
    title: actor.title,
    avatarUrl: actor.avatarUrl,
  }
}

function getErrorMessage(error: unknown) {
  if (error instanceof ApiError) return error.message
  if (error instanceof Error) return error.message
  return "Something went wrong."
}

export default function MobileHomePage() {
  const router = useRouter()
  const { workspaceId } = useWorkspace()
  const conversations = useChatStore((state) => state.conversations)
  const loadingConversations = useChatStore(
    (state) => state.loadingConversations
  )
  const createWorkspaceThread = useChatStore(
    (state) => state.createWorkspaceThread
  )
  const selectConversation = useChatStore((state) => state.selectConversation)

  const [draft, setDraft] = useState("")
  const [preference, setPreference] =
    useState<WorkspaceChiefActorPreference | null>(null)
  const [launchActor, setLaunchActor] = useState<MobileLaunchActor | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerIntent, setPickerIntent] = useState<PickerIntent>("target")
  const [submitting, setSubmitting] = useState(false)
  const [loadingPreference, setLoadingPreference] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  useEffect(() => {
    if (!workspaceId) {
      setPreference(null)
      setLaunchActor(null)
      clearStoredMobileLaunchActor()
      return
    }

    let cancelled = false
    setLoadingPreference(true)
    setErrorMessage(null)

    void api
      .getWorkspaceChiefActorPreference(workspaceId)
      .then((result) => {
        if (cancelled) return
        setPreference(result)
      })
      .catch((error) => {
        if (cancelled) return
        console.error("Failed to load chief actor preference:", error)
        const fallback = emptyPreference(workspaceId)
        setPreference(fallback)
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
      setLaunchActor(null)
      return
    }

    const storedActor = readStoredMobileLaunchActor(workspaceId)
    setLaunchActor(storedActor || toLaunchActor(preference?.chiefActor))
  }, [preference, workspaceId])

  function openActorPicker(intent: PickerIntent) {
    if (!workspaceId) return
    setErrorMessage(null)
    setPickerIntent(intent)
    setPickerOpen(true)
  }

  async function persistDefaultActor(
    actorId: string,
    saveAsDefault: boolean,
    fallbackActor?: MobileLaunchActor
  ) {
    if (!workspaceId || !saveAsDefault) return

    try {
      const nextPreference = await api.updateWorkspaceChiefActorPreference(
        workspaceId,
        { chiefActorId: actorId }
      )
      setPreference(nextPreference)
      setLaunchActor(
        toLaunchActor(nextPreference.chiefActor) || fallbackActor || null
      )
    } catch (error) {
      console.error("Failed to update chief actor preference:", error)
    }
  }

  async function handleLaunch(
    actor: MobileLaunchActor,
    saveAsDefault: boolean
  ) {
    if (!workspaceId) return

    const message = draft.trim()
    if (!message) {
      setErrorMessage("Enter a first message to start a conversation.")
      return
    }

    setSubmitting(true)
    setErrorMessage(null)

    try {
      const conversationId = await createWorkspaceThread(
        workspaceId,
        "group",
        [actor.id],
        message,
        actor.id,
        undefined,
        actor.name
      )
      writeStoredMobileLaunchActor(workspaceId, actor)

      if (saveAsDefault) {
        await persistDefaultActor(actor.id, true, actor)
      } else {
        setLaunchActor(actor)
      }

      selectConversation(conversationId)
      setDraft("")

      startTransition(() => {
        router.push(`/m/chat/${conversationId}`)
      })
    } catch (error) {
      setErrorMessage(getErrorMessage(error))
    } finally {
      setSubmitting(false)
    }
  }

  function launchFromDraft() {
    const message = draft.trim()
    if (!message) {
      setErrorMessage("Enter a first message to start a conversation.")
      return
    }

    if (launchActor) {
      void handleLaunch(launchActor, false)
      return
    }

    openActorPicker("submit")
  }

  async function handleActorPickerConfirm({
    selectedActors,
    saveAsDefault,
  }: {
    selectedActors: ChiefActorOption[]
    saveAsDefault: boolean
  }) {
    if (!workspaceId || selectedActors.length === 0) return

    const actor = selectedActors[0]!
    const nextLaunchActor: MobileLaunchActor = {
      id: actor.id,
      name: actor.name,
      role: actor.role,
      title: actor.title,
      avatarUrl: actor.avatarUrl,
      emoji: actor.emoji,
    }

    if (pickerIntent === "target") {
      writeStoredMobileLaunchActor(workspaceId, nextLaunchActor)
      setLaunchActor(nextLaunchActor)
      await persistDefaultActor(
        nextLaunchActor.id,
        saveAsDefault,
        nextLaunchActor
      )
      setPickerOpen(false)
      return
    }

    setPickerOpen(false)
    await handleLaunch(nextLaunchActor, saveAsDefault)
  }

  if (!workspaceId) {
    return (
      <div className="flex min-h-svh items-center justify-center px-6">
        <p className="max-w-xs text-center text-sm text-muted-foreground">
          Select a workspace to start a conversation on mobile.
        </p>
      </div>
    )
  }

  const initialPickerActorIds = launchActor?.id
    ? [launchActor.id]
    : preference?.chiefActorId
      ? [preference.chiefActorId]
      : []

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col bg-background">
        <MobilePageHeader
          title={APP_NAME}
          action={
            <MobileHeaderActions
              onSearch={() => router.push("/m/search")}
              onStartGroup={() => router.push("/m/contacts/group/new")}
              onAddFriend={() => router.push("/m/contacts/add")}
              onScan={() => router.push("/m/scan?intent=relationship")}
            />
          }
        />
        <div className="flex-1 overflow-y-auto px-4 pt-3 pb-[calc(var(--mobile-tab-bar-clearance,0px)+1.5rem)]">
          <div className="space-y-5">
            <section className="-mx-4 border-b border-border bg-background">
              <button
                type="button"
                onClick={() => openActorPicker("target")}
                className="flex w-full items-center gap-3 border-b border-border/70 px-4 py-3 text-left transition-colors hover:bg-muted/25"
                disabled={loadingPreference || submitting}
              >
                {launchActor ? (
                  <ChatAvatar
                    name={launchActor.name}
                    avatarUrl={launchActor.avatarUrl}
                    emoji={launchActor.emoji}
                    entityType="actor"
                    size="lg"
                  />
                ) : (
                  <div className="flex size-11 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                    <Bot className="size-5" />
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <div className="text-[11px] tracking-[0.16em] text-muted-foreground uppercase">
                    To
                  </div>
                  <div className="truncate text-sm font-medium text-foreground">
                    {launchActor ? launchActor.name : "Select actor"}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    {launchActor
                      ? launchActor.title || launchActor.role
                      : "Choose who should take this conversation"}
                  </div>
                </div>
                <ChevronRight className="size-4 text-muted-foreground" />
              </button>

              <div className="px-4 py-4">
                <div className="space-y-3">
                  <Textarea
                    value={draft}
                    onChange={(event) => {
                      setDraft(event.target.value)
                      if (errorMessage) {
                        setErrorMessage(null)
                      }
                    }}
                    placeholder="Ask anything…"
                    className="min-h-32 resize-none rounded-2xl border-border/70 bg-muted/25 px-4 py-4 text-base shadow-none"
                    onKeyDown={(event) => {
                      if (
                        event.key === "Enter" &&
                        (event.metaKey || event.ctrlKey)
                      ) {
                        event.preventDefault()
                        launchFromDraft()
                      }
                    }}
                  />
                  {errorMessage ? (
                    <p className="text-sm text-destructive">{errorMessage}</p>
                  ) : null}
                  <Button
                    type="button"
                    className="h-12 w-full rounded-full text-sm font-medium"
                    onClick={launchFromDraft}
                    disabled={!draft.trim() || submitting}
                  >
                    <Send className="mr-2 size-4" />
                    {submitting ? "Starting…" : "Start chat"}
                  </Button>
                </div>
              </div>
            </section>

            <section className="space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-base font-semibold text-foreground">
                    Recent chats
                  </h2>
                </div>
                <Button variant="ghost" size="sm" asChild>
                  <Link href="/m/chat">See all</Link>
                </Button>
              </div>

              {loadingConversations ? (
                <div className="-mx-4 border-y border-border/70 bg-background">
                  {Array.from({ length: 4 }, (_, index) => (
                    <div
                      key={index}
                      className="flex items-center gap-3 px-4 py-4"
                    >
                      <Skeleton className="size-11 shrink-0 rounded-2xl" />
                      <div className="flex min-w-0 flex-1 flex-col gap-2">
                        <Skeleton
                          className={
                            index % 2 === 0
                              ? "h-4 w-32 rounded-full"
                              : "h-4 w-40 rounded-full"
                          }
                        />
                        <Skeleton
                          className={
                            index % 2 === 0
                              ? "h-4 w-full max-w-[14rem] rounded-full"
                              : "h-4 w-[72%] rounded-full"
                          }
                        />
                      </div>
                      <Skeleton className="size-4 shrink-0 rounded-full" />
                    </div>
                  ))}
                </div>
              ) : conversations.length > 0 ? (
                <div className="-mx-4 border-y border-border/70 bg-background">
                  {conversations.slice(0, 4).map((conversation) => {
                    const name =
                      conversation.title ||
                      conversation.participants.map((p) => p.name).join(", ")
                    const preview =
                      conversation.lastMessage?.content || "No messages yet"
                    const previewLabel =
                      preview.length > 70 ? `${preview.slice(0, 70)}…` : preview

                    return (
                      <button
                        key={conversation.id}
                        type="button"
                        onClick={() => {
                          selectConversation(conversation.id)
                          startTransition(() => {
                            router.push(`/m/chat/${conversation.id}`)
                          })
                        }}
                        className="flex w-full items-center gap-3 px-4 py-4 text-left transition-colors hover:bg-muted/25"
                      >
                        <ChatAvatar
                          name={name}
                          avatarUrl={conversation.avatarUrl}
                          entityType="conversation"
                          size="lg"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium text-foreground">
                            {name}
                          </div>
                          <div className="mt-1 truncate text-sm text-muted-foreground">
                            {previewLabel}
                          </div>
                        </div>
                        <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                      </button>
                    )
                  })}
                </div>
              ) : (
                <div className="-mx-4 border-y border-dashed border-border bg-background px-4 py-8 text-center">
                  <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                    <MessageSquareText className="size-5" />
                  </div>
                  <p className="text-sm font-medium text-foreground">
                    No chats yet
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Start your first mobile conversation above.
                  </p>
                </div>
              )}
            </section>
          </div>
        </div>
      </div>
      <MobileActorPickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        workspaceId={workspaceId}
        title="Choose actor"
        description="Pick who should take this conversation."
        initialActorIds={initialPickerActorIds}
        confirmLabel={
          pickerIntent === "submit" ? "Start chat" : "Use this actor"
        }
        confirmPendingLabel={
          pickerIntent === "submit" ? "Starting..." : "Saving..."
        }
        saveAsDefaultConfig={{
          label: "Save as my chief actor",
          description:
            "Future chats started from the mobile home page will use this actor by default.",
        }}
        onConfirm={handleActorPickerConfirm}
      />
    </>
  )
}
