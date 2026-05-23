"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import type {
  CapabilityAccessTarget,
  CapabilityAccessTargetType,
  ConversationTypeKey,
} from "@synapse/shared/types"
import {
  CONVERSATION_TYPE_MASK_PRESETS,
  maskAllowsConversationType,
  conversationTypeKeysToMask,
  conversationTypeMaskToKeys,
  normalizeConversationTypeMask,
} from "@synapse/shared"
import {
  Bot,
  Loader2,
  Plus,
  RotateCcw,
  Save,
  ShieldCheck,
  Trash2,
  UserRound,
} from "lucide-react"
import { getConversationDisplayName } from "@/app/dashboard/access/attachment-visuals"
import { Badge } from "@/components/ui/badge"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
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
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { useWorkspace } from "@/app/dashboard/workspace-provider"
import { api } from "@/lib/api"
import type { ConversationCatalogEntry } from "@synapse/shared"

type PluginGrantScope = CapabilityAccessTargetType

const allowedGrantScopes: PluginGrantScope[] = [
  "workspace",
  "conversation",
  "actor",
  "actor_in_conversation",
]

function buildGrantScopeOptions(resourceLabel: string): Array<{
  value: PluginGrantScope
  label: string
  description: string
}> {
  return [
    {
      value: "workspace",
      label: "Workspace",
      description: `Anyone in this workspace can use this ${resourceLabel}.`,
    },
    {
      value: "conversation",
      label: "Conversation",
      description: `Only one conversation can use this ${resourceLabel}, across every workspace participating in it.`,
    },
    {
      value: "actor",
      label: "Actor",
      description: `Only one actor can use this ${resourceLabel} anywhere it appears.`,
    },
    {
      value: "actor_in_conversation",
      label: "Actor in Conversation",
      description: `Only one actor can use this ${resourceLabel} inside one conversation.`,
    },
  ]
}

const PREVIEW_PRIMARY_USER = "Maya"
const PREVIEW_SECONDARY_USER = "Iris"
const PREVIEW_PRIMARY_ACTOR = "Nova"
const PREVIEW_SECONDARY_ACTOR = "Atlas"
const PREVIEW_CONVERSATION = "Project Sync"

type ActorOption = {
  id: string
  name: string
}

type ConversationOption = {
  id: string
  name: string
  title?: string
  kind: "group" | "private" | "virtual"
  boundary: "internal" | "external"
  conversationTypeKey: ConversationTypeKey | null
  participants: Array<{
    participantId: string
    participantType:
      | "actor"
      | "remote_agent"
      | "workspace_member"
      | "external"
      | "system"
    actorId?: string
    remoteAgentId?: string
    workspaceMemberId?: string
    name: string
    state: "active" | "left" | "removed"
  }>
}

type SelectOption = {
  id: string
  label: string
  disabled?: boolean
}

type AccessPreviewScenario = {
  title: string
  subtitle: string
  identities: Array<{ label: string; kind: "user" | "actor"; active: boolean }>
  userMessage: string
  actorName: string
  actorMessage: string
  secondaryActorName: string
  secondaryActorMessage: string
  secondaryActorActive: boolean
  footer: string
}

type AccessAdapter = {
  loadAccess: (
    workspaceId: string,
    resourceId: string
  ) => Promise<ResourceAccessState>
  grantAccess: (
    workspaceId: string,
    resourceId: string,
    payload: {
      accessTarget?: CapabilityAccessTarget
      conversationTypeMaskOverride?: number | null
      permissions?: string[]
    }
  ) => Promise<unknown>
  revokeAccess: (
    workspaceId: string,
    resourceId: string,
    grantId: string
  ) => Promise<unknown>
  updateGrant?: (
    workspaceId: string,
    resourceId: string,
    grantId: string,
    payload: {
      conversationTypeMaskOverride?: number | null
    }
  ) => Promise<unknown>
  updatePolicy?: (
    workspaceId: string,
    resourceId: string,
    payload: {
      conversationTypeMaskOverride?: number | null
    }
  ) => Promise<unknown>
}

type ResourceAccessSummary = {
  sourceDefaultConversationTypeMask?: number
  workspaceConversationTypeMask?: number
  conversationTypeMaskOverride?: number | null
  effectiveConversationTypeMask?: number
  parentPolicyLabel?: string | null
  parentConversationTypeMask?: number
  requiredPermissions?: string[]
  suggestedAccessTargetType?: PluginGrantScope
}

type ResourceAccessGrant = {
  id: string
  target?: CapabilityAccessTarget
  conversationTypeMaskOverride?: number | null
  effectiveConversationTypeMask?: number
  createdAt?: string
  grantedAt?: string
}

type ResourceAccessState = {
  summary?: ResourceAccessSummary | null
  grants?: ResourceAccessGrant[]
}

type ActorRecord = {
  id: string
  definition?: {
    name?: string
    title?: string
  }
  name?: string
  title?: string
}

type ResourceAccessOwner = {
  id?: string | null
}

const pluginInstallationAccessAdapter: AccessAdapter = {
  loadAccess: (workspaceId, resourceId) =>
    api.getPluginInstallationAccess(workspaceId, resourceId),
  grantAccess: (workspaceId, resourceId, payload) =>
    api.grantPluginInstallationAccess(workspaceId, resourceId, payload),
  revokeAccess: (workspaceId, resourceId, grantId) =>
    api.revokePluginInstallationAccess(workspaceId, resourceId, grantId),
  updateGrant: (workspaceId, resourceId, grantId, payload) =>
    api.updatePluginInstallationAccessGrant(
      workspaceId,
      resourceId,
      grantId,
      payload
    ),
  updatePolicy: (workspaceId, resourceId, payload) =>
    api.updateInstallation(workspaceId, resourceId, payload),
}

const conversationTypeOptions: Array<{
  key: ConversationTypeKey
  label: string
  description: string
}> = [
  {
    key: "internal_private",
    label: "Internal private",
    description: "Private conversations inside the workspace graph.",
  },
  {
    key: "internal_group",
    label: "Internal group",
    description: "Workspace-local group conversations.",
  },
  {
    key: "external_private",
    label: "External private",
    description: "Cross-workspace private conversations.",
  },
  {
    key: "external_group",
    label: "External group",
    description: "Cross-workspace group conversations.",
  },
  {
    key: "virtual",
    label: "Virtual",
    description: "Virtual or synthetic conversations.",
  },
]

const conversationTypePresets = [
  { label: "All", value: CONVERSATION_TYPE_MASK_PRESETS.ALL },
  {
    label: "Internal only",
    value: CONVERSATION_TYPE_MASK_PRESETS.INTERNAL_ONLY,
  },
  {
    label: "External only",
    value: CONVERSATION_TYPE_MASK_PRESETS.EXTERNAL_ONLY,
  },
  { label: "Group only", value: CONVERSATION_TYPE_MASK_PRESETS.GROUP_ONLY },
  { label: "Private only", value: CONVERSATION_TYPE_MASK_PRESETS.PRIVATE_ONLY },
] as const

function formatConversationTypeKeys(keys: ConversationTypeKey[]) {
  return keys
    .map(
      (key) =>
        conversationTypeOptions.find((option) => option.key === key)?.label ||
        key
    )
    .join(", ")
}

function normalizeActorOption(actor: ActorRecord): ActorOption {
  const definition = actor?.definition || actor
  return {
    id: actor.id,
    name: definition.name || definition.title || "Untitled actor",
  }
}

function normalizeConversationOption(
  group: ConversationCatalogEntry
): ConversationOption {
  return {
    id: group.id,
    name: group.title || "Untitled conversation",
    title: group.title,
    kind: group.kind,
    boundary: group.boundary,
    conversationTypeKey: group.conversationTypeKey,
    participants: group.participants,
  }
}

function TargetSelect({
  value,
  onChange,
  placeholder,
  options,
  disabled = false,
}: {
  value: string
  onChange: (value: string) => void
  placeholder: string
  options: SelectOption[]
  disabled?: boolean
}) {
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      disabled={disabled}
      className="block h-10 w-full rounded-xl border border-input bg-input/30 px-3 py-2 text-sm text-foreground transition-colors outline-none focus:border-ring focus:ring-[3px] focus:ring-ring/50"
    >
      <option value="">{placeholder}</option>
      {options.map((option) => (
        <option key={option.id} value={option.id} disabled={option.disabled}>
          {option.label}
        </option>
      ))}
    </select>
  )
}

function getScopeLabel(scope: PluginGrantScope) {
  switch (scope) {
    case "workspace":
      return "Workspace"
    case "conversation":
      return "Conversation"
    case "actor":
      return "Actor"
    case "actor_in_conversation":
      return "Actor in Conversation"
    default:
      return scope
  }
}

function formatGrantTarget(
  grant: ResourceAccessGrant,
  actorsById: Map<string, string>,
  conversationsById: Map<string, string>
) {
  const target = grant.target
  switch (target?.type) {
    case "workspace":
      return "Entire workspace"
    case "conversation":
      return (
        (target.conversationId
          ? conversationsById.get(target.conversationId)
          : null) ||
        (target.conversationId
          ? `Conversation ${String(target.conversationId).slice(0, 8)}`
          : "Selected conversation")
      )
    case "actor":
      return (
        (target.actorId ? actorsById.get(target.actorId) : null) ||
        (target.actorId
          ? `Actor ${String(target.actorId).slice(0, 8)}`
          : "Selected actor")
      )
    case "actor_in_conversation": {
      const actorName =
        (target.actorId ? actorsById.get(target.actorId) : null) ||
        (target.actorId
          ? `Actor ${String(target.actorId).slice(0, 8)}`
          : "Selected actor")
      const conversationName =
        (target.conversationId
          ? conversationsById.get(target.conversationId)
          : null) ||
        (target.conversationId
          ? `Conversation ${String(target.conversationId).slice(0, 8)}`
          : "Selected conversation")
      return `${actorName} in ${conversationName}`
    }
    default:
      return "Selected target"
  }
}

function formatPolicyLabel(label?: string | null) {
  const normalized = (label || "workspace").trim()
  if (!normalized) return "Workspace"
  return normalized.charAt(0).toUpperCase() + normalized.slice(1)
}

function narrowPresetConversationTypeKeys(
  parentConversationTypeMask: number,
  presetConversationTypeMask: number
) {
  const allowedKeys = new Set(
    conversationTypeMaskToKeys(parentConversationTypeMask)
  )
  const narrowedKeys = conversationTypeMaskToKeys(
    presetConversationTypeMask
  ).filter((key) => allowedKeys.has(key))
  if (narrowedKeys.length > 0) {
    return narrowedKeys
  }
  return conversationTypeMaskToKeys(parentConversationTypeMask)
}

function formatTimestamp(value?: string | null) {
  if (!value) return "Just now"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "Just now"
  return date.toLocaleString()
}

function formatConversationTypeLabel(key: ConversationTypeKey | null) {
  if (!key) return "Unknown type"
  return (
    conversationTypeOptions.find((option) => option.key === key)?.label || key
  )
}

function supportsGrantConversationTypeOverride(scope: PluginGrantScope) {
  return scope === "workspace" || scope === "actor"
}

function IdentityPill({
  label,
  kind,
  active,
}: {
  label: string
  kind: "user" | "actor"
  active: boolean
}) {
  const Icon = kind === "user" ? UserRound : Bot

  return (
    <div className="inline-flex items-center gap-2 rounded-full border border-border bg-background px-3 py-1 text-xs text-foreground">
      <span className="inline-flex size-5 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Icon className="size-3" />
      </span>
      <span className="truncate">{label}</span>
      <span
        className={
          active
            ? "rounded-full bg-emerald-500/12 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-300"
            : "rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
        }
      >
        {active ? "Can use" : "Blocked"}
      </span>
    </div>
  )
}

function AccessPreviewCard({
  scenario,
  selectedTarget,
}: {
  scenario: AccessPreviewScenario
  selectedTarget: string
}) {
  return (
    <div className="overflow-hidden rounded-[26px] border border-border bg-background shadow-sm">
      <div className="border-b border-border bg-muted/30 px-4 py-4">
        <div className="flex flex-col gap-1">
          <div className="text-sm font-semibold text-foreground">
            {scenario.title}
          </div>
          <div className="text-xs text-muted-foreground">
            {scenario.subtitle}
          </div>
          <div className="text-xs text-muted-foreground">
            Selected target: {selectedTarget}
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {scenario.identities.map((identity) => (
            <IdentityPill
              key={`${identity.kind}-${identity.label}-${identity.active ? "on" : "off"}`}
              label={identity.label}
              kind={identity.kind}
              active={identity.active}
            />
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-3 p-4">
        <div className="flex justify-end">
          <div className="max-w-[80%] rounded-2xl rounded-tr-sm bg-foreground px-3 py-2 text-sm text-background">
            {scenario.userMessage}
          </div>
        </div>
        <div className="flex items-start gap-3">
          <div className="mt-1 inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-emerald-500/12 text-xs font-semibold text-emerald-700 dark:text-emerald-300">
            {scenario.actorName.slice(0, 1).toUpperCase()}
          </div>
          <div className="min-w-0">
            <div className="mb-1 text-xs font-medium text-muted-foreground">
              {scenario.actorName}
            </div>
            <div className="rounded-2xl rounded-tl-sm border border-border bg-muted/20 px-3 py-2 text-sm text-foreground">
              {scenario.actorMessage}
            </div>
          </div>
        </div>
        <div className="flex items-start gap-3">
          <div
            className={
              scenario.secondaryActorActive
                ? "mt-1 inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-emerald-500/12 text-xs font-semibold text-emerald-700 dark:text-emerald-300"
                : "mt-1 inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold text-muted-foreground"
            }
          >
            {scenario.secondaryActorName.slice(0, 1).toUpperCase()}
          </div>
          <div className="min-w-0">
            <div className="mb-1 text-xs font-medium text-muted-foreground">
              {scenario.secondaryActorName}
            </div>
            <div
              className={
                scenario.secondaryActorActive
                  ? "rounded-2xl rounded-tl-sm border border-border bg-muted/20 px-3 py-2 text-sm text-foreground"
                  : "rounded-2xl rounded-tl-sm border border-dashed border-border bg-muted/10 px-3 py-2 text-sm text-muted-foreground"
              }
            >
              {scenario.secondaryActorMessage}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export default function ResourceAccessStep({
  installation,
  resourceId,
  accessAdapter = pluginInstallationAccessAdapter,
  resourceLabel = "installation",
  title = "Resource Access",
  description,
  addAccessLabel = "Add Resource Access",
  emptyMessage,
  dialogTitle = "Add resource access",
  dialogDescription,
  noAccessMessage = "No resource access has been granted yet.",
}: {
  installation: ResourceAccessOwner | null
  resourceId?: string | null
  accessAdapter?: AccessAdapter
  resourceLabel?: string
  title?: string
  description?: string
  addAccessLabel?: string
  emptyMessage?: string
  dialogTitle?: string
  dialogDescription?: string
  noAccessMessage?: string
}) {
  const { workspaceId } = useWorkspace()
  const [actors, setActors] = useState<ActorRecord[]>([])
  const [conversations, setConversations] = useState<
    ConversationCatalogEntry[]
  >([])
  const [summary, setSummary] = useState<ResourceAccessSummary | null>(null)
  const [grants, setGrants] = useState<ResourceAccessGrant[]>([])
  const [loading, setLoading] = useState(false)
  const [loadingActors, setLoadingActors] = useState(false)
  const [loadingConversations, setLoadingConversations] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savingPolicy, setSavingPolicy] = useState(false)
  const [savingGrantPolicy, setSavingGrantPolicy] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [grantPolicyDialogOpen, setGrantPolicyDialogOpen] = useState(false)
  const [editingGrant, setEditingGrant] = useState<ResourceAccessGrant | null>(
    null
  )
  const [grantScope, setGrantScope] = useState<PluginGrantScope>("workspace")
  const [conversationId, setConversationId] = useState("")
  const [actorId, setActorId] = useState("")
  const [actorsLoaded, setActorsLoaded] = useState(false)
  const [conversationsLoaded, setConversationsLoaded] = useState(false)
  const [actorsError, setActorsError] = useState<string | null>(null)
  const [conversationsError, setConversationsError] = useState<string | null>(
    null
  )
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [policyError, setPolicyError] = useState<string | null>(null)
  const [grantPolicyError, setGrantPolicyError] = useState<string | null>(null)
  const [conversationTypeKeys, setConversationTypeKeys] = useState<
    ConversationTypeKey[]
  >(conversationTypeMaskToKeys(CONVERSATION_TYPE_MASK_PRESETS.ALL))
  const [newGrantConversationTypeKeys, setNewGrantConversationTypeKeys] =
    useState<ConversationTypeKey[]>(
      conversationTypeMaskToKeys(CONVERSATION_TYPE_MASK_PRESETS.ALL)
    )
  const [grantConversationTypeKeys, setGrantConversationTypeKeys] = useState<
    ConversationTypeKey[]
  >(conversationTypeMaskToKeys(CONVERSATION_TYPE_MASK_PRESETS.ALL))

  const resolvedResourceId = resourceId || installation?.id || null
  const resourceLabelLower = resourceLabel.toLowerCase()
  const resolvedDescription =
    description ||
    `Choose who can use this ${resourceLabelLower}. Ownership and lifecycle stay in Advanced.`
  const resolvedEmptyMessage =
    emptyMessage ||
    `Finish setup first. Once the ${resourceLabelLower} exists, you can grant use access here.`
  const resolvedDialogDescription =
    dialogDescription ||
    `Choose who can use this ${resourceLabelLower}. Ownership stays where it is.`

  const grantScopeOptions = useMemo(
    () => buildGrantScopeOptions(resourceLabelLower),
    [resourceLabelLower]
  )
  const allActorOptions = useMemo(
    () => actors.map(normalizeActorOption),
    [actors]
  )
  const allConversationOptions = useMemo(
    () => conversations.map(normalizeConversationOption),
    [conversations]
  )
  const conversationsById = useMemo(
    () =>
      new Map(
        allConversationOptions.map(
          (conversation) => [conversation.id, conversation] as const
        )
      ),
    [allConversationOptions]
  )

  const actorNamesById = useMemo(
    () =>
      new Map([
        ...allActorOptions.map((actor) => [actor.id, actor.name] as const),
        ...allConversationOptions.flatMap((conversation) =>
          conversation.participants
            .filter(
              (participant) =>
                participant.participantType === "actor" &&
                participant.actorId &&
                participant.name
            )
            .map(
              (participant) => [participant.actorId!, participant.name] as const
            )
        ),
      ]),
    [allActorOptions, allConversationOptions]
  )
  const conversationNamesById = useMemo(
    () =>
      new Map(
        allConversationOptions.map((conversation) => [
          conversation.id,
          getConversationDisplayName(conversation),
        ])
      ),
    [allConversationOptions]
  )

  const selectedScopeOption = useMemo(
    () =>
      grantScopeOptions.find((option) => option.value === grantScope) ||
      grantScopeOptions[0],
    [grantScope, grantScopeOptions]
  )
  const sourceDefaultConversationTypeMask = useMemo(
    () =>
      normalizeConversationTypeMask(summary?.sourceDefaultConversationTypeMask),
    [summary?.sourceDefaultConversationTypeMask]
  )
  const workspaceConversationTypeMask = useMemo(
    () => normalizeConversationTypeMask(summary?.workspaceConversationTypeMask),
    [summary?.workspaceConversationTypeMask]
  )
  const effectiveConversationTypeMask = useMemo(
    () =>
      normalizeConversationTypeMask(
        summary?.effectiveConversationTypeMask,
        workspaceConversationTypeMask
      ),
    [summary?.effectiveConversationTypeMask, workspaceConversationTypeMask]
  )
  const parentPolicyLabel = useMemo(
    () => String(summary?.parentPolicyLabel || "workspace"),
    [summary?.parentPolicyLabel]
  )
  const parentConversationTypeMask = useMemo(
    () =>
      normalizeConversationTypeMask(
        summary?.parentConversationTypeMask,
        workspaceConversationTypeMask
      ),
    [summary?.parentConversationTypeMask, workspaceConversationTypeMask]
  )
  const currentConversationTypeMask = useMemo(
    () =>
      conversationTypeKeysToMask(
        conversationTypeKeys,
        effectiveConversationTypeMask
      ),
    [conversationTypeKeys, effectiveConversationTypeMask]
  )
  const selectedConversationTypeLabels = useMemo(
    () => formatConversationTypeKeys(conversationTypeKeys),
    [conversationTypeKeys]
  )
  const parentAllowedConversationTypeKeys = useMemo(
    () => new Set(conversationTypeMaskToKeys(parentConversationTypeMask)),
    [parentConversationTypeMask]
  )
  const canManageConversationTypes = Boolean(
    accessAdapter.updatePolicy &&
    typeof summary?.effectiveConversationTypeMask === "number"
  )
  const nextConversationTypeMaskOverride = useMemo(
    () =>
      currentConversationTypeMask === parentConversationTypeMask
        ? null
        : currentConversationTypeMask,
    [currentConversationTypeMask, parentConversationTypeMask]
  )
  const hasConversationTypeChanges =
    canManageConversationTypes &&
    currentConversationTypeMask !== effectiveConversationTypeMask
  const canManageGrantConversationTypes = Boolean(accessAdapter.updateGrant)
  const currentGrantBaseMask = useMemo(
    () =>
      normalizeConversationTypeMask(
        summary?.effectiveConversationTypeMask,
        CONVERSATION_TYPE_MASK_PRESETS.ALL
      ),
    [summary?.effectiveConversationTypeMask]
  )
  const instanceAllowedConversationTypeKeys = useMemo(
    () => new Set(conversationTypeMaskToKeys(currentGrantBaseMask)),
    [currentGrantBaseMask]
  )
  const currentNewGrantConversationTypeMask = useMemo(
    () =>
      conversationTypeKeysToMask(
        newGrantConversationTypeKeys,
        currentGrantBaseMask
      ),
    [currentGrantBaseMask, newGrantConversationTypeKeys]
  )
  const nextNewGrantConversationTypeMaskOverride = useMemo(
    () =>
      currentNewGrantConversationTypeMask === currentGrantBaseMask
        ? null
        : currentNewGrantConversationTypeMask,
    [currentGrantBaseMask, currentNewGrantConversationTypeMask]
  )
  const selectedNewGrantConversationTypeLabels = useMemo(
    () => formatConversationTypeKeys(newGrantConversationTypeKeys),
    [newGrantConversationTypeKeys]
  )
  const currentGrantConversationTypeMask = useMemo(
    () =>
      conversationTypeKeysToMask(
        grantConversationTypeKeys,
        currentGrantBaseMask
      ),
    [currentGrantBaseMask, grantConversationTypeKeys]
  )
  const nextGrantConversationTypeMaskOverride = useMemo(
    () =>
      currentGrantConversationTypeMask === currentGrantBaseMask
        ? null
        : currentGrantConversationTypeMask,
    [currentGrantBaseMask, currentGrantConversationTypeMask]
  )
  const hasGrantConversationTypeChanges = Boolean(
    editingGrant &&
    nextGrantConversationTypeMaskOverride !==
      (editingGrant?.conversationTypeMaskOverride ?? null)
  )
  const selectedConversation = useMemo(
    () =>
      conversationId ? conversationsById.get(conversationId) || null : null,
    [conversationId, conversationsById]
  )
  const selectedConversationAllowed = useMemo(
    () =>
      selectedConversation
        ? maskAllowsConversationType(
            currentGrantBaseMask,
            selectedConversation.kind,
            selectedConversation.boundary
          )
        : false,
    [currentGrantBaseMask, selectedConversation]
  )
  const selectedConversationLabel = useMemo(
    () =>
      selectedConversation
        ? getConversationDisplayName(selectedConversation)
        : null,
    [selectedConversation]
  )
  const conversationOptions = useMemo<SelectOption[]>(
    () =>
      allConversationOptions.map((conversation) => {
        const conversationLabel = getConversationDisplayName(conversation)
        const typeLabel = formatConversationTypeLabel(
          conversation.conversationTypeKey
        )
        const allowed = maskAllowsConversationType(
          currentGrantBaseMask,
          conversation.kind,
          conversation.boundary
        )
        return {
          id: conversation.id,
          label: allowed
            ? `${conversationLabel} · ${typeLabel}`
            : `${conversationLabel} · ${typeLabel} · blocked by instance policy`,
          disabled: !allowed,
        }
      }),
    [allConversationOptions, currentGrantBaseMask]
  )
  const actorInConversationOptions = useMemo<ActorOption[]>(() => {
    if (!selectedConversation || !selectedConversationAllowed) {
      return []
    }

    const seenActorIds = new Set<string>()
    return selectedConversation.participants
      .filter(
        (participant) =>
          participant.participantType === "actor" &&
          participant.actorId &&
          participant.state === "active"
      )
      .map((participant) =>
        participant.actorId
          ? {
              id: participant.actorId,
              name: participant.name,
            }
          : null
      )
      .filter((participant): participant is ActorOption => {
        if (!participant) return false
        if (seenActorIds.has(participant.id)) return false
        seenActorIds.add(participant.id)
        return true
      })
  }, [selectedConversation, selectedConversationAllowed])
  const actorOptions = useMemo(
    () =>
      grantScope === "actor_in_conversation"
        ? actorInConversationOptions
        : allActorOptions,
    [actorInConversationOptions, allActorOptions, grantScope]
  )
  const canGrantConversationTypesForScope =
    supportsGrantConversationTypeOverride(grantScope)
  const selectedConversationBlockedReason = useMemo(() => {
    if (!selectedConversation || selectedConversationAllowed) {
      return null
    }
    return `${selectedConversationLabel || "Selected conversation"} is ${formatConversationTypeLabel(selectedConversation.conversationTypeKey)} and is blocked by the current instance policy.`
  }, [
    selectedConversation,
    selectedConversationAllowed,
    selectedConversationLabel,
  ])
  const hasConversationScopedGrants = useMemo(
    () =>
      grants.some((grant) => {
        const targetType = grant.target?.type
        return (
          targetType === "conversation" ||
          targetType === "actor_in_conversation"
        )
      }),
    [grants]
  )

  const previewTarget = useMemo(() => {
    if (grantScope === "workspace") {
      return "The entire workspace"
    }
    if (grantScope === "conversation") {
      return conversationId
        ? "The conversation you selected on the left"
        : "Choose a conversation on the left"
    }
    if (grantScope === "actor") {
      return actorId
        ? "The actor you selected on the left"
        : "Choose an actor on the left"
    }
    if (grantScope === "actor_in_conversation") {
      return actorId && conversationId
        ? "The actor + conversation pair you selected on the left"
        : "Choose one actor and one conversation on the left"
    }
    return getScopeLabel(grantScope)
  }, [actorId, conversationId, grantScope])

  const previewScenario = useMemo<AccessPreviewScenario>(() => {
    switch (grantScope) {
      case "workspace":
        return {
          title: "Workspace planning room",
          subtitle: "Shared with the whole workspace",
          identities: [
            { label: PREVIEW_PRIMARY_USER, kind: "user", active: true },
            { label: PREVIEW_SECONDARY_USER, kind: "user", active: true },
            { label: PREVIEW_PRIMARY_ACTOR, kind: "actor", active: true },
            { label: PREVIEW_SECONDARY_ACTOR, kind: "actor", active: true },
          ],
          userMessage: `${PREVIEW_PRIMARY_USER}: Can someone pull the latest roadmap notes for this workspace?`,
          actorName: PREVIEW_PRIMARY_ACTOR,
          actorMessage: `Yes. This ${resourceLabelLower} is shared with the workspace, so actors can use it from any workspace conversation.`,
          secondaryActorName: PREVIEW_SECONDARY_ACTOR,
          secondaryActorMessage: `I can use it too, because workspace access does not limit this ${resourceLabelLower} to one room or one actor.`,
          secondaryActorActive: true,
          footer: `Best when this ${resourceLabelLower} should feel like shared workspace infrastructure.`,
        }
      case "conversation":
        return {
          title: PREVIEW_CONVERSATION,
          subtitle: "Only this conversation can use it",
          identities: [
            { label: PREVIEW_PRIMARY_USER, kind: "user", active: true },
            { label: PREVIEW_SECONDARY_USER, kind: "user", active: true },
            { label: PREVIEW_PRIMARY_ACTOR, kind: "actor", active: true },
            { label: PREVIEW_SECONDARY_ACTOR, kind: "actor", active: true },
          ],
          userMessage: `${PREVIEW_PRIMARY_USER}: Use this ${resourceLabelLower} for the notes in this room only.`,
          actorName: PREVIEW_PRIMARY_ACTOR,
          actorMessage: `I can use it here because access is tied to this conversation. Other conversations still will not see this ${resourceLabelLower}.`,
          secondaryActorName: PREVIEW_SECONDARY_ACTOR,
          secondaryActorMessage: `I can use it too, but only inside this same conversation with this ${resourceLabelLower}.`,
          secondaryActorActive: true,
          footer: `Useful when one shared room needs this ${resourceLabelLower} and every participant in that conversation should be able to use it.`,
        }
      case "actor":
        return {
          title: `Any thread with ${PREVIEW_PRIMARY_ACTOR}`,
          subtitle: "Only this actor can use it",
          identities: [
            { label: PREVIEW_PRIMARY_USER, kind: "user", active: true },
            { label: PREVIEW_SECONDARY_USER, kind: "user", active: true },
            { label: PREVIEW_PRIMARY_ACTOR, kind: "actor", active: true },
            { label: PREVIEW_SECONDARY_ACTOR, kind: "actor", active: false },
          ],
          userMessage: `${PREVIEW_PRIMARY_USER}: @${PREVIEW_PRIMARY_ACTOR} check the vendor workspace with this install.`,
          actorName: PREVIEW_PRIMARY_ACTOR,
          actorMessage: `I can use this ${resourceLabelLower} anywhere I appear, but other actors in the same conversation still cannot.`,
          secondaryActorName: PREVIEW_SECONDARY_ACTOR,
          secondaryActorMessage: `I am in the same room, but I still cannot use this ${resourceLabelLower} because access belongs only to the selected actor.`,
          secondaryActorActive: false,
          footer: `Good when one actor owns this ${resourceLabelLower} across every conversation it joins.`,
        }
      case "actor_in_conversation":
        return {
          title: `${PREVIEW_PRIMARY_ACTOR} in ${PREVIEW_CONVERSATION}`,
          subtitle: "Only this actor in this conversation can use it",
          identities: [
            { label: PREVIEW_PRIMARY_USER, kind: "user", active: true },
            { label: PREVIEW_SECONDARY_USER, kind: "user", active: true },
            { label: PREVIEW_PRIMARY_ACTOR, kind: "actor", active: true },
            { label: PREVIEW_SECONDARY_ACTOR, kind: "actor", active: false },
          ],
          userMessage: `${PREVIEW_PRIMARY_USER}: @${PREVIEW_PRIMARY_ACTOR} use this install for this room's follow-up.`,
          actorName: PREVIEW_PRIMARY_ACTOR,
          actorMessage: `I can use this ${resourceLabelLower} here, but not in other conversations and not for other actors in this room.`,
          secondaryActorName: PREVIEW_SECONDARY_ACTOR,
          secondaryActorMessage: `I cannot use this ${resourceLabelLower} here, because this grant is restricted to one actor and one conversation together.`,
          secondaryActorActive: false,
          footer:
            "This is the narrowest option when both the actor and the room matter.",
        }
      default:
        return {
          title: previewTarget,
          subtitle: selectedScopeOption.description,
          identities: [
            { label: PREVIEW_PRIMARY_USER, kind: "user", active: true },
            { label: PREVIEW_SECONDARY_USER, kind: "user", active: false },
            { label: PREVIEW_PRIMARY_ACTOR, kind: "actor", active: true },
            { label: PREVIEW_SECONDARY_ACTOR, kind: "actor", active: false },
          ],
          userMessage: `${PREVIEW_PRIMARY_USER}: Use this ${resourceLabelLower} here.`,
          actorName: PREVIEW_PRIMARY_ACTOR,
          actorMessage: `${previewTarget} will be able to use this ${resourceLabelLower}.`,
          secondaryActorName: PREVIEW_SECONDARY_ACTOR,
          secondaryActorMessage:
            "This second actor is outside the selected grant target.",
          secondaryActorActive: false,
          footer: "This only grants use access.",
        }
    }
  }, [
    grantScope,
    previewTarget,
    resourceLabelLower,
    selectedScopeOption.description,
  ])

  const canCreateGrant = useMemo(() => {
    if (grantScope === "conversation") {
      return Boolean(
        conversationId && selectedConversationAllowed && !loadingConversations
      )
    }
    if (grantScope === "actor") {
      return Boolean(actorId && !loadingActors)
    }
    if (grantScope === "actor_in_conversation") {
      return Boolean(
        actorId &&
        conversationId &&
        selectedConversationAllowed &&
        !loadingConversations &&
        actorInConversationOptions.some((option) => option.id === actorId)
      )
    }
    return true
  }, [
    actorId,
    actorInConversationOptions,
    conversationId,
    grantScope,
    loadingActors,
    loadingConversations,
    selectedConversationAllowed,
  ])

  const loadAccessState = useCallback(async () => {
    if (!workspaceId || !resolvedResourceId) return
    const accessData = await accessAdapter.loadAccess(
      workspaceId,
      resolvedResourceId
    )
    setGrants(accessData.grants || [])
    setSummary(accessData.summary || null)
    setPolicyError(null)
    setGrantPolicyError(null)
    const suggestedGrantScope = accessData.summary
      ?.suggestedAccessTargetType as PluginGrantScope | undefined
    if (
      suggestedGrantScope &&
      allowedGrantScopes.includes(suggestedGrantScope)
    ) {
      setGrantScope(suggestedGrantScope)
    }
  }, [accessAdapter, resolvedResourceId, workspaceId])

  const ensureActorsLoaded = useCallback(async () => {
    if (!workspaceId) {
      return []
    }
    if (actorsLoaded) {
      return actors
    }
    if (loadingActors) {
      return actors
    }

    setLoadingActors(true)
    setActorsError(null)
    try {
      const actorData = await api.getActors(workspaceId)
      const nextActors = Array.isArray(actorData)
        ? actorData
        : actorData?.actors || []
      setActors(nextActors)
      setActorsLoaded(true)
      return nextActors
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to load actors."
      setActorsError(message)
      setActors([])
      throw error
    } finally {
      setLoadingActors(false)
    }
  }, [actors, actorsLoaded, loadingActors, workspaceId])

  const ensureConversationsLoaded = useCallback(async () => {
    if (!workspaceId) {
      return []
    }
    if (conversationsLoaded) {
      return conversations
    }
    if (loadingConversations) {
      return conversations
    }

    setLoadingConversations(true)
    setConversationsError(null)
    try {
      const nextConversations = await api.loadConversationCatalog(workspaceId)
      setConversations(nextConversations)
      setConversationsLoaded(true)
      return nextConversations
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to load conversations."
      setConversationsError(message)
      setConversations([])
      throw error
    } finally {
      setLoadingConversations(false)
    }
  }, [conversations, conversationsLoaded, loadingConversations, workspaceId])

  useEffect(() => {
    if (typeof summary?.effectiveConversationTypeMask !== "number") {
      return
    }
    setConversationTypeKeys(
      conversationTypeMaskToKeys(summary.effectiveConversationTypeMask)
    )
  }, [summary?.effectiveConversationTypeMask])

  useEffect(() => {
    setActors([])
    setConversations([])
    setActorsLoaded(false)
    setConversationsLoaded(false)
    setActorsError(null)
    setConversationsError(null)
  }, [workspaceId])

  useEffect(() => {
    if (!dialogOpen) {
      return
    }
    setNewGrantConversationTypeKeys(
      conversationTypeMaskToKeys(currentGrantBaseMask)
    )
  }, [currentGrantBaseMask, dialogOpen])

  useEffect(() => {
    if (!grantPolicyDialogOpen || !editingGrant) {
      return
    }
    setGrantConversationTypeKeys(
      conversationTypeMaskToKeys(
        normalizeConversationTypeMask(
          editingGrant.effectiveConversationTypeMask,
          currentGrantBaseMask
        )
      )
    )
  }, [currentGrantBaseMask, editingGrant, grantPolicyDialogOpen])

  useEffect(() => {
    if (!dialogOpen) {
      return
    }
    setSubmitError(null)
    if (grantScope === "actor") {
      void ensureActorsLoaded().catch(() => {})
      return
    }
    if (
      grantScope === "conversation" ||
      grantScope === "actor_in_conversation"
    ) {
      void ensureConversationsLoaded().catch(() => {})
    }
  }, [dialogOpen, ensureActorsLoaded, ensureConversationsLoaded, grantScope])

  useEffect(() => {
    if (grantScope !== "actor_in_conversation") {
      return
    }
    if (!actorId) {
      return
    }
    if (!actorInConversationOptions.some((option) => option.id === actorId)) {
      setActorId("")
    }
  }, [actorId, actorInConversationOptions, grantScope])

  useEffect(() => {
    if (!workspaceId || !resolvedResourceId) {
      setSummary(null)
      setGrants([])
      return
    }

    let cancelled = false

    const load = async () => {
      try {
        setLoading(true)
        await loadAccessState()
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [loadAccessState, resolvedResourceId, workspaceId])

  const resetDialogState = () => {
    setConversationId("")
    setActorId("")
    setSubmitError(null)
  }

  const validateConversationScopedGrants = async (nextMask: number) => {
    if (!hasConversationScopedGrants) {
      return null
    }

    const catalogEntries = conversationsLoaded
      ? conversations
      : await ensureConversationsLoaded()
    const catalogMap = new Map(
      catalogEntries.map((conversation) => [
        conversation.id,
        normalizeConversationOption(conversation),
      ])
    )
    const invalidTargets: string[] = []

    for (const grant of grants) {
      const target = grant.target
      if (
        target?.type !== "conversation" &&
        target?.type !== "actor_in_conversation"
      ) {
        continue
      }

      if (!target.conversationId) {
        invalidTargets.push("Unknown conversation target")
        continue
      }

      const catalogEntry = catalogMap.get(target.conversationId)
      if (!catalogEntry) {
        invalidTargets.push(
          `Conversation ${String(target.conversationId).slice(0, 8)}`
        )
        continue
      }

      const allowed = maskAllowsConversationType(
        nextMask,
        catalogEntry.kind,
        catalogEntry.boundary
      )
      if (!allowed) {
        invalidTargets.push(
          `${getConversationDisplayName(catalogEntry)} (${formatConversationTypeLabel(catalogEntry.conversationTypeKey)})`
        )
      }
    }

    if (invalidTargets.length === 0) {
      return null
    }

    const preview = invalidTargets.slice(0, 3).join(", ")
    const suffix =
      invalidTargets.length > 3 ? ` +${invalidTargets.length - 3} more` : ""
    return `This policy would invalidate existing conversation-scoped resource access: ${preview}${suffix}.`
  }

  const buildCreateGrantError = () => {
    if (grantScope === "actor" && !actorId) {
      return "Select an actor before creating resource access."
    }
    if (grantScope === "conversation") {
      if (!conversationId) {
        return "Select a conversation before creating resource access."
      }
      if (!selectedConversationAllowed) {
        return (
          selectedConversationBlockedReason ||
          "The selected conversation is blocked by the current instance policy."
        )
      }
    }
    if (grantScope === "actor_in_conversation") {
      if (!conversationId) {
        return "Select a conversation before choosing an actor."
      }
      if (!selectedConversationAllowed) {
        return (
          selectedConversationBlockedReason ||
          "The selected conversation is blocked by the current instance policy."
        )
      }
      if (!actorId) {
        return actorInConversationOptions.length === 0
          ? "This conversation has no active actor participants to grant."
          : "Select an actor from the chosen conversation."
      }
      if (!actorInConversationOptions.some((option) => option.id === actorId)) {
        return "Select an active actor from the chosen conversation."
      }
    }
    return null
  }

  const createGrant = async () => {
    if (!workspaceId || !resolvedResourceId) return
    const validationError = buildCreateGrantError()
    if (validationError) {
      setSubmitError(validationError)
      return
    }
    setSaving(true)
    setSubmitError(null)
    try {
      const payload: {
        accessTarget?: CapabilityAccessTarget
        conversationTypeMaskOverride?: number | null
        permissions?: string[]
      } = {
        accessTarget: {
          type: grantScope,
          actorId:
            grantScope === "actor" || grantScope === "actor_in_conversation"
              ? actorId
              : undefined,
          conversationId:
            grantScope === "conversation" ||
            grantScope === "actor_in_conversation"
              ? conversationId
              : undefined,
        },
        permissions: summary?.requiredPermissions?.length
          ? summary.requiredPermissions
          : ["use"],
      }
      if (canGrantConversationTypesForScope) {
        payload.conversationTypeMaskOverride =
          nextNewGrantConversationTypeMaskOverride
      }
      await accessAdapter.grantAccess(workspaceId, resolvedResourceId, payload)
      await loadAccessState()
      setDialogOpen(false)
      resetDialogState()
    } catch (error) {
      setSubmitError(
        error instanceof Error
          ? error.message
          : "Failed to create resource access."
      )
    } finally {
      setSaving(false)
    }
  }

  const revokeGrant = async (grantId: string) => {
    if (!workspaceId || !resolvedResourceId) return
    await accessAdapter.revokeAccess(workspaceId, resolvedResourceId, grantId)
    await loadAccessState()
  }

  const toggleConversationTypeKey = (key: ConversationTypeKey) => {
    if (!parentAllowedConversationTypeKeys.has(key)) {
      return
    }
    setConversationTypeKeys((current) => {
      const exists = current.includes(key)
      if (exists && current.length === 1) {
        return current
      }
      return exists ? current.filter((item) => item !== key) : [...current, key]
    })
  }

  const applyConversationTypePreset = (mask: number) => {
    setConversationTypeKeys(
      narrowPresetConversationTypeKeys(parentConversationTypeMask, mask)
    )
  }

  const resetConversationTypePolicy = () => {
    setConversationTypeKeys(
      conversationTypeMaskToKeys(parentConversationTypeMask)
    )
  }

  const saveConversationTypePolicy = async () => {
    if (
      !workspaceId ||
      !resolvedResourceId ||
      !accessAdapter.updatePolicy ||
      !hasConversationTypeChanges
    ) {
      return
    }

    setSavingPolicy(true)
    setPolicyError(null)
    try {
      const invalidGrantError = await validateConversationScopedGrants(
        currentConversationTypeMask
      )
      if (invalidGrantError) {
        setPolicyError(invalidGrantError)
        return
      }
      await accessAdapter.updatePolicy(workspaceId, resolvedResourceId, {
        conversationTypeMaskOverride: nextConversationTypeMaskOverride,
      })
      await loadAccessState()
    } catch (error) {
      setPolicyError(
        error instanceof Error
          ? error.message
          : "Failed to save conversation type policy."
      )
    } finally {
      setSavingPolicy(false)
    }
  }

  const toggleNewGrantConversationTypeKey = (key: ConversationTypeKey) => {
    if (!instanceAllowedConversationTypeKeys.has(key)) {
      return
    }
    setNewGrantConversationTypeKeys((current) => {
      const exists = current.includes(key)
      if (exists && current.length === 1) {
        return current
      }
      return exists ? current.filter((item) => item !== key) : [...current, key]
    })
  }

  const applyNewGrantConversationTypePreset = (mask: number) => {
    setNewGrantConversationTypeKeys(
      narrowPresetConversationTypeKeys(currentGrantBaseMask, mask)
    )
  }

  const resetNewGrantConversationTypePolicy = () => {
    setNewGrantConversationTypeKeys(
      conversationTypeMaskToKeys(currentGrantBaseMask)
    )
  }

  const openGrantConversationTypeDialog = (grant: ResourceAccessGrant) => {
    if (
      !supportsGrantConversationTypeOverride(grant.target?.type || "workspace")
    ) {
      return
    }
    setEditingGrant(grant)
    setGrantPolicyError(null)
    setGrantPolicyDialogOpen(true)
  }

  const toggleGrantConversationTypeKey = (key: ConversationTypeKey) => {
    if (!instanceAllowedConversationTypeKeys.has(key)) {
      return
    }
    setGrantConversationTypeKeys((current) => {
      const exists = current.includes(key)
      if (exists && current.length === 1) {
        return current
      }
      return exists ? current.filter((item) => item !== key) : [...current, key]
    })
  }

  const applyGrantConversationTypePreset = (mask: number) => {
    setGrantConversationTypeKeys(
      narrowPresetConversationTypeKeys(currentGrantBaseMask, mask)
    )
  }

  const resetGrantConversationTypePolicy = () => {
    setGrantConversationTypeKeys(
      conversationTypeMaskToKeys(
        normalizeConversationTypeMask(
          editingGrant?.effectiveConversationTypeMask,
          currentGrantBaseMask
        )
      )
    )
  }

  const followInstanceGrantConversationTypePolicy = () => {
    setGrantConversationTypeKeys(
      conversationTypeMaskToKeys(currentGrantBaseMask)
    )
  }

  const saveGrantConversationTypePolicy = async () => {
    if (
      !workspaceId ||
      !resolvedResourceId ||
      !editingGrant?.id ||
      !accessAdapter.updateGrant ||
      !hasGrantConversationTypeChanges
    ) {
      return
    }

    setSavingGrantPolicy(true)
    setGrantPolicyError(null)
    try {
      await accessAdapter.updateGrant(
        workspaceId,
        resolvedResourceId,
        editingGrant.id,
        {
          conversationTypeMaskOverride: nextGrantConversationTypeMaskOverride,
        }
      )
      await loadAccessState()
      setGrantPolicyDialogOpen(false)
      setEditingGrant(null)
    } catch (error) {
      setGrantPolicyError(
        error instanceof Error
          ? error.message
          : "Failed to save grant conversation policy."
      )
    } finally {
      setSavingGrantPolicy(false)
    }
  }

  const renderTargetSelector = () => {
    if (grantScope === "workspace") return null

    if (grantScope === "conversation") {
      return (
        <Field>
          <FieldLabel>Conversation</FieldLabel>
          <TargetSelect
            value={conversationId}
            onChange={setConversationId}
            placeholder="Select a conversation"
            options={conversationOptions}
            disabled={loadingConversations}
          />
          {loadingConversations ? (
            <FieldDescription>Loading conversations...</FieldDescription>
          ) : null}
          {conversationsError ? (
            <FieldDescription className="text-destructive">
              {conversationsError}
            </FieldDescription>
          ) : null}
          {!loadingConversations &&
          !conversationsError &&
          conversationOptions.length === 0 ? (
            <FieldDescription>
              No conversations are available yet.
            </FieldDescription>
          ) : null}
          {selectedConversationBlockedReason ? (
            <FieldDescription className="text-destructive">
              {selectedConversationBlockedReason}
            </FieldDescription>
          ) : null}
        </Field>
      )
    }

    if (grantScope === "actor") {
      return (
        <Field>
          <FieldLabel>Actor</FieldLabel>
          <TargetSelect
            value={actorId}
            onChange={setActorId}
            placeholder="Select an actor"
            options={actorOptions.map((actor) => ({
              id: actor.id,
              label: actor.name,
            }))}
            disabled={loadingActors}
          />
          {loadingActors ? (
            <FieldDescription>Loading actors...</FieldDescription>
          ) : null}
          {actorsError ? (
            <FieldDescription className="text-destructive">
              {actorsError}
            </FieldDescription>
          ) : null}
          {!loadingActors && !actorsError && actorOptions.length === 0 ? (
            <FieldDescription>
              No active actors are available yet.
            </FieldDescription>
          ) : null}
        </Field>
      )
    }

    if (grantScope === "actor_in_conversation") {
      return (
        <FieldGroup>
          <Field>
            <FieldLabel>Conversation</FieldLabel>
            <TargetSelect
              value={conversationId}
              onChange={setConversationId}
              placeholder="Select a conversation"
              options={conversationOptions}
              disabled={loadingConversations}
            />
            {loadingConversations ? (
              <FieldDescription>Loading conversations...</FieldDescription>
            ) : null}
            {conversationsError ? (
              <FieldDescription className="text-destructive">
                {conversationsError}
              </FieldDescription>
            ) : null}
            {selectedConversationBlockedReason ? (
              <FieldDescription className="text-destructive">
                {selectedConversationBlockedReason}
              </FieldDescription>
            ) : null}
          </Field>

          <Field>
            <FieldLabel>Actor</FieldLabel>
            <TargetSelect
              value={actorId}
              onChange={setActorId}
              placeholder="Select an actor"
              options={actorOptions.map((actor) => ({
                id: actor.id,
                label: actor.name,
              }))}
              disabled={!selectedConversationAllowed || loadingConversations}
            />
            {!conversationId ? (
              <FieldDescription>Select a conversation first.</FieldDescription>
            ) : null}
            {conversationId &&
            selectedConversationAllowed &&
            actorOptions.length === 0 ? (
              <FieldDescription>
                This conversation has no active actor participants.
              </FieldDescription>
            ) : null}
          </Field>
        </FieldGroup>
      )
    }

    return null
  }

  if (!resolvedResourceId) {
    return (
      <Card className="rounded-[28px]">
        <CardContent className="p-6 text-sm text-muted-foreground">
          {resolvedEmptyMessage}
        </CardContent>
      </Card>
    )
  }

  if (loading) {
    return (
      <Card className="rounded-[28px]">
        <CardContent className="p-6 text-sm text-muted-foreground">
          Loading access settings...
        </CardContent>
      </Card>
    )
  }

  return (
    <>
      {canManageConversationTypes ? (
        <Card className="rounded-[28px]">
          <CardHeader>
            <div className="flex items-center justify-between gap-3">
              <div className="space-y-1">
                <CardTitle>Conversation Types</CardTitle>
                <CardDescription>
                  Limit which conversation topologies can surface this{" "}
                  {resourceLabelLower}. Runtime visibility follows workspace
                  default, then the {parentPolicyLabel} policy, then this
                  instance override, then each matching grant.
                </CardDescription>
              </div>
              <Badge
                variant={
                  summary?.conversationTypeMaskOverride
                    ? "secondary"
                    : "outline"
                }
              >
                {summary?.conversationTypeMaskOverride
                  ? "Override active"
                  : `Follow ${parentPolicyLabel}`}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            <div className="flex flex-wrap gap-2">
              {conversationTypePresets.map((preset) => (
                <Button
                  key={preset.label}
                  type="button"
                  variant={
                    currentConversationTypeMask === preset.value
                      ? "default"
                      : "outline"
                  }
                  size="sm"
                  onClick={() => applyConversationTypePreset(preset.value)}
                >
                  {preset.label}
                </Button>
              ))}
            </div>

            <FieldGroup>
              {conversationTypeOptions.map((option) => (
                <Field key={option.key} orientation="horizontal">
                  <FieldContent>
                    <div className="flex items-start gap-3">
                      <Checkbox
                        checked={conversationTypeKeys.includes(option.key)}
                        disabled={
                          !parentAllowedConversationTypeKeys.has(option.key)
                        }
                        onCheckedChange={() =>
                          toggleConversationTypeKey(option.key)
                        }
                      />
                      <div className="space-y-1">
                        <FieldLabel>{option.label}</FieldLabel>
                        <FieldDescription>
                          {option.description}
                        </FieldDescription>
                      </div>
                    </div>
                  </FieldContent>
                </Field>
              ))}
            </FieldGroup>

            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
              <div className="rounded-2xl border border-border bg-muted/20 p-4">
                <div className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                  Source Default
                </div>
                <div className="mt-2 text-sm font-medium text-foreground">
                  {typeof summary?.sourceDefaultConversationTypeMask ===
                  "number"
                    ? sourceDefaultConversationTypeMask
                    : "None"}
                </div>
                <div className="mt-1 text-sm text-muted-foreground">
                  {typeof summary?.sourceDefaultConversationTypeMask ===
                  "number"
                    ? formatConversationTypeKeys(
                        conversationTypeMaskToKeys(
                          sourceDefaultConversationTypeMask
                        )
                      )
                    : "Used only to initialize new installs."}
                </div>
              </div>
              <div className="rounded-2xl border border-border bg-muted/20 p-4">
                <div className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                  Workspace
                </div>
                <div className="mt-2 text-sm font-medium text-foreground">
                  {workspaceConversationTypeMask}
                </div>
                <div className="mt-1 text-sm text-muted-foreground">
                  {formatConversationTypeKeys(
                    conversationTypeMaskToKeys(workspaceConversationTypeMask)
                  )}
                </div>
              </div>
              <div className="rounded-2xl border border-border bg-muted/20 p-4">
                <div className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                  Parent {formatPolicyLabel(parentPolicyLabel)}
                </div>
                <div className="mt-2 text-sm font-medium text-foreground">
                  {parentConversationTypeMask}
                </div>
                <div className="mt-1 text-sm text-muted-foreground">
                  {formatConversationTypeKeys(
                    conversationTypeMaskToKeys(parentConversationTypeMask)
                  )}
                </div>
              </div>
              <div className="rounded-2xl border border-border bg-muted/20 p-4">
                <div className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                  Effective Instance
                </div>
                <div className="mt-2 text-sm font-medium text-foreground">
                  {effectiveConversationTypeMask}
                </div>
                <div className="mt-1 text-sm text-muted-foreground">
                  {formatConversationTypeKeys(
                    conversationTypeMaskToKeys(effectiveConversationTypeMask)
                  )}
                </div>
              </div>
              <div className="rounded-2xl border border-border bg-muted/20 p-4">
                <div className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                  Draft
                </div>
                <div className="mt-2 text-sm font-medium text-foreground">
                  {currentConversationTypeMask}
                </div>
                <div className="mt-1 text-sm text-muted-foreground">
                  {selectedConversationTypeLabels}
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <Button
                type="button"
                variant="outline"
                onClick={resetConversationTypePolicy}
                disabled={savingPolicy}
              >
                <RotateCcw data-icon="inline-start" />
                Follow {parentPolicyLabel}
              </Button>
              <Button
                type="button"
                onClick={() => void saveConversationTypePolicy()}
                disabled={!hasConversationTypeChanges || savingPolicy}
              >
                {savingPolicy ? (
                  <Loader2 className="animate-spin" data-icon="inline-start" />
                ) : (
                  <Save data-icon="inline-start" />
                )}
                Save conversation types
              </Button>
              <div className="text-sm text-muted-foreground">
                Override payload:{" "}
                {nextConversationTypeMaskOverride ??
                  `follow ${parentPolicyLabel}`}
              </div>
            </div>
            {policyError ? (
              <div className="text-sm text-destructive">{policyError}</div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <Card className="rounded-[28px]">
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-muted-foreground" />
              <div className="space-y-1">
                <CardTitle>{title}</CardTitle>
                <CardDescription>{resolvedDescription}</CardDescription>
              </div>
            </div>
            <Button onClick={() => setDialogOpen(true)}>
              <Plus data-icon="inline-start" />
              {addAccessLabel}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="px-0 pb-2">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="px-6">Type</TableHead>
                <TableHead>Who Can Use It</TableHead>
                <TableHead>Conversation Types</TableHead>
                <TableHead>Added</TableHead>
                <TableHead className="w-[180px] px-6 text-right">
                  Action
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {grants.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={5}
                    className="px-6 py-8 text-sm text-muted-foreground"
                  >
                    {noAccessMessage}
                  </TableCell>
                </TableRow>
              ) : (
                grants.map((grant) => (
                  <TableRow key={grant.id}>
                    <TableCell className="px-6 font-medium">
                      {getScopeLabel(grant.target?.type || "workspace")}
                    </TableCell>
                    <TableCell className="max-w-0">
                      <div className="truncate">
                        {formatGrantTarget(
                          grant,
                          actorNamesById,
                          conversationNamesById
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="max-w-0">
                      {supportsGrantConversationTypeOverride(
                        grant.target?.type || "workspace"
                      ) ? (
                        <div className="space-y-1">
                          <div className="truncate">
                            {formatConversationTypeKeys(
                              conversationTypeMaskToKeys(
                                normalizeConversationTypeMask(
                                  grant.effectiveConversationTypeMask,
                                  effectiveConversationTypeMask
                                )
                              )
                            )}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {grant.conversationTypeMaskOverride
                              ? `Override ${grant.conversationTypeMaskOverride}`
                              : "Follow instance"}
                          </div>
                        </div>
                      ) : (
                        <div className="space-y-1">
                          <div className="truncate">
                            {grant.target?.conversationId &&
                            conversationsById.get(grant.target.conversationId)
                              ? formatConversationTypeLabel(
                                  conversationsById.get(
                                    grant.target.conversationId
                                  )?.conversationTypeKey || null
                                )
                              : "Selected conversation"}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            Fixed by the selected conversation
                          </div>
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatTimestamp(grant.createdAt || grant.grantedAt)}
                    </TableCell>
                    <TableCell className="px-6 text-right">
                      <div className="flex justify-end gap-2">
                        {canManageGrantConversationTypes &&
                        supportsGrantConversationTypeOverride(
                          grant.target?.type || "workspace"
                        ) ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                              openGrantConversationTypeDialog(grant)
                            }
                          >
                            Types
                          </Button>
                        ) : null}
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-muted-foreground hover:text-destructive"
                          onClick={() => revokeGrant(grant.id)}
                        >
                          <Trash2 />
                          <span className="sr-only">Remove access</span>
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open)
          if (!open) {
            resetDialogState()
          }
        }}
      >
        <DialogContent className="sm:max-w-5xl">
          <DialogHeader>
            <DialogTitle>{dialogTitle}</DialogTitle>
            <DialogDescription>{resolvedDialogDescription}</DialogDescription>
          </DialogHeader>

          <div className="grid gap-6 lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)]">
            <div className="flex flex-col gap-5">
              <RadioGroup
                value={grantScope}
                onValueChange={(value) => {
                  setGrantScope(value as PluginGrantScope)
                  setConversationId("")
                  setActorId("")
                  setSubmitError(null)
                }}
                className="w-full"
              >
                {grantScopeOptions.map((option) => (
                  <Field
                    key={option.value}
                    orientation="horizontal"
                    className="rounded-3xl border border-border p-4"
                  >
                    <RadioGroupItem
                      value={option.value}
                      id={`access-scope-${option.value}`}
                    />
                    <FieldContent>
                      <FieldLabel htmlFor={`access-scope-${option.value}`}>
                        {option.label}
                      </FieldLabel>
                      <FieldDescription>{option.description}</FieldDescription>
                    </FieldContent>
                  </Field>
                ))}
              </RadioGroup>

              {renderTargetSelector()}

              {canGrantConversationTypesForScope ? (
                <div className="rounded-3xl border border-border bg-muted/20 p-4">
                  <div className="flex flex-col gap-1">
                    <div className="text-sm font-medium text-foreground">
                      Grant conversation types
                    </div>
                    <div className="text-sm text-muted-foreground">
                      Leave this aligned with the instance to follow the
                      instance policy. A grant override can only narrow the
                      instance scope.
                    </div>
                  </div>

                  <div className="mt-4 flex flex-wrap gap-2">
                    {conversationTypePresets.map((preset) => (
                      <Button
                        key={preset.label}
                        type="button"
                        variant={
                          currentNewGrantConversationTypeMask === preset.value
                            ? "default"
                            : "outline"
                        }
                        size="sm"
                        onClick={() =>
                          applyNewGrantConversationTypePreset(preset.value)
                        }
                      >
                        {preset.label}
                      </Button>
                    ))}
                  </div>

                  <div className="mt-4 grid gap-3">
                    {conversationTypeOptions.map((option) => (
                      <Field
                        key={`new-grant-${option.key}`}
                        orientation="horizontal"
                      >
                        <FieldContent>
                          <div className="flex items-start gap-3">
                            <Checkbox
                              checked={newGrantConversationTypeKeys.includes(
                                option.key
                              )}
                              disabled={
                                !instanceAllowedConversationTypeKeys.has(
                                  option.key
                                )
                              }
                              onCheckedChange={() =>
                                toggleNewGrantConversationTypeKey(option.key)
                              }
                            />
                            <div className="space-y-1">
                              <FieldLabel>{option.label}</FieldLabel>
                              <FieldDescription>
                                {option.description}
                              </FieldDescription>
                            </div>
                          </div>
                        </FieldContent>
                      </Field>
                    ))}
                  </div>

                  <div className="mt-4 grid gap-3 md:grid-cols-2">
                    <div className="rounded-2xl border border-border bg-background p-4">
                      <div className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                        Instance Effective
                      </div>
                      <div className="mt-2 text-sm font-medium text-foreground">
                        {currentGrantBaseMask}
                      </div>
                      <div className="mt-1 text-sm text-muted-foreground">
                        {formatConversationTypeKeys(
                          conversationTypeMaskToKeys(currentGrantBaseMask)
                        )}
                      </div>
                    </div>
                    <div className="rounded-2xl border border-border bg-background p-4">
                      <div className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                        Grant Draft
                      </div>
                      <div className="mt-2 text-sm font-medium text-foreground">
                        {currentNewGrantConversationTypeMask}
                      </div>
                      <div className="mt-1 text-sm text-muted-foreground">
                        {selectedNewGrantConversationTypeLabels}
                      </div>
                    </div>
                  </div>

                  <div className="mt-4 flex flex-wrap items-center gap-3">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={resetNewGrantConversationTypePolicy}
                    >
                      <RotateCcw data-icon="inline-start" />
                      Follow instance
                    </Button>
                    <div className="text-sm text-muted-foreground">
                      Override payload:{" "}
                      {nextNewGrantConversationTypeMaskOverride ??
                        "follow instance"}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="rounded-3xl border border-border bg-muted/20 p-4 text-sm text-muted-foreground">
                  {grantScope === "conversation" ||
                  grantScope === "actor_in_conversation" ? (
                    <>
                      Grant conversation types are fixed by the selected
                      conversation. This grant follows the instance policy and
                      cannot narrow it further.
                      {selectedConversation ? (
                        <div className="mt-2 text-foreground">
                          Selected conversation type:{" "}
                          {formatConversationTypeLabel(
                            selectedConversation.conversationTypeKey
                          )}
                        </div>
                      ) : null}
                    </>
                  ) : (
                    "This grant follows the instance policy."
                  )}
                </div>
              )}
            </div>

            <div className="rounded-3xl border border-border bg-muted/20 p-5">
              <div className="flex flex-col gap-5">
                <div className="flex flex-col gap-1">
                  <h3 className="text-base font-medium">
                    {selectedScopeOption.label} preview
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    {selectedScopeOption.description}
                  </p>
                </div>

                <AccessPreviewCard
                  scenario={previewScenario}
                  selectedTarget={previewTarget}
                />

                <div className="rounded-2xl border border-dashed border-border p-4 text-sm text-muted-foreground">
                  {previewScenario.footer}
                </div>
              </div>
            </div>
          </div>

          <DialogFooter>
            {submitError ? (
              <div className="mr-auto text-sm text-destructive">
                {submitError}
              </div>
            ) : null}
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={createGrant} disabled={saving || !canCreateGrant}>
              {saving ? "Adding access..." : "Add Access"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={grantPolicyDialogOpen}
        onOpenChange={(open) => {
          setGrantPolicyDialogOpen(open)
          if (!open) {
            setEditingGrant(null)
          }
        }}
      >
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Grant Conversation Types</DialogTitle>
            <DialogDescription>
              This grant can only narrow the instance-level conversation types.
              Clearing the override makes it follow the instance again.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-5">
            <div className="rounded-2xl border border-border bg-muted/20 p-4">
              <div className="text-sm font-medium text-foreground">
                {editingGrant
                  ? formatGrantTarget(
                      editingGrant,
                      actorNamesById,
                      conversationNamesById
                    )
                  : "Selected grant"}
              </div>
              <div className="mt-1 text-sm text-muted-foreground">
                {editingGrant
                  ? getScopeLabel(editingGrant.target?.type || "workspace")
                  : "Grant"}
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              {conversationTypePresets.map((preset) => (
                <Button
                  key={`grant-preset-${preset.label}`}
                  type="button"
                  variant={
                    currentGrantConversationTypeMask === preset.value
                      ? "default"
                      : "outline"
                  }
                  size="sm"
                  onClick={() => applyGrantConversationTypePreset(preset.value)}
                >
                  {preset.label}
                </Button>
              ))}
            </div>

            <FieldGroup>
              {conversationTypeOptions.map((option) => (
                <Field key={`grant-${option.key}`} orientation="horizontal">
                  <FieldContent>
                    <div className="flex items-start gap-3">
                      <Checkbox
                        checked={grantConversationTypeKeys.includes(option.key)}
                        disabled={
                          !instanceAllowedConversationTypeKeys.has(option.key)
                        }
                        onCheckedChange={() =>
                          toggleGrantConversationTypeKey(option.key)
                        }
                      />
                      <div className="space-y-1">
                        <FieldLabel>{option.label}</FieldLabel>
                        <FieldDescription>
                          {option.description}
                        </FieldDescription>
                      </div>
                    </div>
                  </FieldContent>
                </Field>
              ))}
            </FieldGroup>

            <div className="grid gap-3 md:grid-cols-3">
              <div className="rounded-2xl border border-border bg-muted/20 p-4">
                <div className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                  Instance Effective
                </div>
                <div className="mt-2 text-sm font-medium text-foreground">
                  {currentGrantBaseMask}
                </div>
                <div className="mt-1 text-sm text-muted-foreground">
                  {formatConversationTypeKeys(
                    conversationTypeMaskToKeys(currentGrantBaseMask)
                  )}
                </div>
              </div>
              <div className="rounded-2xl border border-border bg-muted/20 p-4">
                <div className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                  Saved Effective
                </div>
                <div className="mt-2 text-sm font-medium text-foreground">
                  {normalizeConversationTypeMask(
                    editingGrant?.effectiveConversationTypeMask,
                    currentGrantBaseMask
                  )}
                </div>
                <div className="mt-1 text-sm text-muted-foreground">
                  {formatConversationTypeKeys(
                    conversationTypeMaskToKeys(
                      normalizeConversationTypeMask(
                        editingGrant?.effectiveConversationTypeMask,
                        currentGrantBaseMask
                      )
                    )
                  )}
                </div>
              </div>
              <div className="rounded-2xl border border-border bg-muted/20 p-4">
                <div className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                  Draft
                </div>
                <div className="mt-2 text-sm font-medium text-foreground">
                  {currentGrantConversationTypeMask}
                </div>
                <div className="mt-1 text-sm text-muted-foreground">
                  {formatConversationTypeKeys(grantConversationTypeKeys)}
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <Button
                type="button"
                variant="outline"
                onClick={followInstanceGrantConversationTypePolicy}
              >
                Follow instance
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={resetGrantConversationTypePolicy}
              >
                Reset to saved
              </Button>
              <div className="text-sm text-muted-foreground">
                Override payload:{" "}
                {nextGrantConversationTypeMaskOverride ?? "follow instance"}
              </div>
            </div>
            {grantPolicyError ? (
              <div className="text-sm text-destructive">{grantPolicyError}</div>
            ) : null}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setGrantPolicyDialogOpen(false)
                setEditingGrant(null)
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={() => void saveGrantConversationTypePolicy()}
              disabled={!hasGrantConversationTypeChanges || savingGrantPolicy}
            >
              {savingGrantPolicy ? (
                <Loader2 className="animate-spin" data-icon="inline-start" />
              ) : (
                <Save data-icon="inline-start" />
              )}
              Save grant conversation types
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
