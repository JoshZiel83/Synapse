"use client"

import { useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import {
  buildAutomationRuleDraftFromRule,
  createEmptyAutomationRuleDraft,
} from "@synapse/shared"
import type { AutomationRule } from "@synapse/shared"
import { toast } from "sonner"

import { useWorkspace } from "@/app/dashboard/workspace-provider"
import { AutomationRuleEditor } from "@/components/automation-rule-editor"
import {
  AppCard,
  AppCardContent,
  AppCardDescription,
  AppCardHeader,
  AppCardTitle,
} from "@/components/app-card"
import { api } from "@/lib/api"

import { createLogger } from "@/lib/client-logger"

const clientLog = createLogger("web.components.automation-trigger-edit-page")

export function AutomationTriggerEditPage({
  triggerId,
}: {
  triggerId: string
}) {
  const router = useRouter()
  const { workspaceId, workspaceName } = useWorkspace()
  const [rule, setRule] = useState<AutomationRule | null>(null)
  const [loadingRule, setLoadingRule] = useState(true)

  useEffect(() => {
    const currentWorkspaceId = workspaceId
    if (typeof currentWorkspaceId !== "string" || !currentWorkspaceId) {
      setRule(null)
      setLoadingRule(false)
      return
    }

    let cancelled = false

    async function loadRule(activeWorkspaceId: string) {
      setLoadingRule(true)
      try {
        const nextRule = await api.getAutomation(activeWorkspaceId, triggerId)
        if (!cancelled) {
          setRule(nextRule)
        }
      } catch (error) {
        clientLog.error("Failed to load trigger for editing:", error)
        if (!cancelled) {
          setRule(null)
          toast.error(
            error instanceof Error ? error.message : "Failed to load trigger"
          )
        }
      } finally {
        if (!cancelled) {
          setLoadingRule(false)
        }
      }
    }

    void loadRule(currentWorkspaceId)

    return () => {
      cancelled = true
    }
  }, [triggerId, workspaceId])

  const initialDraft = useMemo(() => {
    if (rule) {
      return buildAutomationRuleDraftFromRule(rule)
    }
    return createEmptyAutomationRuleDraft(
      Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
    )
  }, [rule])

  if (workspaceId && !loadingRule && !rule) {
    return (
      <div className="flex flex-col gap-6 px-4 pt-6 pb-6 lg:px-6">
        <AppCard variant="panel">
          <AppCardHeader>
            <AppCardTitle>Trigger Not Available</AppCardTitle>
            <AppCardDescription>
              The requested trigger could not be loaded in this workspace.
            </AppCardDescription>
          </AppCardHeader>
          <AppCardContent className="text-sm text-muted-foreground">
            Refresh the triggers list and reopen the editor, or confirm that the
            rule still exists.
          </AppCardContent>
        </AppCard>
      </div>
    )
  }

  return (
    <AutomationRuleEditor
      workspaceId={workspaceId}
      workspaceName={workspaceName}
      title={rule ? `Edit Trigger: ${rule.name}` : "Edit Trigger"}
      description="Adjust schedule, event bindings, recipients, and wake context on a dedicated page."
      submitLabel="Save Trigger"
      loadingLabel="Loading trigger configuration..."
      initialDraft={initialDraft}
      loadingInitial={loadingRule}
      includeInactiveEventSources
      onSubmit={async (payload) => {
        if (!workspaceId) return
        await api.updateAutomation(workspaceId, triggerId, payload)
        toast.success("Trigger updated")
        router.push("/dashboard/triggers")
      }}
    />
  )
}
