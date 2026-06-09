"use client"

import {
  CONVERSATION_TYPE_MASK_PRESETS,
  conversationTypeKeysToMask,
  conversationTypeMaskToKeys,
  type CapabilityConversationTypePolicyResourceFamily,
  type ConversationTypeKey,
} from "@synapse/shared"
import type { Timestamp } from "@synapse/shared"
import { useCallback, useEffect, useState } from "react"
import { Building2, RefreshCw, ShieldCheck, UserRound, Zap } from "lucide-react"
import { useWorkspace } from "../workspace-provider"
import { api } from "@/lib/api"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

type WorkspaceAccessKey =
  | "model_admin"
  | "actor_admin"
  | "skill_admin"
  | "plugin_admin"
  | "memory_admin"
  | "device_admin"
  | "conversation_admin"

type PlatformAccessKey =
  | "super_admin"
  | "workspace_admin"
  | "model_admin"
  | "support"
  | "auditor"

type WorkspaceMemberRecord = {
  id: string
  userId: string
  userName?: string
  userEmail?: string
  trustLevel: string
  accessKeys?: string[]
}

type WorkspaceAccessBinding = {
  workspaceId: string
  workspaceMemberId: string
  userId: string
  accessKey: WorkspaceAccessKey
  assignedByWorkspaceMemberId?: string | null
  createdAt: Timestamp
  updatedAt: Timestamp
  trustLevel: string
  userName?: string
  userEmail?: string
}

type PlatformAccessBinding = {
  userId: string
  accessKey: PlatformAccessKey
  source: string
  assignedByUserId?: string | null
  createdAt: Timestamp
  updatedAt: Timestamp
  userName?: string
  userEmail?: string
}

const workspaceAccessOptions: Array<{
  value: WorkspaceAccessKey
  label: string
  description: string
}> = [
  {
    value: "model_admin",
    label: "Models",
    description: "Can manage model groups and workspace model policy.",
  },
  {
    value: "actor_admin",
    label: "Actors",
    description: "Can manage actors and actor-to-model assignments.",
  },
  {
    value: "skill_admin",
    label: "Skills",
    description:
      "Can manage installed skills, bindings, and skill package rollout.",
  },
  {
    value: "plugin_admin",
    label: "Plugins",
    description:
      "Can manage plugin installations, mounts, and runtime approvals.",
  },
  {
    value: "memory_admin",
    label: "Memories",
    description: "Can manage workspace memories and retention rules.",
  },
  {
    value: "device_admin",
    label: "Devices",
    description: "Can manage devices, pairing, and tokens.",
  },
  {
    value: "conversation_admin",
    label: "Conversations",
    description: "Can administer conversations and chat operations.",
  },
]

const platformAccessOptions: Array<{
  value: PlatformAccessKey
  label: string
  description: string
}> = [
  {
    value: "super_admin",
    label: "Super Admin",
    description:
      "Full platform administration across all workspaces and resources.",
  },
  {
    value: "workspace_admin",
    label: "Workspace Admin",
    description:
      "Can operate workspace-level administration across the platform.",
  },
  {
    value: "model_admin",
    label: "Model Admin",
    description: "Can manage platform model groups and global model policy.",
  },
  {
    value: "support",
    label: "Support",
    description: "Operational access for troubleshooting and support work.",
  },
  {
    value: "auditor",
    label: "Auditor",
    description: "Read-only access for audit and compliance review.",
  },
]

function titleize(value: string) {
  return value
    .split("_")
    .join(" ")
    .replace(/\b\w/g, (char) => char.toUpperCase())
}

function formatTimestamp(value?: string) {
  if (!value) return "Unknown"
  try {
    return new Date(value).toLocaleString()
  } catch {
    return "Unknown"
  }
}

function getErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) return error.message
  return fallback
}

function UserIdentity({
  name,
  email,
  userId,
}: {
  name?: string
  email?: string
  userId: string
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="truncate font-medium text-foreground">
        {name || "Unknown user"}
      </div>
      <div className="truncate text-xs text-muted-foreground">
        {email || userId}
      </div>
    </div>
  )
}

const conversationTypeOptions: Array<{
  key: ConversationTypeKey
  label: string
  description: string
}> = [
  {
    key: "direct",
    label: "Direct",
    description: "1:1 conversations in the app (non-IM).",
  },
  {
    key: "group",
    label: "Group",
    description: "Group conversations in the app (non-IM).",
  },
  {
    key: "im_direct",
    label: "IM direct",
    description: "1:1 conversations bridged from a third-party IM.",
  },
  {
    key: "im_group",
    label: "IM group",
    description: "Group conversations bridged from a third-party IM.",
  },
]

const conversationTypePresets = [
  { label: "All", value: CONVERSATION_TYPE_MASK_PRESETS.ALL },
  {
    label: "Native only",
    value: CONVERSATION_TYPE_MASK_PRESETS.NATIVE_ONLY,
  },
  {
    label: "IM only",
    value: CONVERSATION_TYPE_MASK_PRESETS.IM_ONLY,
  },
  { label: "Group only", value: CONVERSATION_TYPE_MASK_PRESETS.GROUP_ONLY },
  { label: "Direct only", value: CONVERSATION_TYPE_MASK_PRESETS.DIRECT_ONLY },
] as const

const workspaceCapabilityPolicyFamilies: Array<{
  family: CapabilityConversationTypePolicyResourceFamily
  label: string
  description: string
}> = [
  {
    family: "plugin_installation",
    label: "Plugins",
    description:
      "Default conversation types for plugin installations before any installation or grant override narrows them further.",
  },
  {
    family: "installed_skill",
    label: "Skills",
    description:
      "Default conversation types for installed skills before any installation or grant override narrows them further.",
  },
  {
    family: "device_capability",
    label: "Device Capabilities",
    description:
      "Default conversation types for devices and exposures before any device, exposure, or grant override narrows them further.",
  },
]

function formatConversationTypeKeys(keys: ConversationTypeKey[]) {
  return keys
    .map(
      (key) =>
        conversationTypeOptions.find((option) => option.key === key)?.label ||
        key
    )
    .join(", ")
}

function WorkspaceConversationTypePolicyCard({
  label,
  description,
  value,
  saving,
  onSave,
}: {
  label: string
  description: string
  value: number
  saving: boolean
  onSave: (mask: number) => Promise<void>
}) {
  const [keys, setKeys] = useState<ConversationTypeKey[]>(
    conversationTypeMaskToKeys(value)
  )

  useEffect(() => {
    setKeys(conversationTypeMaskToKeys(value))
  }, [value])

  const currentMask = conversationTypeKeysToMask(keys, value)
  const hasChanges = currentMask !== value

  const toggleKey = (key: ConversationTypeKey) => {
    setKeys((current) => {
      const exists = current.includes(key)
      if (exists && current.length === 1) {
        return current
      }
      return exists ? current.filter((item) => item !== key) : [...current, key]
    })
  }

  return (
    <div className="rounded-2xl border border-border bg-card p-5">
      <div className="flex flex-col gap-1">
        <div className="text-base font-semibold text-foreground">{label}</div>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        {conversationTypePresets.map((preset) => (
          <Button
            key={`${label}-${preset.label}`}
            type="button"
            variant={currentMask === preset.value ? "default" : "outline"}
            size="sm"
            onClick={() => setKeys(conversationTypeMaskToKeys(preset.value))}
          >
            {preset.label}
          </Button>
        ))}
      </div>

      <div className="mt-4 grid gap-3">
        {conversationTypeOptions.map((option) => (
          <label
            key={`${label}-${option.key}`}
            className="flex items-start gap-3 rounded-2xl border border-border bg-muted/20 px-4 py-3"
          >
            <Checkbox
              checked={keys.includes(option.key)}
              onCheckedChange={() => toggleKey(option.key)}
            />
            <div className="space-y-1">
              <div className="text-sm font-medium text-foreground">
                {option.label}
              </div>
              <div className="text-sm text-muted-foreground">
                {option.description}
              </div>
            </div>
          </label>
        ))}
      </div>

      <div className="mt-4 rounded-2xl border border-border bg-muted/20 p-4">
        <div className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Current default
        </div>
        <div className="mt-2 text-sm font-medium text-foreground">
          {currentMask}
        </div>
        <div className="mt-1 text-sm text-muted-foreground">
          {formatConversationTypeKeys(keys)}
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="outline"
          onClick={() => setKeys(conversationTypeMaskToKeys(value))}
          disabled={saving}
        >
          Reset
        </Button>
        <Button
          type="button"
          onClick={() => void onSave(currentMask)}
          disabled={!hasChanges || saving}
        >
          {saving ? "Saving..." : "Save default"}
        </Button>
      </div>
    </div>
  )
}

export default function AccessManagement({
  mode = "all",
  showIntro = true,
}: {
  mode?: "workspace" | "platform" | "all"
  showIntro?: boolean
}) {
  const { workspaceId, workspaceName } = useWorkspace()
  const [members, setMembers] = useState<WorkspaceMemberRecord[]>([])
  const [workspaceAccessBindings, setWorkspaceAccessBindings] = useState<
    WorkspaceAccessBinding[]
  >([])
  const [platformAccessBindings, setPlatformAccessBindings] = useState<
    PlatformAccessBinding[]
  >([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [workspaceError, setWorkspaceError] = useState<string | null>(null)
  const [platformError, setPlatformError] = useState<string | null>(null)
  const [workspacePolicyError, setWorkspacePolicyError] = useState<
    string | null
  >(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [
    workspaceConversationTypePolicies,
    setWorkspaceConversationTypePolicies,
  ] = useState<Record<
    CapabilityConversationTypePolicyResourceFamily,
    number
  > | null>(null)
  const [workspaceAccessTargetMemberId, setWorkspaceAccessTargetMemberId] =
    useState("")
  const [workspaceAccessKey, setWorkspaceAccessKey] =
    useState<WorkspaceAccessKey>("model_admin")
  const [platformSuggestionUserId, setPlatformSuggestionUserId] = useState("")
  const [platformTargetUserId, setPlatformTargetUserId] = useState("")
  const [platformAccessKey, setPlatformAccessKey] =
    useState<PlatformAccessKey>("workspace_admin")
  const [assigningWorkspaceAccess, setAssigningWorkspaceAccess] =
    useState(false)
  const [assigningPlatformAccess, setAssigningPlatformAccess] = useState(false)
  const [revokingWorkspaceKey, setRevokingWorkspaceKey] = useState<
    string | null
  >(null)
  const [revokingPlatformKey, setRevokingPlatformKey] = useState<string | null>(
    null
  )
  const [savingWorkspacePolicyFamily, setSavingWorkspacePolicyFamily] =
    useState<CapabilityConversationTypePolicyResourceFamily | null>(null)

  const loadWorkspaceData = useCallback(
    async (targetWorkspaceId: string) => {
      const [memberResponse, accessResponse] = await Promise.all([
        api.getWorkspaceMembers(targetWorkspaceId),
        api.getWorkspaceAccess(targetWorkspaceId),
      ])

      const nextMembers = memberResponse?.data ?? []
      const nextAccessBindings = accessResponse?.data ?? []

      setMembers(nextMembers)
      setWorkspaceAccessBindings(nextAccessBindings)
      setWorkspaceError(null)

      if (
        !workspaceAccessTargetMemberId ||
        !nextMembers.some(
          (member: WorkspaceMemberRecord) =>
            member.id === workspaceAccessTargetMemberId
        )
      ) {
        setWorkspaceAccessTargetMemberId(nextMembers[0]?.id ?? "")
      }

      if (!platformTargetUserId && nextMembers[0]?.userId) {
        setPlatformSuggestionUserId(nextMembers[0].userId)
        setPlatformTargetUserId(nextMembers[0].userId)
      } else if (
        platformSuggestionUserId &&
        !nextMembers.some(
          (member: WorkspaceMemberRecord) =>
            member.userId === platformSuggestionUserId
        )
      ) {
        setPlatformSuggestionUserId(nextMembers[0]?.userId ?? "")
      }
    },
    [
      platformSuggestionUserId,
      platformTargetUserId,
      workspaceAccessTargetMemberId,
    ]
  )

  const loadWorkspaceConversationTypePolicies = useCallback(
    async (targetWorkspaceId: string) => {
      const response =
        await api.getWorkspaceCapabilityConversationTypePolicies(
          targetWorkspaceId
        )
      const nextPolicies = Object.fromEntries(
        response.policies.map((policy) => [
          policy.resourceFamily,
          policy.defaultConversationTypeMask,
        ])
      ) as Record<CapabilityConversationTypePolicyResourceFamily, number>

      setWorkspaceConversationTypePolicies(nextPolicies)
      setWorkspacePolicyError(null)
    },
    []
  )

  const loadPlatformData = useCallback(async () => {
    const response = await api.getPlatformAccess()
    setPlatformAccessBindings(response?.data ?? [])
    setPlatformError(null)
  }, [])

  const refreshData = useCallback(
    async (options?: { silent?: boolean }) => {
      if (!workspaceId) {
        setLoading(false)
        setRefreshing(false)
        return
      }

      if (options?.silent) {
        setRefreshing(true)
      } else {
        setLoading(true)
      }

      setActionError(null)

      try {
        await loadWorkspaceData(workspaceId)
      } catch (error) {
        setMembers([])
        setWorkspaceAccessBindings([])
        setWorkspaceError(
          getErrorMessage(error, "Failed to load workspace access data.")
        )
      }

      try {
        await loadWorkspaceConversationTypePolicies(workspaceId)
      } catch (error) {
        setWorkspaceConversationTypePolicies(null)
        setWorkspacePolicyError(
          getErrorMessage(
            error,
            "Capability conversation type defaults are unavailable for your account."
          )
        )
      }

      try {
        await loadPlatformData()
      } catch (error) {
        setPlatformAccessBindings([])
        setPlatformError(
          getErrorMessage(
            error,
            "Platform access is unavailable for your account."
          )
        )
      } finally {
        setLoading(false)
        setRefreshing(false)
      }
    },
    [
      loadPlatformData,
      loadWorkspaceConversationTypePolicies,
      loadWorkspaceData,
      workspaceId,
    ]
  )

  useEffect(() => {
    void refreshData()
  }, [refreshData])

  const handleGrantWorkspaceAccess = async () => {
    if (!workspaceId || !workspaceAccessTargetMemberId) return
    setAssigningWorkspaceAccess(true)
    setActionError(null)
    try {
      await api.grantWorkspaceAccess(workspaceId, {
        workspaceMemberId: workspaceAccessTargetMemberId,
        accessKey: workspaceAccessKey,
      })
      await loadWorkspaceData(workspaceId)
    } catch (error) {
      setActionError(
        getErrorMessage(error, "Failed to grant workspace access.")
      )
    } finally {
      setAssigningWorkspaceAccess(false)
    }
  }

  const handleRevokeWorkspaceAccess = async (
    workspaceMemberId: string,
    accessKey: WorkspaceAccessKey
  ) => {
    if (!workspaceId) return
    const key = `${workspaceMemberId}:${accessKey}`
    setRevokingWorkspaceKey(key)
    setActionError(null)
    try {
      await api.revokeWorkspaceAccess(workspaceId, workspaceMemberId, accessKey)
      await loadWorkspaceData(workspaceId)
    } catch (error) {
      setActionError(
        getErrorMessage(error, "Failed to remove workspace access.")
      )
    } finally {
      setRevokingWorkspaceKey(null)
    }
  }

  const handleGrantPlatformAccess = async () => {
    const normalizedUserId = platformTargetUserId.trim()
    if (!normalizedUserId) return
    setAssigningPlatformAccess(true)
    setActionError(null)
    try {
      await api.grantPlatformAccess({
        userId: normalizedUserId,
        accessKey: platformAccessKey,
      })
      await loadPlatformData()
    } catch (error) {
      setActionError(getErrorMessage(error, "Failed to grant platform access."))
    } finally {
      setAssigningPlatformAccess(false)
    }
  }

  const handleRevokePlatformAccess = async (
    userId: string,
    accessKey: PlatformAccessKey
  ) => {
    const key = `${userId}:${accessKey}`
    setRevokingPlatformKey(key)
    setActionError(null)
    try {
      await api.revokePlatformAccess(userId, accessKey)
      await loadPlatformData()
    } catch (error) {
      setActionError(
        getErrorMessage(error, "Failed to remove platform access.")
      )
    } finally {
      setRevokingPlatformKey(null)
    }
  }

  const handleSaveWorkspaceConversationTypePolicy = async (
    family: CapabilityConversationTypePolicyResourceFamily,
    mask: number
  ) => {
    if (!workspaceId) return

    setSavingWorkspacePolicyFamily(family)
    setActionError(null)
    try {
      const response =
        await api.updateWorkspaceCapabilityConversationTypePolicies(
          workspaceId,
          { policies: { [family]: mask } }
        )
      const nextPolicies = Object.fromEntries(
        response.policies.map((policy) => [
          policy.resourceFamily,
          policy.defaultConversationTypeMask,
        ])
      ) as Record<CapabilityConversationTypePolicyResourceFamily, number>
      setWorkspaceConversationTypePolicies(nextPolicies)
      setWorkspacePolicyError(null)
    } catch (error) {
      setActionError(
        getErrorMessage(
          error,
          "Failed to update workspace capability conversation types."
        )
      )
    } finally {
      setSavingWorkspacePolicyFamily(null)
    }
  }

  if (!workspaceId) {
    return (
      <div className="rounded-2xl border border-dashed border-border px-4 py-10 text-sm text-muted-foreground">
        Select a workspace before managing access.
      </div>
    )
  }

  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    )
  }

  return (
    <div
      className={cn(
        "mx-auto flex w-full flex-col gap-6 pt-4 pb-6 md:pt-6",
        mode === "all" ? "max-w-6xl" : "max-w-4xl"
      )}
    >
      {showIntro ? (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold text-foreground">
              {mode === "workspace"
                ? "Workspace Access"
                : mode === "platform"
                  ? "Platform Access"
                  : "Access"}
            </h1>
            {mode !== "platform" && workspaceName ? (
              <Badge variant="secondary">{workspaceName}</Badge>
            ) : null}
          </div>
          <p className="text-sm text-muted-foreground">
            {mode === "workspace"
              ? "Review base membership and grant extra workspace-specific access only where needed."
              : mode === "platform"
                ? "Manage rare, global platform administration access."
                : "Review base membership, workspace access bundles, and platform administration from one place."}
          </p>
        </div>
      ) : null}

      {actionError ? (
        <div className="rounded-2xl border border-destructive/20 bg-destructive/5 px-4 py-4 text-sm text-destructive">
          {actionError}
        </div>
      ) : null}

      {mode === "all" ? (
        <section className="grid gap-3 md:grid-cols-3">
          <div className="rounded-2xl border border-border bg-card px-4 py-4">
            <div className="flex items-center gap-2 text-sm font-medium text-foreground">
              <UserRound className="h-4 w-4" />
              Base Access
            </div>
            <div className="mt-3 text-2xl font-semibold text-foreground">
              {members.length}
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              Workspace members with standard membership access.
            </p>
          </div>
          <div className="rounded-2xl border border-border bg-card px-4 py-4">
            <div className="flex items-center gap-2 text-sm font-medium text-foreground">
              <Building2 className="h-4 w-4" />
              Workspace Extras
            </div>
            <div className="mt-3 text-2xl font-semibold text-foreground">
              {workspaceAccessBindings.length}
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              Extra workspace access bundles granted on top of membership.
            </p>
          </div>
          <div className="rounded-2xl border border-border bg-card px-4 py-4">
            <div className="flex items-center gap-2 text-sm font-medium text-foreground">
              <ShieldCheck className="h-4 w-4" />
              Platform Admin
            </div>
            <div className="mt-3 text-2xl font-semibold text-foreground">
              {platformAccessBindings.length}
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              Global access that applies beyond a single workspace.
            </p>
          </div>
        </section>
      ) : null}

      <div
        className={`grid gap-6 ${mode === "all" ? "xl:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]" : ""}`}
      >
        {mode !== "platform" ? (
          <section className="flex flex-col gap-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2 text-lg font-semibold text-foreground">
                  <Building2 className="h-4 w-4" />
                  Workspace Access
                </div>
                <p className="text-sm text-muted-foreground">
                  Membership is the base layer. Use these extra access bundles
                  only when someone needs more than base membership.
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void refreshData({ silent: true })}
              >
                <RefreshCw
                  className={cn("h-4 w-4", refreshing ? "animate-spin" : "")}
                />
                Refresh
              </Button>
            </div>

            <div className="flex flex-col gap-6">
              {workspaceError ? (
                <div className="rounded-2xl border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
                  {workspaceError}
                </div>
              ) : (
                <>
                  <div className="flex flex-col gap-4">
                    <div className="flex flex-col gap-2">
                      <div className="flex items-center gap-2 text-base font-semibold text-foreground">
                        <Zap className="h-4 w-4" />
                        Capability Conversation Types
                      </div>
                      <p className="text-sm text-muted-foreground">
                        These workspace defaults are the top-level parent for
                        plugin installations, installed skills, and device
                        exposures. Instance overrides and grant overrides can
                        only narrow them.
                      </p>
                    </div>

                    {workspacePolicyError ? (
                      <div className="rounded-2xl border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
                        {workspacePolicyError}
                      </div>
                    ) : workspaceConversationTypePolicies ? (
                      <div className="grid gap-4 xl:grid-cols-3">
                        {workspaceCapabilityPolicyFamilies.map((policy) => (
                          <WorkspaceConversationTypePolicyCard
                            key={policy.family}
                            label={policy.label}
                            description={policy.description}
                            value={
                              workspaceConversationTypePolicies[policy.family]
                            }
                            saving={
                              savingWorkspacePolicyFamily === policy.family
                            }
                            onSave={(mask) =>
                              handleSaveWorkspaceConversationTypePolicy(
                                policy.family,
                                mask
                              )
                            }
                          />
                        ))}
                      </div>
                    ) : null}
                  </div>

                  <Separator />

                  <div className="grid gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_auto]">
                    <div className="flex flex-col gap-2">
                      <Label htmlFor="workspace-access-member">Person</Label>
                      <Select
                        value={workspaceAccessTargetMemberId}
                        onValueChange={setWorkspaceAccessTargetMemberId}
                      >
                        <SelectTrigger
                          id="workspace-access-member"
                          className="w-full"
                        >
                          <SelectValue placeholder="Select a member" />
                        </SelectTrigger>
                        <SelectContent>
                          {members.map((member) => (
                            <SelectItem key={member.id} value={member.id}>
                              {member.userName ||
                                member.userEmail ||
                                member.userId}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="flex flex-col gap-2">
                      <Label htmlFor="workspace-access-key">Extra access</Label>
                      <Select
                        value={workspaceAccessKey}
                        onValueChange={(value) =>
                          setWorkspaceAccessKey(value as WorkspaceAccessKey)
                        }
                      >
                        <SelectTrigger
                          id="workspace-access-key"
                          className="w-full"
                        >
                          <SelectValue placeholder="Select an access bundle" />
                        </SelectTrigger>
                        <SelectContent>
                          {workspaceAccessOptions.map((option) => (
                            <SelectItem key={option.value} value={option.value}>
                              {option.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-muted-foreground">
                        {
                          workspaceAccessOptions.find(
                            (option) => option.value === workspaceAccessKey
                          )?.description
                        }
                      </p>
                    </div>

                    <div className="flex items-end">
                      <Button
                        className="w-full lg:w-auto"
                        onClick={handleGrantWorkspaceAccess}
                        disabled={
                          assigningWorkspaceAccess ||
                          !workspaceAccessTargetMemberId
                        }
                      >
                        <Zap className="h-4 w-4" />
                        {assigningWorkspaceAccess
                          ? "Granting..."
                          : "Grant access"}
                      </Button>
                    </div>
                  </div>

                  <Separator />

                  <div className="rounded-2xl border border-border">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>User</TableHead>
                          <TableHead>Base Access</TableHead>
                          <TableHead>Extra Access</TableHead>
                          <TableHead>Granted</TableHead>
                          <TableHead className="text-right">Action</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {workspaceAccessBindings.length === 0 ? (
                          <TableRow>
                            <TableCell
                              colSpan={5}
                              className="py-10 text-center text-sm text-muted-foreground"
                            >
                              No extra workspace access has been granted.
                            </TableCell>
                          </TableRow>
                        ) : (
                          workspaceAccessBindings.map((assignment) => {
                            const key = `${assignment.workspaceMemberId}:${assignment.accessKey}`
                            return (
                              <TableRow key={key}>
                                <TableCell className="max-w-0">
                                  <UserIdentity
                                    name={assignment.userName}
                                    email={assignment.userEmail}
                                    userId={assignment.userId}
                                  />
                                </TableCell>
                                <TableCell>
                                  <Badge variant="outline">
                                    {titleize(assignment.trustLevel)}
                                  </Badge>
                                </TableCell>
                                <TableCell>
                                  <Badge>
                                    {titleize(assignment.accessKey)}
                                  </Badge>
                                </TableCell>
                                <TableCell className="text-sm text-muted-foreground">
                                  {formatTimestamp(assignment.createdAt)}
                                </TableCell>
                                <TableCell className="text-right">
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() =>
                                      void handleRevokeWorkspaceAccess(
                                        assignment.workspaceMemberId,
                                        assignment.accessKey
                                      )
                                    }
                                    disabled={revokingWorkspaceKey === key}
                                  >
                                    {revokingWorkspaceKey === key
                                      ? "Removing..."
                                      : "Remove"}
                                  </Button>
                                </TableCell>
                              </TableRow>
                            )
                          })
                        )}
                      </TableBody>
                    </Table>
                  </div>
                </>
              )}
            </div>
          </section>
        ) : null}

        {mode !== "workspace" ? (
          <section className="flex flex-col gap-6">
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2 text-lg font-semibold text-foreground">
                <ShieldCheck className="h-4 w-4" />
                Platform Access
              </div>
              <p className="text-sm text-muted-foreground">
                Rare global administration. Most people should not need
                platform-level access.
              </p>
            </div>

            <div className="flex flex-col gap-6">
              {platformError ? (
                <div className="rounded-2xl border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
                  {platformError}
                </div>
              ) : (
                <>
                  <div className="flex flex-col gap-4">
                    <div className="flex flex-col gap-2">
                      <Label htmlFor="platform-access-member">
                        Workspace member shortcut
                      </Label>
                      <Select
                        value={platformSuggestionUserId}
                        onValueChange={(value) => {
                          setPlatformSuggestionUserId(value)
                          setPlatformTargetUserId(value)
                        }}
                      >
                        <SelectTrigger
                          id="platform-access-member"
                          className="w-full"
                        >
                          <SelectValue placeholder="Pick a workspace member" />
                        </SelectTrigger>
                        <SelectContent>
                          {members.map((member) => (
                            <SelectItem
                              key={member.userId}
                              value={member.userId}
                            >
                              {member.userName ||
                                member.userEmail ||
                                member.userId}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="flex flex-col gap-2">
                      <Label htmlFor="platform-access-user-id">
                        Target user
                      </Label>
                      <Input
                        id="platform-access-user-id"
                        value={platformTargetUserId}
                        onChange={(event) =>
                          setPlatformTargetUserId(event.target.value)
                        }
                        placeholder="Paste a user UUID"
                      />
                    </div>

                    <div className="flex flex-col gap-2">
                      <Label htmlFor="platform-access-key">
                        Platform access
                      </Label>
                      <Select
                        value={platformAccessKey}
                        onValueChange={(value) =>
                          setPlatformAccessKey(value as PlatformAccessKey)
                        }
                      >
                        <SelectTrigger
                          id="platform-access-key"
                          className="w-full"
                        >
                          <SelectValue placeholder="Select a platform access bundle" />
                        </SelectTrigger>
                        <SelectContent>
                          {platformAccessOptions.map((option) => (
                            <SelectItem key={option.value} value={option.value}>
                              {option.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-muted-foreground">
                        {
                          platformAccessOptions.find(
                            (option) => option.value === platformAccessKey
                          )?.description
                        }
                      </p>
                    </div>

                    <Button
                      onClick={handleGrantPlatformAccess}
                      disabled={
                        assigningPlatformAccess ||
                        platformTargetUserId.trim().length === 0
                      }
                    >
                      <ShieldCheck className="h-4 w-4" />
                      {assigningPlatformAccess
                        ? "Granting..."
                        : "Grant platform access"}
                    </Button>
                  </div>

                  <Separator />

                  <div className="rounded-2xl border border-border">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>User</TableHead>
                          <TableHead>Access</TableHead>
                          <TableHead>Source</TableHead>
                          <TableHead className="text-right">Action</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {platformAccessBindings.length === 0 ? (
                          <TableRow>
                            <TableCell
                              colSpan={4}
                              className="py-10 text-center text-sm text-muted-foreground"
                            >
                              No platform access has been granted.
                            </TableCell>
                          </TableRow>
                        ) : (
                          platformAccessBindings.map((assignment) => {
                            const key = `${assignment.userId}:${assignment.accessKey}`
                            const managedByConfig =
                              assignment.source === "config"
                            return (
                              <TableRow key={key}>
                                <TableCell className="max-w-0">
                                  <UserIdentity
                                    name={assignment.userName}
                                    email={assignment.userEmail}
                                    userId={assignment.userId}
                                  />
                                </TableCell>
                                <TableCell>
                                  <Badge>
                                    {titleize(assignment.accessKey)}
                                  </Badge>
                                </TableCell>
                                <TableCell>
                                  <Badge variant="outline">
                                    {managedByConfig
                                      ? "Managed by config"
                                      : titleize(assignment.source)}
                                  </Badge>
                                </TableCell>
                                <TableCell className="text-right">
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() =>
                                      void handleRevokePlatformAccess(
                                        assignment.userId,
                                        assignment.accessKey
                                      )
                                    }
                                    disabled={
                                      managedByConfig ||
                                      revokingPlatformKey === key
                                    }
                                  >
                                    {managedByConfig
                                      ? "Config managed"
                                      : revokingPlatformKey === key
                                        ? "Removing..."
                                        : "Remove"}
                                  </Button>
                                </TableCell>
                              </TableRow>
                            )
                          })
                        )}
                      </TableBody>
                    </Table>
                  </div>
                </>
              )}
            </div>
          </section>
        ) : null}
      </div>

      {mode !== "platform" ? (
        <section className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2 text-lg font-semibold text-foreground">
              <UserRound className="h-4 w-4" />
              People In This Workspace
            </div>
            <p className="text-sm text-muted-foreground">
              Base membership is the default. Extra access appears only when it
              has been granted.
            </p>
          </div>

          <div>
            <div className="rounded-2xl border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>User</TableHead>
                    <TableHead>Base Access</TableHead>
                    <TableHead>Extra Access</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {members.length === 0 ? (
                    <TableRow>
                      <TableCell
                        colSpan={3}
                        className="py-10 text-center text-sm text-muted-foreground"
                      >
                        No workspace members found.
                      </TableCell>
                    </TableRow>
                  ) : (
                    members.map((member) => (
                      <TableRow key={member.id}>
                        <TableCell className="max-w-0">
                          <UserIdentity
                            name={member.userName}
                            email={member.userEmail}
                            userId={member.userId}
                          />
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline">
                            {titleize(member.trustLevel)}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-2">
                            {(member.accessKeys || []).length > 0 ? (
                              (member.accessKeys || []).map((accessKey) => (
                                <Badge key={accessKey} variant="secondary">
                                  {titleize(accessKey)}
                                </Badge>
                              ))
                            ) : (
                              <span className="text-sm text-muted-foreground">
                                Base access only
                              </span>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </div>
        </section>
      ) : null}
    </div>
  )
}
