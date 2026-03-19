"use client"

import { startTransition, useState } from "react"
import { useRouter } from "next/navigation"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { api } from "@/lib/api"

type WorkspaceMode = "create" | "join"

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback
}

export function MobileWelcomeClient() {
  const router = useRouter()
  const [mode, setMode] = useState<WorkspaceMode>("create")
  const [workspaceName, setWorkspaceName] = useState("")
  const [inviteCode, setInviteCode] = useState("")
  const [error, setError] = useState("")
  const [isSubmitting, setIsSubmitting] = useState(false)

  function openWorkspace(workspaceId: string) {
    localStorage.setItem("workspaceId", workspaceId)
    startTransition(() => {
      router.push("/m")
    })
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError("")
    setIsSubmitting(true)

    try {
      if (mode === "create") {
        const nextWorkspaceName = workspaceName.trim()
        if (!nextWorkspaceName) {
          setError("Please enter a workspace name")
          setIsSubmitting(false)
          return
        }

        const workspace = await api.createWorkspace(nextWorkspaceName)
        if (workspace?.id) {
          openWorkspace(workspace.id)
          return
        }

        setError("Workspace created, but no workspace ID was returned")
        setIsSubmitting(false)
        return
      }

      const nextInviteCode = inviteCode.trim()
      if (!nextInviteCode) {
        setError("Please enter an invite code")
        setIsSubmitting(false)
        return
      }

      const result = await api.redeemInvite(nextInviteCode)
      if (result?.workspaceId) {
        openWorkspace(result.workspaceId)
        return
      }

      setError("Invite accepted, but no workspace ID was returned")
    } catch (error) {
      setError(
        getErrorMessage(
          error,
          mode === "create"
            ? "Failed to create workspace"
            : "Failed to join workspace"
        )
      )
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div className="min-h-svh bg-[linear-gradient(180deg,color-mix(in_oklab,var(--color-muted)_72%,white)_0%,var(--color-background)_34%)] px-5 py-[calc(env(safe-area-inset-top)+2rem)]">
      <div className="mx-auto w-full max-w-sm space-y-8 pb-[calc(env(safe-area-inset-bottom)+1rem)]">
        <div className="space-y-2">
          <h1 className="text-3xl font-semibold tracking-tight text-foreground">
            Welcome
          </h1>
          <p className="text-sm leading-6 text-muted-foreground">
            Create a workspace or join one with an invite code.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-2 rounded-[22px] bg-muted/70 p-1">
          <button
            type="button"
            onClick={() => {
              setMode("create")
              setError("")
            }}
            className={[
              "rounded-[18px] px-3 py-2 text-sm font-medium transition-colors",
              mode === "create"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground",
            ].join(" ")}
          >
            Create
          </button>
          <button
            type="button"
            onClick={() => {
              setMode("join")
              setError("")
            }}
            className={[
              "rounded-[18px] px-3 py-2 text-sm font-medium transition-colors",
              mode === "join"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground",
            ].join(" ")}
          >
            Join
          </button>
        </div>

        <form className="space-y-5" onSubmit={handleSubmit}>
          {mode === "create" ? (
            <div className="space-y-2">
              <label htmlFor="mobile-workspace-name" className="text-sm font-medium text-foreground">
                Workspace name
              </label>
              <Input
                id="mobile-workspace-name"
                value={workspaceName}
                onChange={(event) => setWorkspaceName(event.target.value)}
                placeholder="My Team"
                required
                className="h-12 rounded-2xl bg-background"
              />
            </div>
          ) : (
            <div className="space-y-2">
              <label htmlFor="mobile-invite-code" className="text-sm font-medium text-foreground">
                Invite code
              </label>
              <Input
                id="mobile-invite-code"
                value={inviteCode}
                onChange={(event) => setInviteCode(event.target.value)}
                placeholder="e.g. Ab3xK9mZ"
                required
                className="h-12 rounded-2xl bg-background"
              />
            </div>
          )}

          {error ? <p className="text-sm text-destructive">{error}</p> : null}

          <Button type="submit" className="h-12 w-full rounded-full" disabled={isSubmitting}>
            {isSubmitting
              ? mode === "create"
                ? "Creating workspace..."
                : "Joining workspace..."
              : mode === "create"
                ? "Create workspace"
                : "Join workspace"}
          </Button>
        </form>
      </div>
    </div>
  )
}
