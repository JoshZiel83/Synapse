"use client"

import { useMemo } from "react"
import { useRouter } from "next/navigation"
import { createEmptyAutomationRuleDraft } from "@synapse/shared"
import { toast } from "sonner"

import { useWorkspace } from "@/app/dashboard/workspace-provider"
import { AutomationRuleEditor } from "@/components/automation-rule-editor"
import { api } from "@/lib/api"

export default function NewTriggerPage() {
  const router = useRouter()
  const { workspaceId, workspaceName } = useWorkspace()

  const initialDraft = useMemo(
    () =>
      createEmptyAutomationRuleDraft(
        Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
      ),
    []
  )

  return (
    <AutomationRuleEditor
      workspaceId={workspaceId}
      workspaceName={workspaceName}
      title="Create Trigger"
      description="Define a schedule or event subscription without squeezing the form into a modal."
      submitLabel="Create Trigger"
      loadingLabel="Preparing trigger editor..."
      initialDraft={initialDraft}
      onSubmit={async (payload) => {
        if (!workspaceId) return
        await api.createAutomation(workspaceId, payload)
        toast.success("Trigger created")
        router.push("/dashboard/triggers")
      }}
    />
  )
}
