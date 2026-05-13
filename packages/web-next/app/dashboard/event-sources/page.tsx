"use client"

import { useDeferredValue, useEffect, useMemo, useState } from "react"
import type {
  AutomationEventSource,
  AutomationIntegrationProvider,
  AutomationOccurrence,
} from "@synapse/shared"
import {
  Archive,
  BellRing,
  History,
  Plus,
  RefreshCw,
  Radio,
} from "lucide-react"
import { toast } from "sonner"

import { useWorkspace } from "@/app/dashboard/workspace-provider"
import {
  AppCard,
  AppCardContent,
  AppCardDescription,
  AppCardHeader,
  AppCardTitle,
} from "@/components/app-card"
import { Badge } from "@/components/ui/badge"
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
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Textarea } from "@/components/ui/textarea"
import { api } from "@/lib/api"
import {
  createIntegrationEventSources,
  listIntegrationEventDefinitionOptions,
  listIntegrationInstallations,
  type IntegrationInstallationView,
} from "@/lib/integration-event-sources"
import { cn } from "@/lib/utils"

type EventSourceStatus = AutomationEventSource["status"]
type EventSourceProvider = AutomationEventSource["providerKind"]
type EventSourceMode = "internal" | "webhook" | AutomationIntegrationProvider

type EventSourceFormState = {
  mode: EventSourceMode
  providerRef: string
  name: string
  description: string
  recommendedUsage: string
  payloadSchemaText: string
  examplePayloadText: string
  installationId: string
  targetId: string
  targetLabel: string
  selectedIntegrationSourceKeys: string[]
}

const EMPTY_FORM: EventSourceFormState = {
  mode: "internal",
  providerRef: "",
  name: "",
  description: "",
  recommendedUsage: "",
  payloadSchemaText: '{\n  "type": "object"\n}',
  examplePayloadText: "{}",
  installationId: "",
  targetId: "",
  targetLabel: "",
  selectedIntegrationSourceKeys: [],
}

function formatDateTime(value?: string) {
  if (!value) return "Never"
  return new Date(value).toLocaleString()
}

function eventSourceStatusVariant(status: EventSourceStatus) {
  switch (status) {
    case "active":
      return "secondary"
    case "deprecated":
      return "outline"
    case "disabled":
    case "archived":
      return "destructive"
    default:
      return "outline"
  }
}

function parseJsonRecord(input: string, label: string) {
  const trimmed = input.trim()
  if (!trimmed) return {}

  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${label} must be a JSON object`)
    }
    return parsed as Record<string, unknown>
  } catch (error) {
    const message = error instanceof Error ? error.message : `Invalid ${label}`
    throw new Error(message)
  }
}

function serializeJson(value: Record<string, unknown>) {
  return JSON.stringify(value || {}, null, 2)
}

function occurrenceSummary(occurrence: AutomationOccurrence) {
  if (occurrence.displaySummary?.trim()) {
    return occurrence.displaySummary
  }

  const payloadKeys = Object.keys(occurrence.payload || {})
  if (payloadKeys.length === 0) {
    return "No payload fields"
  }

  return payloadKeys.slice(0, 6).join(", ")
}

function occurrenceTitle(occurrence: AutomationOccurrence) {
  return (
    occurrence.displayTitle ||
    occurrence.eventSourceName ||
    occurrence.matchKey ||
    occurrence.sourceLocator ||
    occurrence.sourceKind
  )
}

function sourceModeLabel(mode: EventSourceMode) {
  switch (mode) {
    case "github":
      return "GitHub"
    case "gitlab":
      return "GitLab"
    case "webhook":
      return "Webhook"
    case "internal":
    default:
      return "Internal"
  }
}

function integrationProviderLabel(provider?: AutomationIntegrationProvider) {
  if (provider === "github") return "GitHub"
  if (provider === "gitlab") return "GitLab"
  return "Integration"
}

function sourceProviderLabel(source: AutomationEventSource) {
  if (source.providerKind === "integration") {
    return integrationProviderLabel(source.integration?.provider)
  }
  return source.providerKind
}

function sourceProviderDetail(source: AutomationEventSource) {
  if (source.providerKind === "integration" && source.integration) {
    return `${integrationProviderLabel(source.integration.provider)} / ${source.integration.targetLabel}`
  }
  if (source.providerRef) {
    return `${source.providerKind} / ${source.providerRef}`
  }
  return source.providerKind
}

export default function EventSourcesPage() {
  const { workspaceId, workspaceName } = useWorkspace()
  const [sources, setSources] = useState<AutomationEventSource[]>([])
  const [installations, setInstallations] = useState<
    IntegrationInstallationView[]
  >([])
  const [occurrences, setOccurrences] = useState<AutomationOccurrence[]>([])
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null)
  const [loadingSources, setLoadingSources] = useState(true)
  const [loadingOccurrences, setLoadingOccurrences] = useState(false)
  const [savingSource, setSavingSource] = useState(false)
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [search, setSearch] = useState("")
  const [statusFilter, setStatusFilter] = useState<"all" | EventSourceStatus>(
    "all"
  )
  const [providerFilter, setProviderFilter] = useState<
    "all" | EventSourceProvider
  >("all")
  const [formState, setFormState] = useState<EventSourceFormState>(EMPTY_FORM)
  const deferredSearch = useDeferredValue(search)
  const integrationProvider =
    formState.mode === "github" || formState.mode === "gitlab"
      ? formState.mode
      : null

  const availableIntegrationDefinitions = useMemo(
    () =>
      integrationProvider
        ? listIntegrationEventDefinitionOptions(integrationProvider)
        : [],
    [integrationProvider]
  )
  const availableIntegrationInstallations = useMemo(
    () =>
      integrationProvider
        ? listIntegrationInstallations(installations, integrationProvider)
        : [],
    [installations, integrationProvider]
  )

  async function loadSources() {
    if (!workspaceId) return

    setLoadingSources(true)
    try {
      const [nextSources, nextInstallations] = await Promise.all([
        api.getAutomationEventSources(workspaceId),
        api.getInstallations(workspaceId),
      ])
      setSources(nextSources)
      setInstallations(
        Array.isArray(nextInstallations) ? nextInstallations : []
      )
      setSelectedSourceId((currentId) => {
        if (
          currentId &&
          nextSources.some((source) => source.id === currentId)
        ) {
          return currentId
        }
        return nextSources[0]?.id || null
      })
    } catch (error) {
      console.error("Failed to load automation event sources:", error)
      toast.error(
        error instanceof Error ? error.message : "Failed to load event sources"
      )
    } finally {
      setLoadingSources(false)
    }
  }

  async function loadOccurrences(eventSourceId: string) {
    if (!workspaceId) return

    setLoadingOccurrences(true)
    try {
      const nextOccurrences = await api.getAutomationEventSourceOccurrences(
        workspaceId,
        eventSourceId
      )
      setOccurrences(nextOccurrences)
    } catch (error) {
      console.error("Failed to load automation event source history:", error)
      toast.error(
        error instanceof Error ? error.message : "Failed to load event history"
      )
      setOccurrences([])
    } finally {
      setLoadingOccurrences(false)
    }
  }

  useEffect(() => {
    void loadSources()
  }, [workspaceId])

  useEffect(() => {
    if (!selectedSourceId) {
      setOccurrences([])
      return
    }
    void loadOccurrences(selectedSourceId)
  }, [selectedSourceId, workspaceId])

  const filteredSources = useMemo(() => {
    const keyword = deferredSearch.trim().toLowerCase()

    return sources.filter((source) => {
      if (statusFilter !== "all" && source.status !== statusFilter) {
        return false
      }
      if (providerFilter !== "all" && source.providerKind !== providerFilter) {
        return false
      }
      if (!keyword) {
        return true
      }

      const haystack = [
        source.name,
        source.description,
        source.recommendedUsage || "",
        source.sourceKey,
        sourceProviderLabel(source),
        source.providerRef || "",
        source.integration?.targetLabel || "",
        source.integration?.targetId || "",
      ]
        .join(" ")
        .toLowerCase()
      return haystack.includes(keyword)
    })
  }, [deferredSearch, providerFilter, sources, statusFilter])

  const selectedSource = useMemo(
    () =>
      filteredSources.find((source) => source.id === selectedSourceId) ||
      sources.find((source) => source.id === selectedSourceId) ||
      null,
    [filteredSources, selectedSourceId, sources]
  )

  async function handleCreateSource() {
    if (!workspaceId) return

    if (integrationProvider) {
      if (!formState.installationId) {
        toast.error("Select an installed integration first")
        return
      }
      if (!formState.targetId.trim()) {
        toast.error(
          `Enter the ${integrationProvider === "github" ? "repository" : "project"} to watch`
        )
        return
      }
      if (formState.selectedIntegrationSourceKeys.length === 0) {
        toast.error("Select at least one event source")
        return
      }

      setSavingSource(true)
      try {
        await createIntegrationEventSources({
          workspaceId,
          installationId: formState.installationId,
          provider: integrationProvider,
          targetId: formState.targetId,
          targetLabel: formState.targetLabel,
          sourceKeys: formState.selectedIntegrationSourceKeys,
        })
        toast.success("Integration event sources saved")
        setCreateDialogOpen(false)
        setFormState(EMPTY_FORM)
        await loadSources()
      } catch (error) {
        console.error("Failed to create integration event sources:", error)
        toast.error(
          error instanceof Error
            ? error.message
            : "Failed to create integration event sources"
        )
      } finally {
        setSavingSource(false)
      }
      return
    }

    const name = formState.name.trim()
    const description = formState.description.trim()
    const recommendedUsage = formState.recommendedUsage.trim()
    const providerRef = formState.providerRef.trim()

    if (!name || !description) {
      toast.error("Name and description are required")
      return
    }

    if (formState.mode === "webhook" && !providerRef) {
      toast.error("This provider requires providerRef")
      return
    }

    setSavingSource(true)
    try {
      const manualProviderKind =
        formState.mode === "webhook" ? "webhook" : "internal"
      await api.createAutomationEventSource(workspaceId, {
        providerKind: manualProviderKind,
        providerRef: providerRef || undefined,
        name,
        description,
        recommendedUsage: recommendedUsage || undefined,
        payloadSchema: parseJsonRecord(
          formState.payloadSchemaText,
          "payload schema"
        ),
        examplePayload: parseJsonRecord(
          formState.examplePayloadText,
          "example payload"
        ),
      })
      toast.success("Event source saved")
      setCreateDialogOpen(false)
      setFormState(EMPTY_FORM)
      await loadSources()
    } catch (error) {
      console.error("Failed to create automation event source:", error)
      toast.error(
        error instanceof Error ? error.message : "Failed to create event source"
      )
    } finally {
      setSavingSource(false)
    }
  }

  async function handleUpdateStatus(
    source: AutomationEventSource,
    status: EventSourceStatus
  ) {
    if (!workspaceId || source.status === status) return

    setSavingSource(true)
    try {
      await api.updateAutomationEventSource(workspaceId, source.id, { status })
      toast.success(`Event source marked ${status}`)
      await loadSources()
      if (selectedSourceId === source.id) {
        await loadOccurrences(source.id)
      }
    } catch (error) {
      console.error("Failed to update event source:", error)
      toast.error(
        error instanceof Error ? error.message : "Failed to update event source"
      )
    } finally {
      setSavingSource(false)
    }
  }

  async function handleArchiveSource(source: AutomationEventSource) {
    if (!workspaceId) return
    if (
      !window.confirm(
        `Archive event source "${source.name}"? Existing subscriptions will be paused.`
      )
    ) {
      return
    }

    setSavingSource(true)
    try {
      await api.archiveAutomationEventSource(workspaceId, source.id)
      toast.success("Event source archived")
      await loadSources()
    } catch (error) {
      console.error("Failed to archive event source:", error)
      toast.error(
        error instanceof Error
          ? error.message
          : "Failed to archive event source"
      )
    } finally {
      setSavingSource(false)
    }
  }

  if (!workspaceId) {
    return (
      <div className="px-4 pt-6 pb-6 text-sm text-muted-foreground lg:px-6">
        Select a workspace to manage automation event sources.
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6 px-4 pt-6 pb-6 lg:px-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Event Sources
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Register durable event definitions for{" "}
            {workspaceName || "this workspace"}, inspect their lifecycle, and
            review every reported occurrence.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => void loadSources()}
            disabled={loadingSources}
          >
            <RefreshCw
              className={cn(loadingSources && "animate-spin")}
              data-icon="inline-start"
            />
            Refresh
          </Button>
          <Button type="button" onClick={() => setCreateDialogOpen(true)}>
            <Plus data-icon="inline-start" />
            Create Source
          </Button>
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-[340px_minmax(0,1fr)]">
        <AppCard variant="panel">
          <AppCardHeader className="gap-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <AppCardTitle>Registered Sources</AppCardTitle>
                <AppCardDescription>
                  Active, deprecated, disabled, and archived sources stay
                  discoverable for auditability.
                </AppCardDescription>
              </div>
              <Badge variant="outline">{sources.length}</Badge>
            </div>
            <div className="grid gap-3">
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search by name, key, provider..."
              />
              <div className="grid gap-3 sm:grid-cols-2">
                <Select
                  value={statusFilter}
                  onValueChange={(value) =>
                    setStatusFilter(value as "all" | EventSourceStatus)
                  }
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Status" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All statuses</SelectItem>
                    <SelectItem value="active">Active</SelectItem>
                    <SelectItem value="deprecated">Deprecated</SelectItem>
                    <SelectItem value="disabled">Disabled</SelectItem>
                    <SelectItem value="archived">Archived</SelectItem>
                  </SelectContent>
                </Select>
                <Select
                  value={providerFilter}
                  onValueChange={(value) =>
                    setProviderFilter(value as "all" | EventSourceProvider)
                  }
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Provider" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All providers</SelectItem>
                    <SelectItem value="integration">Integration</SelectItem>
                    <SelectItem value="internal">Internal</SelectItem>
                    <SelectItem value="webhook">Webhook</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </AppCardHeader>
          <AppCardContent className="flex flex-col gap-3">
            {loadingSources ? (
              <div className="rounded-[22px] border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
                Loading event sources...
              </div>
            ) : filteredSources.length === 0 ? (
              <div className="rounded-[22px] border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
                No event sources match the current filters.
              </div>
            ) : (
              filteredSources.map((source) => {
                const selected = source.id === selectedSourceId
                return (
                  <button
                    key={source.id}
                    type="button"
                    onClick={() => setSelectedSourceId(source.id)}
                    className={cn(
                      "rounded-[22px] border px-4 py-4 text-left transition-colors",
                      selected
                        ? "border-primary/30 bg-primary/5"
                        : "border-border/70 hover:bg-muted/50"
                    )}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <div className="text-sm font-medium text-foreground">
                            {source.name}
                          </div>
                          <Badge
                            variant={eventSourceStatusVariant(source.status)}
                          >
                            {source.status}
                          </Badge>
                          {source.providerKind === "integration" &&
                          source.integration ? (
                            <Badge variant="outline">
                              {integrationProviderLabel(
                                source.integration.provider
                              )}
                            </Badge>
                          ) : null}
                        </div>
                        <div className="mt-1 text-xs text-muted-foreground">
                          {sourceProviderDetail(source)} · {source.sourceKey}
                        </div>
                      </div>
                      <BellRing className="size-4 text-muted-foreground" />
                    </div>
                    <p className="mt-3 line-clamp-3 text-sm text-muted-foreground">
                      {source.description}
                    </p>
                    {source.recommendedUsage ? (
                      <p className="mt-2 line-clamp-2 text-xs text-muted-foreground/80">
                        Suggested use: {source.recommendedUsage}
                      </p>
                    ) : null}
                    <div className="mt-3 flex flex-wrap gap-2 text-xs text-muted-foreground">
                      <span>Updated {formatDateTime(source.updatedAt)}</span>
                      <span>
                        Last event {formatDateTime(source.lastTriggeredAt)}
                      </span>
                    </div>
                  </button>
                )
              })
            )}
          </AppCardContent>
        </AppCard>

        <div className="flex min-w-0 flex-col gap-6">
          {selectedSource ? (
            <>
              <AppCard variant="panel">
                <AppCardHeader className="gap-4">
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <AppCardTitle>{selectedSource.name}</AppCardTitle>
                        <Badge
                          variant={eventSourceStatusVariant(
                            selectedSource.status
                          )}
                        >
                          {selectedSource.status}
                        </Badge>
                      </div>
                      <AppCardDescription className="mt-2">
                        {selectedSource.description}
                      </AppCardDescription>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {selectedSource.status !== "active" ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            void handleUpdateStatus(selectedSource, "active")
                          }
                          disabled={savingSource}
                        >
                          Activate
                        </Button>
                      ) : null}
                      {selectedSource.status !== "deprecated" ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            void handleUpdateStatus(
                              selectedSource,
                              "deprecated"
                            )
                          }
                          disabled={savingSource}
                        >
                          Deprecate
                        </Button>
                      ) : null}
                      {selectedSource.status !== "disabled" ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            void handleUpdateStatus(selectedSource, "disabled")
                          }
                          disabled={savingSource}
                        >
                          Disable
                        </Button>
                      ) : null}
                      {selectedSource.status !== "archived" ? (
                        <Button
                          type="button"
                          variant="destructive"
                          size="sm"
                          onClick={() =>
                            void handleArchiveSource(selectedSource)
                          }
                          disabled={savingSource}
                        >
                          <Archive data-icon="inline-start" />
                          Archive
                        </Button>
                      ) : null}
                    </div>
                  </div>
                </AppCardHeader>
                <AppCardContent className="grid gap-6 xl:grid-cols-3">
                  <div className="rounded-[22px] border border-border/70 bg-muted/20 p-4">
                    <div className="text-sm font-medium text-foreground">
                      Identity
                    </div>
                    <dl className="mt-3 grid gap-3 text-sm">
                      <div>
                        <dt className="text-muted-foreground">Provider</dt>
                        <dd className="font-medium text-foreground">
                          {sourceProviderLabel(selectedSource)}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">Provider ref</dt>
                        <dd className="font-medium text-foreground">
                          {selectedSource.providerKind === "integration"
                            ? selectedSource.integration?.targetLabel ||
                              selectedSource.integration?.targetId ||
                              "None"
                            : selectedSource.providerRef || "None"}
                        </dd>
                      </div>
                      {selectedSource.providerKind === "integration" &&
                      selectedSource.integration ? (
                        <>
                          <div>
                            <dt className="text-muted-foreground">Target</dt>
                            <dd className="font-medium text-foreground">
                              {selectedSource.integration.targetId}
                            </dd>
                          </div>
                          <div>
                            <dt className="text-muted-foreground">Ingress</dt>
                            <dd className="font-medium text-foreground">
                              {selectedSource.integration.ingressKind}
                            </dd>
                          </div>
                        </>
                      ) : null}
                      <div>
                        <dt className="text-muted-foreground">Source key</dt>
                        <dd className="font-medium text-foreground">
                          {selectedSource.sourceKey}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">Created</dt>
                        <dd className="font-medium text-foreground">
                          {formatDateTime(selectedSource.createdAt)}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">
                          Last triggered
                        </dt>
                        <dd className="font-medium text-foreground">
                          {formatDateTime(selectedSource.lastTriggeredAt)}
                        </dd>
                      </div>
                    </dl>
                  </div>
                  <div className="rounded-[22px] border border-border/70 bg-muted/20 p-4">
                    <div className="text-sm font-medium text-foreground">
                      Suggested Usage
                    </div>
                    <p className="mt-3 text-sm whitespace-pre-wrap text-muted-foreground">
                      {selectedSource.recommendedUsage ||
                        "No suggested usage guidance provided for this source."}
                    </p>
                  </div>
                  <div className="rounded-[22px] border border-border/70 bg-muted/20 p-4">
                    <div className="text-sm font-medium text-foreground">
                      Contract
                    </div>
                    <div className="mt-3 grid gap-4">
                      <div>
                        <div className="text-xs tracking-wide text-muted-foreground uppercase">
                          Payload schema
                        </div>
                        <pre className="mt-2 overflow-x-auto rounded-2xl bg-background px-3 py-3 text-xs">
                          {serializeJson(selectedSource.payloadSchema)}
                        </pre>
                      </div>
                      <div>
                        <div className="text-xs tracking-wide text-muted-foreground uppercase">
                          Example payload
                        </div>
                        <pre className="mt-2 overflow-x-auto rounded-2xl bg-background px-3 py-3 text-xs">
                          {serializeJson(selectedSource.examplePayload)}
                        </pre>
                      </div>
                    </div>
                  </div>
                </AppCardContent>
              </AppCard>

              <AppCard variant="panel">
                <AppCardHeader className="gap-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <AppCardTitle>History</AppCardTitle>
                      <AppCardDescription>
                        Every reported occurrence is stored even if no trigger
                        subscribed to it.
                      </AppCardDescription>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void loadOccurrences(selectedSource.id)}
                      disabled={loadingOccurrences}
                    >
                      <RefreshCw
                        className={cn(loadingOccurrences && "animate-spin")}
                        data-icon="inline-start"
                      />
                      Refresh
                    </Button>
                  </div>
                </AppCardHeader>
                <AppCardContent className="flex flex-col gap-4">
                  {loadingOccurrences ? (
                    <div className="rounded-[22px] border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
                      Loading history...
                    </div>
                  ) : occurrences.length === 0 ? (
                    <div className="rounded-[22px] border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
                      No occurrences recorded for this event source yet.
                    </div>
                  ) : (
                    occurrences.map((occurrence, index) => (
                      <div
                        key={occurrence.id}
                        className="rounded-[22px] border border-border/70 px-4 py-4"
                      >
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                              <History className="size-4 text-muted-foreground" />
                              <span className="truncate">
                                {occurrenceTitle(occurrence)}
                              </span>
                            </div>
                            <div className="mt-1 text-xs text-muted-foreground">
                              {formatDateTime(occurrence.occurredAt)}
                            </div>
                            {occurrence.displayDescription ? (
                              <p className="mt-2 text-sm text-muted-foreground">
                                {occurrence.displayDescription}
                              </p>
                            ) : null}
                          </div>
                          <div className="flex flex-wrap gap-2">
                            {occurrence.dedupeKey ? (
                              <Badge variant="outline">
                                dedupe {occurrence.dedupeKey}
                              </Badge>
                            ) : null}
                            <Badge variant="secondary">
                              {occurrenceSummary(occurrence)}
                            </Badge>
                          </div>
                        </div>
                        <div className="mt-3 grid gap-3 lg:grid-cols-2">
                          <div>
                            <div className="text-xs tracking-wide text-muted-foreground uppercase">
                              Payload
                            </div>
                            <pre className="mt-2 overflow-x-auto rounded-2xl bg-muted/30 px-3 py-3 text-xs">
                              {serializeJson(occurrence.payload)}
                            </pre>
                          </div>
                          <div>
                            <div className="text-xs tracking-wide text-muted-foreground uppercase">
                              Source snapshot
                            </div>
                            <pre className="mt-2 overflow-x-auto rounded-2xl bg-muted/30 px-3 py-3 text-xs">
                              {serializeJson(occurrence.sourceSnapshot)}
                            </pre>
                          </div>
                        </div>
                        {index < occurrences.length - 1 ? (
                          <Separator className="mt-4" />
                        ) : null}
                      </div>
                    ))
                  )}
                </AppCardContent>
              </AppCard>
            </>
          ) : (
            <AppCard variant="panel">
              <AppCardContent className="py-16 text-center text-sm text-muted-foreground">
                Select an event source to inspect its definition and history.
              </AppCardContent>
            </AppCard>
          )}
        </div>
      </div>

      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Create Event Source</DialogTitle>
            <DialogDescription>
              Register a durable event definition. Internal and generic webhook
              sources are configured manually. GitHub and GitLab sources reuse
              an installed official MCP credential, but events still arrive
              through the platform's official webhook APIs.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="grid gap-2">
                <label
                  className="text-sm font-medium text-foreground"
                  htmlFor="event-source-provider-kind"
                >
                  Provider
                </label>
                <Select
                  value={formState.mode}
                  onValueChange={(value) =>
                    setFormState((current) => ({
                      ...EMPTY_FORM,
                      mode: value as EventSourceMode,
                    }))
                  }
                >
                  <SelectTrigger
                    id="event-source-provider-kind"
                    className="w-full"
                  >
                    <SelectValue placeholder="Select provider" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="github">GitHub</SelectItem>
                    <SelectItem value="gitlab">GitLab</SelectItem>
                    <SelectItem value="internal">Internal</SelectItem>
                    <SelectItem value="webhook">Webhook</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {integrationProvider ? (
                <div className="grid gap-2">
                  <label
                    className="text-sm font-medium text-foreground"
                    htmlFor="event-source-installation"
                  >
                    Installed integration
                  </label>
                  <Select
                    value={formState.installationId}
                    onValueChange={(value) =>
                      setFormState((current) => ({
                        ...current,
                        installationId: value,
                      }))
                    }
                  >
                    <SelectTrigger
                      id="event-source-installation"
                      className="w-full"
                    >
                      <SelectValue
                        placeholder={`Select a ${sourceModeLabel(formState.mode)} installation`}
                      />
                    </SelectTrigger>
                    <SelectContent>
                      {availableIntegrationInstallations.length > 0 ? (
                        availableIntegrationInstallations.map(
                          (installation) => (
                            <SelectItem
                              key={installation.id}
                              value={installation.id}
                            >
                              {installation.plugin_display_name ||
                                installation.plugin_slug ||
                                installation.id}
                            </SelectItem>
                          )
                        )
                      ) : (
                        <SelectItem value="__none" disabled>
                          No active {sourceModeLabel(formState.mode)}{" "}
                          installation found
                        </SelectItem>
                      )}
                    </SelectContent>
                  </Select>
                </div>
              ) : (
                <div className="grid gap-2">
                  <label
                    className="text-sm font-medium text-foreground"
                    htmlFor="event-source-provider-ref"
                  >
                    Provider ref
                  </label>
                  <Input
                    id="event-source-provider-ref"
                    value={formState.providerRef}
                    onChange={(event) =>
                      setFormState((current) => ({
                        ...current,
                        providerRef: event.target.value,
                      }))
                    }
                    placeholder={
                      formState.mode === "webhook"
                        ? "Webhook endpoint ID"
                        : "Optional provider reference"
                    }
                  />
                </div>
              )}
            </div>

            {integrationProvider ? (
              <>
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="grid gap-2">
                    <label
                      className="text-sm font-medium text-foreground"
                      htmlFor="event-source-target-id"
                    >
                      {integrationProvider === "github"
                        ? "Repository"
                        : "Project"}
                    </label>
                    <Input
                      id="event-source-target-id"
                      value={formState.targetId}
                      onChange={(event) =>
                        setFormState((current) => ({
                          ...current,
                          targetId: event.target.value,
                        }))
                      }
                      placeholder={
                        integrationProvider === "github"
                          ? "owner/repo"
                          : "group/project"
                      }
                    />
                  </div>
                  <div className="grid gap-2">
                    <label
                      className="text-sm font-medium text-foreground"
                      htmlFor="event-source-target-label"
                    >
                      Display label
                    </label>
                    <Input
                      id="event-source-target-label"
                      value={formState.targetLabel}
                      onChange={(event) =>
                        setFormState((current) => ({
                          ...current,
                          targetLabel: event.target.value,
                        }))
                      }
                      placeholder="Optional custom label"
                    />
                  </div>
                </div>

                <div className="grid gap-2">
                  <label className="text-sm font-medium text-foreground">
                    Event definitions
                  </label>
                  <div className="grid gap-3">
                    {availableIntegrationDefinitions.map((definition) => {
                      const checked =
                        formState.selectedIntegrationSourceKeys.includes(
                          definition.sourceKey
                        )
                      return (
                        <label
                          key={definition.sourceKey}
                          className="flex items-start gap-3 rounded-[22px] border border-border/70 bg-muted/20 px-4 py-4"
                        >
                          <Checkbox
                            checked={checked}
                            onCheckedChange={(value) =>
                              setFormState((current) => ({
                                ...current,
                                selectedIntegrationSourceKeys:
                                  value === true
                                    ? [
                                        ...current.selectedIntegrationSourceKeys,
                                        definition.sourceKey,
                                      ]
                                    : current.selectedIntegrationSourceKeys.filter(
                                        (key) => key !== definition.sourceKey
                                      ),
                              }))
                            }
                          />
                          <div className="min-w-0 space-y-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-sm font-medium text-foreground">
                                {definition.name}
                              </span>
                              <Badge variant="outline">
                                {definition.sourceKey}
                              </Badge>
                            </div>
                            <p className="text-sm text-muted-foreground">
                              {definition.description}
                            </p>
                            {definition.recommendedUsage ? (
                              <p className="text-xs text-muted-foreground/80">
                                {definition.recommendedUsage}
                              </p>
                            ) : null}
                          </div>
                        </label>
                      )
                    })}
                  </div>
                </div>

                <div className="rounded-[22px] border border-border/70 bg-muted/20 px-4 py-3 text-sm text-muted-foreground">
                  Synapse will create one durable event source and one official
                  platform webhook per selected definition. Incoming events
                  still use GitHub/GitLab official webhook delivery, not the MCP
                  server.
                </div>
              </>
            ) : (
              <>
                <div className="grid gap-2">
                  <label
                    className="text-sm font-medium text-foreground"
                    htmlFor="event-source-name"
                  >
                    Name
                  </label>
                  <Input
                    id="event-source-name"
                    value={formState.name}
                    onChange={(event) =>
                      setFormState((current) => ({
                        ...current,
                        name: event.target.value,
                      }))
                    }
                    placeholder="Device Online"
                  />
                </div>

                <div className="grid gap-2">
                  <label
                    className="text-sm font-medium text-foreground"
                    htmlFor="event-source-description"
                  >
                    Description
                  </label>
                  <Textarea
                    id="event-source-description"
                    value={formState.description}
                    onChange={(event) =>
                      setFormState((current) => ({
                        ...current,
                        description: event.target.value,
                      }))
                    }
                    placeholder="Explain when the event fires and what the payload means."
                    rows={4}
                  />
                </div>

                <div className="grid gap-2">
                  <label
                    className="text-sm font-medium text-foreground"
                    htmlFor="event-source-recommended-usage"
                  >
                    Suggested usage
                  </label>
                  <Textarea
                    id="event-source-recommended-usage"
                    value={formState.recommendedUsage}
                    onChange={(event) =>
                      setFormState((current) => ({
                        ...current,
                        recommendedUsage: event.target.value,
                      }))
                    }
                    placeholder="Explain the scenarios where this source is especially useful, for example what kinds of subscriptions or wakeups it should drive."
                    rows={4}
                  />
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                  <div className="grid gap-2">
                    <label
                      className="text-sm font-medium text-foreground"
                      htmlFor="event-source-payload-schema"
                    >
                      Payload schema
                    </label>
                    <Textarea
                      id="event-source-payload-schema"
                      value={formState.payloadSchemaText}
                      onChange={(event) =>
                        setFormState((current) => ({
                          ...current,
                          payloadSchemaText: event.target.value,
                        }))
                      }
                      className="min-h-52 font-mono text-xs"
                    />
                  </div>
                  <div className="grid gap-2">
                    <label
                      className="text-sm font-medium text-foreground"
                      htmlFor="event-source-example-payload"
                    >
                      Example payload
                    </label>
                    <Textarea
                      id="event-source-example-payload"
                      value={formState.examplePayloadText}
                      onChange={(event) =>
                        setFormState((current) => ({
                          ...current,
                          examplePayloadText: event.target.value,
                        }))
                      }
                      className="min-h-52 font-mono text-xs"
                    />
                  </div>
                </div>
              </>
            )}

            <div className="rounded-[22px] border border-border/70 bg-muted/20 px-4 py-3 text-sm text-muted-foreground">
              Source keys are allocated by the system to avoid collisions for
              manual sources. Integration-backed GitHub/GitLab sources use
              reserved keys such as `github.issue_comment` and
              `gitlab.pipeline`.
            </div>
            <div className="rounded-[22px] border border-border/70 bg-muted/20 px-4 py-3 text-sm text-muted-foreground">
              Relay lifecycle event sources are best managed from the relay
              detail page, where online/offline sources can be enabled without
              creating duplicates.
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setCreateDialogOpen(false)}
              disabled={savingSource}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => void handleCreateSource()}
              disabled={savingSource}
            >
              {savingSource ? (
                <RefreshCw className="animate-spin" data-icon="inline-start" />
              ) : (
                <Radio data-icon="inline-start" />
              )}
              Save Source
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
