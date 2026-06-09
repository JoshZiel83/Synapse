"use client"

import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { useEffect, useMemo, useState } from "react"
import {
  extractText,
  textBlocks,
  type Actor,
  type ActorVersion,
} from "@synapse/shared"
import { ArrowLeft, Bot, Loader2, PencilLine } from "lucide-react"
import { toast } from "sonner"

import { useWorkspace } from "@/app/dashboard/workspace-provider"
import {
  actorSummary,
  formatDate,
  titleCase,
} from "@/components/actor-editor-model"
import { CanonicalContentRenderer } from "@/components/canonical-content-renderer"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { api } from "@/lib/api"
import { resolveFileUrl } from "@/lib/utils"

function buildHistoryHref(actorId: string, version: number) {
  return `/dashboard/actors/${actorId}/history?version=${version}`
}

function VersionListItem({
  version,
  active,
  currentVersion,
  onSelect,
}: {
  version: ActorVersion
  active: boolean
  currentVersion: number
  onSelect: () => void
}) {
  const summary = version.delta?.summary?.length
    ? extractText(version.delta.summary).replace(/\s+/g, " ").trim()
    : "Initial actor definition."

  return (
    <button
      onClick={onSelect}
      className={`w-full rounded-3xl border px-4 py-3 text-left transition-colors ${
        active
          ? "border-primary bg-accent"
          : "border-transparent hover:bg-accent/60"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <div className="text-sm font-medium text-foreground">
              v{version.version}
            </div>
            {version.version === currentVersion ? (
              <Badge variant="secondary">current</Badge>
            ) : null}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            {formatDate(version.createdAt)}
          </div>
          <div className="mt-2 line-clamp-2 text-sm text-muted-foreground">
            {summary || "No summary."}
          </div>
        </div>
      </div>
    </button>
  )
}

export function ActorVersionHistoryPage({ actorId }: { actorId: string }) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { workspaceId } = useWorkspace()

  const [actor, setActor] = useState<Actor | null>(null)
  const [versions, setVersions] = useState<ActorVersion[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!workspaceId) return
    const currentWorkspaceId = workspaceId
    let cancelled = false

    async function load() {
      setLoading(true)
      try {
        const [actorResponse, versionResponse] = await Promise.all([
          api.getActor(currentWorkspaceId, actorId),
          api.getActorVersions(currentWorkspaceId, actorId),
        ])
        if (cancelled) return
        setActor(actorResponse as Actor)
        setVersions(
          Array.isArray(versionResponse)
            ? (versionResponse as ActorVersion[])
            : []
        )
      } catch (error) {
        console.error("Failed to load actor history:", error)
        if (!cancelled) {
          toast.error(
            error instanceof Error
              ? error.message
              : "Failed to load actor history"
          )
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void load()

    return () => {
      cancelled = true
    }
  }, [actorId, workspaceId])

  const selectedVersion = useMemo(() => {
    if (versions.length === 0) return null
    const requested = Number(searchParams.get("version"))
    return (
      versions.find((version) => version.version === requested) || versions[0]
    )
  }, [searchParams, versions])

  const selectedFieldChanges = useMemo(
    () =>
      selectedVersion?.delta?.changes?.filter(
        (change) => change.kind === "field"
      ) || [],
    [selectedVersion]
  )

  const selectedDocChanges = useMemo(
    () =>
      selectedVersion?.delta?.changes?.filter(
        (change) => change.kind === "doc"
      ) || [],
    [selectedVersion]
  )

  useEffect(() => {
    if (!selectedVersion || searchParams.get("version")) return
    router.replace(buildHistoryHref(actorId, selectedVersion.version))
  }, [actorId, router, searchParams, selectedVersion])

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Loading actor history...
        </div>
      </div>
    )
  }

  if (!actor) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <Card className="max-w-lg">
          <CardHeader>
            <CardTitle>Actor not found</CardTitle>
            <CardDescription>
              This actor is unavailable in the current workspace.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild variant="outline">
              <Link href="/dashboard/contacts">
                <ArrowLeft data-icon="inline-start" />
                Back to contacts
              </Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 overflow-hidden">
      <div className="flex min-h-0 w-[360px] shrink-0 flex-col border-r border-border bg-muted/20">
        <div className="border-b border-border px-4 py-4">
          <div className="flex items-start gap-3 rounded-[28px] border border-border bg-background p-4">
            <Avatar className="size-14 rounded-3xl">
              <AvatarImage
                src={resolveFileUrl(actor.avatarUrl) || undefined}
                alt={actor.displayName}
              />
              <AvatarFallback className="rounded-3xl bg-primary/10 text-primary">
                <Bot className="size-6" />
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <div className="truncate text-base font-semibold text-foreground">
                {actor.displayName}
              </div>
              <div className="mt-1 text-sm text-muted-foreground">
                {actor.definition.title || titleCase(actor.definition.role)}
              </div>
              <div className="mt-2 line-clamp-2 text-sm text-muted-foreground">
                {actorSummary(actor)}
              </div>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href={`/dashboard/actors/${actor.id}/edit`}>
                <PencilLine data-icon="inline-start" />
                Edit actor
              </Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link href="/dashboard/contacts">
                <ArrowLeft data-icon="inline-start" />
                Back
              </Link>
            </Button>
          </div>
        </div>

        <ScrollArea className="min-h-0 flex-1 p-3">
          <div className="flex flex-col gap-2">
            <div className="px-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
              Versions
            </div>
            {versions.length > 0 ? (
              versions.map((version) => (
                <VersionListItem
                  key={version.id}
                  version={version}
                  active={selectedVersion?.id === version.id}
                  currentVersion={actor.currentVersion}
                  onSelect={() =>
                    router.replace(buildHistoryHref(actor.id, version.version))
                  }
                />
              ))
            ) : (
              <p className="px-1 text-sm text-muted-foreground">
                No version history yet.
              </p>
            )}
          </div>
        </ScrollArea>
      </div>

      <div className="min-w-0 flex-1 bg-background">
        <div className="flex h-full flex-col">
          <div className="border-b border-border px-6 py-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="text-2xl font-semibold text-foreground">
                    {selectedVersion
                      ? `Version ${selectedVersion.version}`
                      : "Version history"}
                  </h1>
                  {selectedVersion ? (
                    <Badge variant="outline">
                      {formatDate(selectedVersion.createdAt)}
                    </Badge>
                  ) : null}
                </div>
                <p className="mt-2 text-sm text-muted-foreground">
                  {selectedVersion
                    ? "Snapshot on the right is the exact actor definition stored for that version."
                    : "Select a version from the left to inspect the recorded changes."}
                </p>
              </div>
            </div>
          </div>

          <ScrollArea className="min-h-0 flex-1">
            <div className="flex flex-col gap-4 p-6">
              {selectedVersion ? (
                <>
                  <Card>
                    <CardHeader>
                      <CardTitle>Change summary</CardTitle>
                      <CardDescription>
                        Compact/provider can use this summary and delta to
                        decide how to represent actor evolution.
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="flex flex-col gap-5">
                      <CanonicalContentRenderer
                        blocks={
                          selectedVersion.delta?.summary ||
                          textBlocks("Initial actor definition.")
                        }
                        emptyText="No summary was recorded for this version."
                      />

                      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                        <div className="rounded-[28px] border border-border bg-muted/20 p-5">
                          <div className="text-sm font-medium text-foreground">
                            Changed fields
                          </div>
                          <div className="mt-3 flex flex-wrap gap-2">
                            {selectedFieldChanges.length ? (
                              selectedFieldChanges.map((change) => (
                                <Badge key={change.field} variant="outline">
                                  {change.field}
                                </Badge>
                              ))
                            ) : (
                              <span className="text-sm text-muted-foreground">
                                No structured field changes.
                              </span>
                            )}
                          </div>
                        </div>

                        <div className="rounded-[28px] border border-border bg-muted/20 p-5">
                          <div className="text-sm font-medium text-foreground">
                            Changed docs
                          </div>
                          <div className="mt-3 flex flex-wrap gap-2">
                            {selectedDocChanges.length ? (
                              selectedDocChanges.map((doc) => (
                                <Badge
                                  key={`${selectedVersion.id}:${doc.docId}`}
                                  variant="outline"
                                >
                                  {doc.title} · {doc.changeType}
                                </Badge>
                              ))
                            ) : (
                              <span className="text-sm text-muted-foreground">
                                No doc diffs recorded.
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    </CardContent>
                  </Card>

                  {selectedDocChanges.length ? (
                    <Card>
                      <CardHeader>
                        <CardTitle>Doc-level edits</CardTitle>
                        <CardDescription>
                          Each changed doc keeps a compact summary and
                          field-level diff.
                        </CardDescription>
                      </CardHeader>
                      <CardContent className="flex flex-col gap-4">
                        {selectedDocChanges.map((doc) => (
                          <div
                            key={`${selectedVersion.id}:${doc.docId}`}
                            className="rounded-[28px] border border-border p-5"
                          >
                            <div className="flex flex-wrap items-center gap-2">
                              <div className="font-medium text-foreground">
                                {doc.title}
                              </div>
                              <Badge variant="outline">{doc.changeType}</Badge>
                              <Badge variant="outline">
                                {doc.visibility.replace(/_/g, " ")}
                              </Badge>
                            </div>
                            <div className="mt-4">
                              <CanonicalContentRenderer
                                blocks={doc.summary}
                                emptyText="No summary for this doc change."
                              />
                            </div>
                            <div className="mt-5 rounded-3xl border border-border bg-muted/20 p-4">
                              <div className="mb-3 text-sm font-medium text-foreground">
                                Field changes
                              </div>
                              {doc.fieldChanges?.length ? (
                                <div className="flex flex-col gap-3">
                                  {doc.fieldChanges.map((change, index) => (
                                    <div
                                      key={`${doc.docId}:${change.field}:${index}`}
                                      className="rounded-2xl border border-border/60 bg-background/80 p-3"
                                    >
                                      <div className="text-sm font-medium text-foreground">
                                        {change.field}
                                      </div>
                                      {typeof change.before !== "undefined" ||
                                      typeof change.after !== "undefined" ? (
                                        <div className="mt-1 text-sm text-muted-foreground">
                                          {`${String(change.before ?? "empty")} -> ${String(change.after ?? "empty")}`}
                                        </div>
                                      ) : null}
                                      {change.beforeSummaryText ||
                                      change.afterSummaryText ? (
                                        <div className="mt-2 text-sm text-muted-foreground">
                                          {[
                                            change.beforeSummaryText
                                              ? `Before: ${change.beforeSummaryText}`
                                              : null,
                                            change.afterSummaryText
                                              ? `After: ${change.afterSummaryText}`
                                              : null,
                                          ]
                                            .filter(Boolean)
                                            .join(" ")}
                                        </div>
                                      ) : null}
                                    </div>
                                  ))}
                                </div>
                              ) : (
                                <p className="text-sm text-muted-foreground">
                                  No field-level detail recorded for this doc
                                  change.
                                </p>
                              )}
                            </div>
                          </div>
                        ))}
                      </CardContent>
                    </Card>
                  ) : null}

                  <Card>
                    <CardHeader>
                      <CardTitle>Snapshot</CardTitle>
                      <CardDescription>
                        The stored actor definition for this exact version.
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="flex flex-col gap-4">
                      <div className="grid gap-4 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
                        <div className="rounded-[28px] border border-border bg-muted/20 p-5">
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge variant="secondary">
                              {titleCase(selectedVersion.snapshot.role)}
                            </Badge>
                            {selectedVersion.snapshot.canRepresentUser ? (
                              <Badge variant="outline">
                                Can represent user
                              </Badge>
                            ) : null}
                          </div>
                          <div className="mt-4 space-y-3 text-sm">
                            <div className="flex items-center justify-between gap-4">
                              <span className="text-muted-foreground">
                                Name
                              </span>
                              <span className="font-medium text-foreground">
                                {selectedVersion.snapshot.displayName}
                              </span>
                            </div>
                            <Separator />
                            <div className="flex items-center justify-between gap-4">
                              <span className="text-muted-foreground">
                                Title
                              </span>
                              <span className="font-medium text-foreground">
                                {selectedVersion.snapshot.title || "Not set"}
                              </span>
                            </div>
                            <Separator />
                            <div className="flex items-center justify-between gap-4">
                              <span className="text-muted-foreground">
                                Specialties
                              </span>
                              <span className="font-medium text-foreground">
                                {selectedVersion.snapshot.specialties.length ||
                                  "No structured specialties"}
                              </span>
                            </div>
                          </div>
                        </div>

                        <div className="rounded-[28px] border border-border bg-muted/20 p-5">
                          <div className="text-sm font-medium text-foreground">
                            Narrative docs
                          </div>
                          <div className="mt-3 text-sm text-muted-foreground">
                            {selectedVersion.snapshot.docs.length} sections
                            stored in this snapshot.
                          </div>
                        </div>
                      </div>

                      {selectedVersion.snapshot.docs.length > 0 ? (
                        selectedVersion.snapshot.docs
                          .slice()
                          .sort((left, right) => right.priority - left.priority)
                          .map((doc) => (
                            <div
                              key={`${selectedVersion.id}:${doc.id}`}
                              className="rounded-[28px] border border-border p-5"
                            >
                              <div className="mb-4 flex flex-wrap items-center gap-2">
                                <div className="font-medium text-foreground">
                                  {doc.title}
                                </div>
                                <Badge variant="outline">
                                  {doc.visibility.replace(/_/g, " ")}
                                </Badge>
                              </div>
                              <CanonicalContentRenderer
                                blocks={doc.content}
                                emptyText="No content in this section."
                              />
                            </div>
                          ))
                      ) : (
                        <p className="text-sm text-muted-foreground">
                          No docs were stored in this version.
                        </p>
                      )}
                    </CardContent>
                  </Card>
                </>
              ) : (
                <Card>
                  <CardHeader>
                    <CardTitle>No version selected</CardTitle>
                    <CardDescription>
                      Select a version from the left to inspect it.
                    </CardDescription>
                  </CardHeader>
                </Card>
              )}
            </div>
          </ScrollArea>
        </div>
      </div>
    </div>
  )
}
