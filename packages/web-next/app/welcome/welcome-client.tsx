"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"

import { AuthConversationPreview } from "@/components/auth-conversation-preview"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLegend,
  FieldLabel,
  FieldSet,
  FieldTitle,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { api } from "@/lib/api"
import { useAuthStore } from "@/stores/auth-store"

const WORKSPACE_MODE_OPTIONS = [
  {
    value: "create",
    title: "Create workspace",
    description: "Start a fresh space for your team.",
    detailDescription: "Name your workspace.",
    fieldLabel: "Workspace name",
    placeholder: "My Team",
    submitLabel: "Create workspace",
    submittingLabel: "Creating workspace...",
  },
  {
    value: "join",
    title: "Join workspace",
    description: "Use an invite code from an existing team.",
    detailDescription: "Enter your invite code.",
    fieldLabel: "Invite code",
    placeholder: "e.g. Ab3xK9mZ",
    submitLabel: "Join workspace",
    submittingLabel: "Joining workspace...",
  },
] as const

type WorkspaceMode = (typeof WORKSPACE_MODE_OPTIONS)[number]["value"]

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback
}

export default function WelcomeClient() {
  const router = useRouter()
  const user = useAuthStore((state) => state.user)
  const [mode, setMode] = useState<WorkspaceMode>("create")
  const [workspaceName, setWorkspaceName] = useState("")
  const [inviteCode, setInviteCode] = useState("")
  const [error, setError] = useState("")
  const [isSubmitting, setIsSubmitting] = useState(false)

  if (!user) {
    return null
  }

  const selectedOption = WORKSPACE_MODE_OPTIONS.find(
    (option) => option.value === mode
  )

  function openWorkspace(workspaceId: string) {
    localStorage.setItem("workspaceId", workspaceId)
    router.push("/dashboard")
  }

  async function handleCreate() {
    const nextWorkspaceName = workspaceName.trim()

    if (!nextWorkspaceName) {
      setError("Please enter a workspace name")
      return
    }

    setIsSubmitting(true)

    try {
      const workspace = await api.createWorkspace(nextWorkspaceName)
      if (workspace?.id) {
        openWorkspace(workspace.id)
        return
      }

      setError("Workspace created, but no workspace ID was returned")
    } catch (error) {
      setError(getErrorMessage(error, "Failed to create workspace"))
    } finally {
      setIsSubmitting(false)
    }
  }

  async function handleJoin() {
    const nextInviteCode = inviteCode.trim()

    if (!nextInviteCode) {
      setError("Please enter an invite code")
      return
    }

    setIsSubmitting(true)

    try {
      const result = await api.redeemInvite(nextInviteCode)
      if (result?.workspaceId) {
        openWorkspace(result.workspaceId)
        return
      }

      setError("Invite accepted, but no workspace ID was returned")
    } catch (error) {
      setError(getErrorMessage(error, "Failed to join workspace"))
    } finally {
      setIsSubmitting(false)
    }
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError("")

    if (!mode) {
      return
    }

    if (mode === "create") {
      await handleCreate()
      return
    }

    await handleJoin()
  }

  return (
    <div className="flex flex-col gap-6">
      <Card className="overflow-hidden p-0">
        <CardContent className="grid p-0 md:grid-cols-2">
          <form className="p-6 md:p-8" method="post" onSubmit={handleSubmit}>
            <FieldGroup>
              <div className="flex flex-col items-center text-center">
                <h1 className="text-2xl font-bold">Set up your workspace</h1>
              </div>
              <FieldSet>
                <FieldLegend>How would you like to start?</FieldLegend>
                <RadioGroup
                  value={mode ?? undefined}
                  onValueChange={(value) => {
                    if (value !== "create" && value !== "join") {
                      return
                    }

                    setMode(value)
                    setError("")
                  }}
                  className="w-full"
                >
                  {WORKSPACE_MODE_OPTIONS.map((option) => {
                    const fieldId = `workspace-mode-${option.value}`

                    return (
                      <FieldLabel key={option.value} htmlFor={fieldId}>
                        <Field orientation="horizontal">
                          <FieldContent>
                            <FieldTitle>{option.title}</FieldTitle>
                            <FieldDescription>
                              {option.description}
                            </FieldDescription>
                          </FieldContent>
                          <RadioGroupItem value={option.value} id={fieldId} />
                        </Field>
                      </FieldLabel>
                    )
                  })}
                </RadioGroup>
              </FieldSet>
              {selectedOption && mode === "create" ? (
                <Field data-invalid={Boolean(error) || undefined}>
                  <FieldLabel htmlFor="workspace-name">
                    {selectedOption.fieldLabel}
                  </FieldLabel>
                  <Input
                    id="workspace-name"
                    name="workspace-name"
                    value={workspaceName}
                    onChange={(event) => {
                      setWorkspaceName(event.target.value)
                      setError("")
                    }}
                    placeholder={selectedOption.placeholder}
                    autoFocus
                    aria-invalid={Boolean(error) || undefined}
                    required
                  />
                  <FieldError>{error}</FieldError>
                </Field>
              ) : selectedOption ? (
                <Field data-invalid={Boolean(error) || undefined}>
                  <FieldLabel htmlFor="invite-code">
                    {selectedOption.fieldLabel}
                  </FieldLabel>
                  <Input
                    id="invite-code"
                    name="invite-code"
                    value={inviteCode}
                    onChange={(event) => {
                      setInviteCode(event.target.value)
                      setError("")
                    }}
                    placeholder={selectedOption.placeholder}
                    autoFocus
                    aria-invalid={Boolean(error) || undefined}
                    required
                  />
                  <FieldError>{error}</FieldError>
                </Field>
              ) : null}
              {selectedOption ? (
                <Field>
                  <Button
                    type="submit"
                    disabled={isSubmitting}
                    className="w-full"
                  >
                    {isSubmitting
                      ? selectedOption.submittingLabel
                      : selectedOption.submitLabel}
                  </Button>
                </Field>
              ) : null}
            </FieldGroup>
          </form>
          <div className="relative hidden bg-muted md:block">
            <AuthConversationPreview />
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
