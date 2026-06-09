"use client"

import { useState } from "react"
import type { PluginAttachmentScopeType, ReuseScope } from "@synapse/shared"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Check, ChevronRight, ExternalLink, HelpCircle } from "lucide-react"
import { usePluginStore } from "@/stores/plugin-store"
import { useWorkspace } from "@/app/dashboard/workspace-provider"

interface SetupStep {
  id: string
  title: string
  description: string
  scope: "workspace" | "plugin"
  fields: string[]
  optional?: boolean
  helpUrl?: string
  helpText?: string
}

interface Props {
  plugin: any
  attachmentScopeType?: PluginAttachmentScopeType
  actorId?: string
  conversationId?: string
  workspaceMemberId?: string
  lifecycleScope?: ReuseScope
  onClose: () => void
  onComplete: () => void
}

export default function SetupWizardDialog({
  plugin,
  attachmentScopeType = "workspace",
  actorId,
  conversationId,
  workspaceMemberId,
  lifecycleScope,
  onClose,
  onComplete,
}: Props) {
  const { workspaceId, currentWorkspaceMemberId } = useWorkspace()
  const { installPlugin } = usePluginStore()
  const effectiveCurrentWorkspaceMemberId = currentWorkspaceMemberId || ""

  const allSteps: SetupStep[] = plugin.setup_steps || []

  const [currentStep, setCurrentStep] = useState(0)
  const [configValues, setConfigValues] = useState<
    Record<string, Record<string, string>>
  >({})
  const [saving, setSaving] = useState(false)
  const [completedSteps, setCompletedSteps] = useState<Set<number>>(new Set())
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})

  if (allSteps.length === 0) {
    return null
  }

  const step = allSteps[currentStep]
  const isLastStep = currentStep === allSteps.length - 1
  const stepValues = configValues[step?.id] || {}

  const schema = plugin.config_schema || {}
  const schemaProperties = schema.properties || {}

  const handleFieldChange = (field: string, value: string) => {
    setConfigValues((prev) => ({
      ...prev,
      [step.id]: { ...(prev[step.id] || {}), [field]: value },
    }))
    if (fieldErrors[field]) {
      setFieldErrors((prev) => {
        const n = { ...prev }
        delete n[field]
        return n
      })
    }
  }

  const validateStep = (): boolean => {
    const errors: Record<string, string> = {}
    const required = schema.required || []
    for (const field of step.fields) {
      if (required.includes(field) && !stepValues[field]) {
        errors[field] = `${field} is required`
      }
    }
    setFieldErrors(errors)
    return Object.keys(errors).length === 0
  }

  const handleNext = async () => {
    if (!step.optional && !validateStep()) return

    setSaving(true)
    try {
      setCompletedSteps((prev) => new Set(prev).add(currentStep))

      if (isLastStep) {
        // Collect all config from all steps
        const allConfig: Record<string, string> = {}
        for (const vals of Object.values(configValues)) {
          for (const [k, v] of Object.entries(vals)) {
            if (v) allConfig[k] = v
          }
        }

        await installPlugin(workspaceId!, {
          pluginId: plugin.id,
          attachmentScope: {
            type: attachmentScopeType,
            actorId: attachmentScopeType === "actor" ? actorId : undefined,
            conversationId:
              attachmentScopeType === "conversation"
                ? conversationId
                : undefined,
            workspaceMemberId:
              attachmentScopeType === "workspace_member"
                ? workspaceMemberId || effectiveCurrentWorkspaceMemberId
                : undefined,
          },
          lifecycleScope,
          configData: Object.keys(allConfig).length > 0 ? allConfig : undefined,
        })
        onComplete()
      } else {
        setCurrentStep((prev) => prev + 1)
        setFieldErrors({})
      }
    } catch (err: any) {
      alert("Failed: " + err.message)
    } finally {
      setSaving(false)
    }
  }

  const handleSkip = () => {
    if (isLastStep) {
      setSaving(true)
      installPlugin(workspaceId!, {
        pluginId: plugin.id,
        attachmentScope: {
          type: attachmentScopeType,
          actorId: attachmentScopeType === "actor" ? actorId : undefined,
          conversationId:
            attachmentScopeType === "conversation" ? conversationId : undefined,
          workspaceMemberId:
            attachmentScopeType === "workspace_member"
              ? workspaceMemberId || effectiveCurrentWorkspaceMemberId
              : undefined,
        },
        lifecycleScope,
      })
        .then(() => onComplete())
        .finally(() => setSaving(false))
    } else {
      setCurrentStep((prev) => prev + 1)
      setFieldErrors({})
    }
  }

  return (
    <Dialog open onOpenChange={() => onClose()}>
      <DialogContent className="max-w-md border-gray-200 bg-white ring-1 ring-gray-200 dark:border-white/10 dark:bg-gray-900 dark:ring-white/10">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            Setup {plugin.display_name}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Step indicator */}
          <div className="flex items-center gap-2">
            {allSteps.map((s, i) => (
              <div key={s.id} className="flex items-center gap-1">
                <div
                  className={`flex h-7 w-7 items-center justify-center rounded-full border text-xs font-medium ${
                    completedSteps.has(i)
                      ? "border-green-500/30 bg-green-500/20 text-green-400"
                      : i === currentStep
                        ? "border-blue-500/30 bg-blue-500/20 text-blue-400"
                        : "border-muted/20 bg-muted/10 text-muted-foreground"
                  }`}
                >
                  {completedSteps.has(i) ? (
                    <Check className="h-3.5 w-3.5" />
                  ) : (
                    i + 1
                  )}
                </div>
                {i < allSteps.length - 1 && (
                  <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                )}
              </div>
            ))}
          </div>

          {/* Step content */}
          <div className="space-y-3">
            <div>
              <h3 className="text-sm font-medium">{step.title}</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                {step.description}
              </p>
            </div>

            {step.optional && (
              <Badge
                variant="outline"
                className="border-gray-200 text-xs text-muted-foreground dark:border-white/10"
              >
                Optional
              </Badge>
            )}

            {step.fields.map((field) => {
              const fieldSchema = schemaProperties[field] || {}
              const isSensitive = fieldSchema.sensitive === true
              const isRequired = (schema.required || []).includes(field)
              const error = fieldErrors[field]

              return (
                <div key={field} className="space-y-1.5">
                  <div className="flex items-center gap-2">
                    <Label className="text-sm">
                      {fieldSchema.description || field}
                    </Label>
                    {isRequired && (
                      <span className="text-xs text-red-400">*</span>
                    )}
                  </div>
                  <Input
                    type={isSensitive ? "password" : "text"}
                    placeholder={`Enter ${field}...`}
                    value={stepValues[field] || ""}
                    onChange={(e) => handleFieldChange(field, e.target.value)}
                    className={`bg-white ring-1 ring-gray-200 dark:bg-gray-900 dark:ring-white/10 ${error ? "border-red-500/50" : "border-gray-200 dark:border-white/10"}`}
                  />
                  {error && <p className="text-xs text-red-400">{error}</p>}
                </div>
              )
            })}

            {(step.helpUrl || step.helpText) && (
              <div className="space-y-1.5 rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-white/10 dark:bg-white/5">
                <div className="flex items-center gap-1.5 text-xs font-medium text-blue-400">
                  <HelpCircle className="h-3.5 w-3.5" />
                  Help
                </div>
                {step.helpText && (
                  <p className="text-xs text-muted-foreground">
                    {step.helpText}
                  </p>
                )}
                {step.helpUrl && (
                  <a
                    href={step.helpUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300"
                  >
                    Open documentation <ExternalLink className="h-3 w-3" />
                  </a>
                )}
              </div>
            )}
          </div>

          {/* Actions */}
          <div className="flex gap-2 pt-2">
            <Button onClick={handleNext} disabled={saving} className="flex-1">
              {saving ? "Saving..." : isLastStep ? "Complete Setup" : "Next"}
            </Button>
            {step.optional && (
              <Button variant="outline" onClick={handleSkip} disabled={saving}>
                Skip
              </Button>
            )}
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
