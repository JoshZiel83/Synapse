'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useDeferredValue, useEffect, useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { extractText, type Actor, type ActorDoc, type ActorPackageRecord, type ActorVersion } from '@synapse/shared'
import {
  Bot,
  Mail,
  PencilLine,
  Plus,
  Search,
  ShieldCheck,
  Sparkles,
  Users,
} from 'lucide-react'

import { ActorEditorSheet } from '@/components/actor-editor-sheet'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { api } from '@/lib/api'
import { resolveFileUrl } from '@/lib/utils'
import { useWorkspace } from '../workspace-provider'

type WorkspaceMember = {
  id: string
  userId: string
  userName?: string
  userEmail?: string
  avatarUrl?: string | null
  trustLevel: string
  joinedAt: string
}

type SelectedContact =
  | { kind: 'user'; id: string }
  | { kind: 'actor'; id: string }
  | { kind: 'package'; id: string }
  | null

function formatDate(dateString?: string) {
  if (!dateString) return 'Unknown'
  try {
    return new Date(dateString).toLocaleDateString([], {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })
  } catch {
    return 'Unknown'
  }
}

function titleCase(input: string) {
  return input
    .split('_')
    .join(' ')
    .replace(/\b\w/g, (char) => char.toUpperCase())
}

function summarizeDoc(doc: ActorDoc, maxLength = 200) {
  const text = extractText(doc.content).replace(/\s+/g, ' ').trim()
  if (text) {
    return text.length > maxLength ? `${text.slice(0, maxLength - 1)}...` : text
  }
  const file = doc.content.find((block) => block.type === 'file_ref')
  return file ? `Attached file: ${file.originalName}` : ''
}

function actorDefinition(actor: Actor) {
  return actor.definition
}

function actorSummary(actor: Actor) {
  const definition = actorDefinition(actor)
  const docs = [...(definition.docs || [])].sort((left, right) => right.priority - left.priority)
  const summary = docs.map((doc) => summarizeDoc(doc, 140)).find(Boolean)
  return summary || definition.title || titleCase(definition.role)
}

function packageSummary(actorPackage: ActorPackageRecord) {
  const actor = actorPackage.manifest.actor
  const docs = [...(actor.docs || [])].sort((left, right) => right.priority - left.priority)
  const summary = docs.map((doc) => summarizeDoc(doc, 140)).find(Boolean)
  return summary || actorPackage.package.description || actor.title || titleCase(actor.role)
}

function ContactListItem({
  actor,
  member,
  active,
  onSelect,
}: {
  actor?: Actor
  member?: WorkspaceMember
  active: boolean
  onSelect: () => void
}) {
  const definition = actor ? actorDefinition(actor) : null
  const name = definition ? definition.name : member?.userName || 'Unknown user'
  const subtitle = actor
    ? actorSummary(actor)
    : member?.userEmail || titleCase(member?.trustLevel || 'member')

  return (
    <button
      onClick={onSelect}
      className={`w-full rounded-2xl border px-3 py-3 text-left transition-colors ${
        active
          ? 'border-primary bg-accent'
          : 'border-transparent hover:bg-accent/60'
      }`}
    >
      <div className="flex items-center gap-3">
        {actor ? (
          <Avatar className="size-10 rounded-2xl">
            <AvatarImage src={resolveFileUrl(actor.avatarUrl) || undefined} alt={definition?.name} />
            <AvatarFallback className="rounded-2xl bg-primary/10 text-primary">
              <Bot className="size-4" />
            </AvatarFallback>
          </Avatar>
        ) : (
          <Avatar className="size-10">
            <AvatarImage src={resolveFileUrl(member?.avatarUrl) || undefined} alt={name} />
            <AvatarFallback>{name.charAt(0).toUpperCase()}</AvatarFallback>
          </Avatar>
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-foreground">{name}</div>
          <div className="truncate text-sm text-muted-foreground">{subtitle}</div>
        </div>
      </div>
    </button>
  )
}

function PackageListItem({
  actorPackage,
  active,
  installCount,
  onSelect,
}: {
  actorPackage: ActorPackageRecord
  active: boolean
  installCount: number
  onSelect: () => void
}) {
  return (
    <button
      onClick={onSelect}
      className={`w-full rounded-2xl border px-3 py-3 text-left transition-colors ${
        active
          ? 'border-primary bg-accent'
          : 'border-transparent hover:bg-accent/60'
      }`}
    >
      <div className="flex items-start gap-3">
        <Avatar className="size-10 rounded-2xl">
          <AvatarImage src={actorPackage.package.iconUrl || undefined} alt={actorPackage.package.displayName} />
          <AvatarFallback className="rounded-2xl bg-primary/10 text-primary">
            <Sparkles className="size-4" />
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <div className="truncate text-sm font-medium text-foreground">{actorPackage.package.displayName}</div>
            {installCount > 0 ? <Badge variant="secondary">{installCount} installed</Badge> : null}
          </div>
          <div className="truncate text-sm text-muted-foreground">{packageSummary(actorPackage)}</div>
        </div>
      </div>
    </button>
  )
}

function UserDetail({ member }: { member: WorkspaceMember }) {
  const displayName = member.userName || 'Unknown user'

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-6 py-5">
        <div className="flex items-start gap-4">
          <Avatar className="size-16">
            <AvatarImage src={resolveFileUrl(member.avatarUrl) || undefined} alt={displayName} />
            <AvatarFallback className="text-lg">{displayName.charAt(0).toUpperCase()}</AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-xl font-semibold text-foreground">{displayName}</h2>
              <Badge variant="secondary">Workspace User</Badge>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">{member.userEmail || 'No email available'}</p>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Account</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4 text-sm">
              <div className="flex items-start gap-3">
                <Mail className="mt-0.5 size-4 text-muted-foreground" />
                <div>
                  <div className="font-medium text-foreground">Email</div>
                  <div className="text-muted-foreground">{member.userEmail || 'Not available'}</div>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <ShieldCheck className="mt-0.5 size-4 text-muted-foreground" />
                <div>
                  <div className="font-medium text-foreground">Workspace Role</div>
                  <div className="text-muted-foreground">{titleCase(member.trustLevel)}</div>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <Users className="mt-0.5 size-4 text-muted-foreground" />
                <div>
                  <div className="font-medium text-foreground">Joined Workspace</div>
                  <div className="text-muted-foreground">{formatDate(member.joinedAt)}</div>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}

function ContentBlocksCard({
  title,
  blocks,
  badge,
}: {
  title: string
  blocks: ActorDoc['content']
  badge?: string
}) {
  const text = extractText(blocks).trim()
  const files = blocks.filter((block): block is Extract<ActorDoc['content'][number], { type: 'file_ref' }> => block.type === 'file_ref')

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="text-base">{title}</CardTitle>
          {badge ? <Badge variant="outline">{badge}</Badge> : null}
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {text ? (
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              p: ({ children }) => <p className="leading-7 text-foreground/85">{children}</p>,
              ul: ({ children }) => <ul className="ml-5 list-disc space-y-2 text-foreground/85">{children}</ul>,
              ol: ({ children }) => <ol className="ml-5 list-decimal space-y-2 text-foreground/85">{children}</ol>,
              li: ({ children }) => <li>{children}</li>,
              strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
              code: ({ children }) => (
                <code className="rounded bg-muted px-1.5 py-0.5 text-[0.85em] text-foreground">{children}</code>
              ),
              blockquote: ({ children }) => (
                <blockquote className="border-l-2 border-border pl-4 text-muted-foreground">{children}</blockquote>
              ),
            }}
          >
            {text}
          </ReactMarkdown>
        ) : (
          <p className="text-sm text-muted-foreground">This section currently only contains file references.</p>
        )}

        {files.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {files.map((file) => (
              <a
                key={file.fileId}
                href={resolveFileUrl(file.url) || undefined}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-2 rounded-full border border-border px-3 py-1 text-sm text-foreground transition-colors hover:bg-accent"
              >
                <Sparkles className="size-3.5 text-muted-foreground" />
                <span>{file.originalName}</span>
                <Badge variant="outline">{file.category}</Badge>
              </a>
            ))}
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}

function MarkdownDoc({ doc }: { doc: ActorDoc }) {
  return (
    <ContentBlocksCard
      title={doc.title}
      blocks={doc.content}
      badge={doc.visibility.replace(/_/g, ' ')}
    />
  )
}

function ActorVersionHistory({ versions }: { versions: ActorVersion[] }) {
  if (versions.length === 0) {
    return <p className="text-sm text-muted-foreground">No version history yet.</p>
  }

  return (
    <div className="flex flex-col gap-3">
      {versions.map((version) => {
        const summary = version.delta ? extractText(version.delta.summary).trim() : 'Initial actor definition.'
        const docChanges = version.delta?.changes?.filter((change) => change.kind === "doc") || []
        return (
          <div key={version.id} className="rounded-2xl border border-border p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Badge variant="secondary">v{version.version}</Badge>
                <span className="text-sm font-medium text-foreground">{formatDate(version.createdAt)}</span>
              </div>
              <span className="text-xs text-muted-foreground">{version.snapshot.title || version.snapshot.role}</span>
            </div>
            <p className="mt-3 text-sm text-muted-foreground">{summary}</p>
            {docChanges.length ? (
              <div className="mt-3 flex flex-wrap gap-2">
                {docChanges.map((doc) => (
                  <Badge key={`${version.id}:${doc.docId}`} variant="outline">
                    {doc.title}
                  </Badge>
                ))}
              </div>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

function ActorDetail({
  actor,
  versions,
  loading,
  onEdit,
  onOpenHistory,
}: {
  actor: Actor | null
  versions: ActorVersion[]
  loading: boolean
  onEdit: () => void
  onOpenHistory: () => void
}) {
  if (!actor && loading) {
    return (
      <div className="flex h-full flex-col gap-6 p-6">
        <Skeleton className="h-28 rounded-3xl" />
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,0.9fr)]">
          <Skeleton className="h-[520px] rounded-3xl" />
          <Skeleton className="h-[520px] rounded-3xl" />
        </div>
      </div>
    )
  }

  if (!actor) return null
  const definition = actorDefinition(actor)

  const docs = [...(definition.docs || [])]
    .filter((doc) => doc.content.length > 0)
    .sort((left, right) => right.priority - left.priority)

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-6 py-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-4">
            <Avatar className="size-16 rounded-3xl">
              <AvatarImage src={resolveFileUrl(actor.avatarUrl) || undefined} alt={definition.name} />
              <AvatarFallback className="rounded-3xl bg-primary/10 text-primary">
                <Bot className="size-8" />
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-xl font-semibold text-foreground">{definition.name}</h2>
                <Badge variant="secondary">{titleCase(definition.role)}</Badge>
                <Badge variant="outline">v{actor.currentVersion}</Badge>
                {definition.canRepresentUser ? <Badge variant="outline">Can represent user</Badge> : null}
                {actor.isActive === false ? <Badge variant="outline">Inactive</Badge> : null}
              </div>
              <p className="mt-1 text-sm text-muted-foreground">{definition.title || 'No title set'}</p>
              <p className="mt-3 max-w-3xl text-sm text-muted-foreground">{actorSummary(actor)}</p>
            </div>
          </div>

          <Button onClick={onEdit}>
            <PencilLine data-icon="inline-start" />
            Edit actor
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,0.9fr)]">
          <div className="flex flex-col gap-4">
            {docs.length > 0 ? (
              docs.map((doc) => <MarkdownDoc key={doc.id} doc={doc} />)
            ) : (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Profile docs</CardTitle>
                  <CardDescription>No narrative docs have been written for this actor yet.</CardDescription>
                </CardHeader>
              </Card>
            )}
          </div>

          <div className="flex flex-col gap-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Organization</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-3 text-sm">
                <div className="flex items-center justify-between gap-4">
                  <span className="text-muted-foreground">Role</span>
                  <span className="font-medium text-foreground">{titleCase(definition.role)}</span>
                </div>
                <Separator />
                <div className="flex items-center justify-between gap-4">
                  <span className="text-muted-foreground">Title</span>
                  <span className="font-medium text-foreground">{definition.title || 'Not set'}</span>
                </div>
                <Separator />
                <div className="flex items-center justify-between gap-4">
                  <span className="text-muted-foreground">Parent</span>
                  <span className="font-medium text-foreground">{definition.parentId ? 'Assigned' : 'Root actor'}</span>
                </div>
                <Separator />
                <div className="flex items-center justify-between gap-4">
                  <span className="text-muted-foreground">Created</span>
                  <span className="font-medium text-foreground">{formatDate(actor.createdAt)}</span>
                </div>
              </CardContent>
            </Card>

            {actor.sourceLink ? (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Package source</CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col gap-3 text-sm">
                  <div className="flex items-center justify-between gap-4">
                    <span className="text-muted-foreground">Source</span>
                    <span className="font-medium text-foreground">{actor.sourceLink.packageDisplayName}</span>
                  </div>
                  <Separator />
                  <div className="flex items-center justify-between gap-4">
                    <span className="text-muted-foreground">Imported revision</span>
                    <span className="font-medium text-foreground">{actor.sourceLink.importedVersion || 'Unknown'}</span>
                  </div>
                  <Separator />
                  <div className="flex items-center justify-between gap-4">
                    <span className="text-muted-foreground">Latest official revision</span>
                    <span className="font-medium text-foreground">{actor.sourceLink.latestVersion || 'Unknown'}</span>
                  </div>
                  <Separator />
                  <div className="flex items-center justify-between gap-4">
                    <span className="text-muted-foreground">Sync status</span>
                    <Badge variant="outline">{titleCase(actor.sourceLink.status.replace(/_/g, ' '))}</Badge>
                  </div>
                </CardContent>
              </Card>
            ) : null}

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Specialties</CardTitle>
              </CardHeader>
              <CardContent>
                {definition.specialties.length > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    {definition.specialties.map((specialty) => (
                      <Badge key={specialty} variant="outline">
                        {specialty}
                      </Badge>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">No structured specialties configured.</p>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-start justify-between gap-4">
                <div>
                  <CardTitle className="text-base">Version history</CardTitle>
                </div>
                <Button variant="outline" size="sm" onClick={onOpenHistory}>
                  Open full history
                </Button>
              </CardHeader>
              <CardContent>
                <ActorVersionHistory versions={versions} />
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  )
}

function PackageDetail({
  actorPackage,
  installedActors,
  loading,
  installing,
  onInstall,
  onOpenActor,
}: {
  actorPackage: ActorPackageRecord | null
  installedActors: Actor[]
  loading: boolean
  installing: boolean
  onInstall: () => void
  onOpenActor: (actorId: string) => void
}) {
  if (!actorPackage && loading) {
    return (
      <div className="flex h-full flex-col gap-6 p-6">
        <Skeleton className="h-28 rounded-3xl" />
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,0.9fr)]">
          <Skeleton className="h-[520px] rounded-3xl" />
          <Skeleton className="h-[520px] rounded-3xl" />
        </div>
      </div>
    )
  }

  if (!actorPackage) return null

  const actor = actorPackage.manifest.actor
  const docs = [...(actor.docs || [])]
    .filter((doc) => doc.content.length > 0)
    .sort((left, right) => right.priority - left.priority)
  const checksById = new Map((actorPackage.requirementChecks || []).map((check) => [check.requirementId, check]))

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-6 py-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-4">
            <Avatar className="size-16 rounded-3xl">
              <AvatarImage src={actorPackage.package.iconUrl || undefined} alt={actorPackage.package.displayName} />
              <AvatarFallback className="rounded-3xl bg-primary/10 text-primary">
                <Sparkles className="size-8" />
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-xl font-semibold text-foreground">{actorPackage.package.displayName}</h2>
                <Badge variant="secondary">Official package</Badge>
                {actorPackage.package.publisher?.displayName ? (
                  <Badge variant="outline">{actorPackage.package.publisher.displayName}</Badge>
                ) : null}
                {installedActors.length > 0 ? <Badge variant="outline">{installedActors.length} local installs</Badge> : null}
              </div>
              <p className="mt-1 text-sm text-muted-foreground">{actor.title || actorPackage.package.description}</p>
              <p className="mt-3 max-w-3xl text-sm text-muted-foreground">{packageSummary(actorPackage)}</p>
            </div>
          </div>

          <Button onClick={onInstall} disabled={installing}>
            <Plus data-icon="inline-start" />
            {installing ? 'Installing...' : 'Install to workspace'}
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,0.9fr)]">
          <div className="flex flex-col gap-4">
            {docs.length > 0 ? (
              docs.map((doc) => <MarkdownDoc key={doc.id} doc={doc} />)
            ) : (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Package docs</CardTitle>
                  <CardDescription>No actor docs were bundled with this package.</CardDescription>
                </CardHeader>
              </Card>
            )}

            {actorPackage.manifest.setupGuide.length > 0 ? (
              <ContentBlocksCard title="Setup Guide" blocks={actorPackage.manifest.setupGuide} badge="package" />
            ) : null}
            {actorPackage.manifest.releaseNotes.length > 0 ? (
              <ContentBlocksCard title="Release Notes" blocks={actorPackage.manifest.releaseNotes} badge="package" />
            ) : null}
          </div>

          <div className="flex flex-col gap-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Actor package</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-3 text-sm">
                <div className="flex items-center justify-between gap-4">
                  <span className="text-muted-foreground">Version</span>
                  <span className="font-medium text-foreground">{actorPackage.package.latestRevision?.version || 'Unversioned'}</span>
                </div>
                <Separator />
                <div className="flex items-center justify-between gap-4">
                  <span className="text-muted-foreground">Actor role</span>
                  <span className="font-medium text-foreground">{titleCase(actor.role)}</span>
                </div>
                <Separator />
                <div className="flex items-center justify-between gap-4">
                  <span className="text-muted-foreground">Representation</span>
                  <span className="font-medium text-foreground">{actor.canRepresentUser ? 'Allowed by package' : 'Disabled by package'}</span>
                </div>
                <Separator />
                <div className="flex items-center justify-between gap-4">
                  <span className="text-muted-foreground">Published</span>
                  <span className="font-medium text-foreground">{formatDate(actorPackage.package.updatedAt)}</span>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Dependencies</CardTitle>
                <CardDescription>Package requirements are evaluated against the current workspace before and after installation.</CardDescription>
              </CardHeader>
              <CardContent>
                {actorPackage.dependencies.length > 0 ? (
                  <div className="flex flex-col gap-3">
                    {actorPackage.dependencies.map((dependency) => {
                      const check = dependency.requirementId ? checksById.get(dependency.requirementId) : undefined
                      return (
                        <div key={`${dependency.targetPackageKind}:${dependency.targetPublisherSlug || 'any'}:${dependency.targetPackageSlug}`} className="rounded-2xl border border-border p-4">
                          <div className="flex flex-wrap items-center gap-2">
                            <div className="font-medium text-foreground">
                              {(dependency.targetPublisherSlug ? `${dependency.targetPublisherSlug}/` : '') + dependency.targetPackageSlug}
                            </div>
                            <Badge variant={dependency.requirementKind === 'required' ? 'secondary' : 'outline'}>
                              {dependency.requirementKind}
                            </Badge>
                            <Badge variant="outline">{dependency.targetPackageKind}</Badge>
                            {check ? <Badge variant="outline">{titleCase(check.status)}</Badge> : null}
                          </div>
                          {dependency.description ? (
                            <p className="mt-2 text-sm text-muted-foreground">{dependency.description}</p>
                          ) : null}
                          {dependency.notes.length > 0 ? (
                            <div className="mt-3">
                              <ContentBlocksCard title="Dependency Notes" blocks={dependency.notes} />
                            </div>
                          ) : null}
                        </div>
                      )
                    })}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">This actor package does not declare plugin or skill dependencies.</p>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Installed actors</CardTitle>
              </CardHeader>
              <CardContent>
                {installedActors.length > 0 ? (
                  <div className="flex flex-col gap-2">
                    {installedActors.map((actorInstance) => (
                      <button
                        key={actorInstance.id}
                        onClick={() => onOpenActor(actorInstance.id)}
                        className="flex items-center justify-between rounded-2xl border border-border px-3 py-3 text-left transition-colors hover:bg-accent/60"
                      >
                        <div>
                          <div className="font-medium text-foreground">{actorInstance.definition.name}</div>
                          <div className="text-sm text-muted-foreground">
                            v{actorInstance.currentVersion}
                            {actorInstance.sourceLink ? ` · ${titleCase(actorInstance.sourceLink.status.replace(/_/g, ' '))}` : ''}
                          </div>
                        </div>
                        <Badge variant="outline">{actorInstance.definition.title || titleCase(actorInstance.definition.role)}</Badge>
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">No local installs yet. Install this package to create a workspace actor.</p>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  )
}

export default function ContactsPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { workspaceId } = useWorkspace()
  const [members, setMembers] = useState<WorkspaceMember[]>([])
  const [actors, setActors] = useState<Actor[]>([])
  const [actorPackages, setActorPackages] = useState<ActorPackageRecord[]>([])
  const [selected, setSelected] = useState<SelectedContact>(null)
  const [viewMode, setViewMode] = useState<'directory' | 'packages'>('directory')
  const [search, setSearch] = useState('')
  const deferredSearch = useDeferredValue(search)
  const [loading, setLoading] = useState(true)
  const [detailLoading, setDetailLoading] = useState(false)
  const [selectedActorDetail, setSelectedActorDetail] = useState<Actor | null>(null)
  const [selectedActorVersions, setSelectedActorVersions] = useState<ActorVersion[]>([])
  const [selectedPackageDetail, setSelectedPackageDetail] = useState<ActorPackageRecord | null>(null)
  const [packageActionPending, setPackageActionPending] = useState(false)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editingActor, setEditingActor] = useState<Actor | null>(null)

  async function loadWorkspaceData(currentWorkspaceId: string) {
    const [memberResponse, actorResponse, packageResponse] = await Promise.all([
      api.getWorkspaceMembers(currentWorkspaceId),
      api.getActors(currentWorkspaceId),
      api.getActorPackages(currentWorkspaceId),
    ])

    const nextMembers = Array.isArray(memberResponse) ? memberResponse : (memberResponse?.data || [])
    const nextActors = Array.isArray(actorResponse) ? actorResponse : (actorResponse?.actors || [])
    const nextPackages = Array.isArray(packageResponse) ? packageResponse : []

    setMembers(nextMembers)
    setActors(nextActors)
    setActorPackages(nextPackages)
    setSelected((current) => current ?? (nextActors[0]?.id ? { kind: 'actor', id: nextActors[0].id } : nextMembers[0]?.userId ? { kind: 'user', id: nextMembers[0].userId } : null))
  }

  useEffect(() => {
    if (!workspaceId) return
    const currentWorkspaceId = workspaceId
    let cancelled = false

    async function run() {
      setLoading(true)
      try {
        await loadWorkspaceData(currentWorkspaceId)
      } catch (error) {
        console.error('Failed to load contacts:', error)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void run()

    return () => {
      cancelled = true
    }
  }, [workspaceId])

  useEffect(() => {
    if (!workspaceId || selected?.kind !== 'actor') {
      setSelectedActorDetail(null)
      setSelectedActorVersions([])
      setDetailLoading(false)
      return
    }

    const currentWorkspaceId = workspaceId
    const selectedActorId = selected.id
    let cancelled = false

    async function loadActorDetails() {
      setDetailLoading(true)
      try {
        const [actorResponse, versionsResponse] = await Promise.all([
          api.getActor(currentWorkspaceId, selectedActorId),
          api.getActorVersions(currentWorkspaceId, selectedActorId),
        ])
        if (cancelled) return
        setSelectedActorDetail(actorResponse as Actor)
        setSelectedActorVersions(Array.isArray(versionsResponse) ? (versionsResponse as ActorVersion[]) : [])
      } catch (error) {
        console.error('Failed to load actor details:', error)
      } finally {
        if (!cancelled) setDetailLoading(false)
      }
    }

    void loadActorDetails()

    return () => {
      cancelled = true
    }
  }, [selected, workspaceId])

  useEffect(() => {
    if (!workspaceId || selected?.kind !== 'package') {
      setSelectedPackageDetail(null)
      setDetailLoading(false)
      return
    }

    const currentWorkspaceId = workspaceId
    const packageId = selected.id
    let cancelled = false

    async function loadPackageDetails() {
      setDetailLoading(true)
      try {
        const actorPackage = await api.getActorPackage(currentWorkspaceId, packageId)
        if (cancelled) return
        setSelectedPackageDetail(actorPackage)
      } catch (error) {
        console.error('Failed to load actor package:', error)
      } finally {
        if (!cancelled) setDetailLoading(false)
      }
    }

    void loadPackageDetails()

    return () => {
      cancelled = true
    }
  }, [selected, workspaceId])

  const filteredUsers = useMemo(() => {
    const needle = deferredSearch.trim().toLowerCase()
    if (!needle) return members
    return members.filter((member) => {
      const haystack = `${member.userName || ''} ${member.userEmail || ''} ${member.trustLevel || ''}`.toLowerCase()
      return haystack.includes(needle)
    })
  }, [deferredSearch, members])

  const filteredActors = useMemo(() => {
    const needle = deferredSearch.trim().toLowerCase()
    if (!needle) return actors
    return actors.filter((actor) => {
      const definition = actorDefinition(actor)
      const haystack = `${definition.name} ${definition.title} ${definition.role} ${actorSummary(actor)}`.toLowerCase()
      return haystack.includes(needle)
    })
  }, [actors, deferredSearch])

  const filteredPackages = useMemo(() => {
    const needle = deferredSearch.trim().toLowerCase()
    if (!needle) return actorPackages
    return actorPackages.filter((actorPackage) => {
      const actor = actorPackage.manifest.actor
      const haystack = `${actorPackage.package.displayName} ${actorPackage.package.description} ${actor.name} ${actor.title} ${actor.role} ${packageSummary(actorPackage)}`.toLowerCase()
      return haystack.includes(needle)
    })
  }, [actorPackages, deferredSearch])

  const selectedUser = selected?.kind === 'user'
    ? members.find((member) => member.userId === selected.id) || null
    : null
  const selectedActor = selected?.kind === 'actor'
    ? selectedActorDetail || actors.find((actor) => actor.id === selected.id) || null
    : null
  const selectedPackage = selected?.kind === 'package'
    ? selectedPackageDetail || actorPackages.find((actorPackage) => actorPackage.package.id === selected.id) || null
    : null

  useEffect(() => {
    const kind = searchParams.get('kind')
    const id = searchParams.get('id')
    if (!kind || !id) return

    if (kind === 'user') {
      if (!members.some((member) => member.userId === id)) return
      setViewMode('directory')
      setSelected({ kind: 'user', id })
      return
    }

    if (kind === 'actor') {
      if (!actors.some((actor) => actor.id === id)) return
      setViewMode('directory')
      setSelected({ kind: 'actor', id })
      return
    }

    if (kind === 'package') {
      if (!actorPackages.some((actorPackage) => actorPackage.package.id === id)) return
      setViewMode('packages')
      setSelected({ kind: 'package', id })
    }
  }, [actorPackages, actors, members, searchParams])

  return (
    <>
      <div className="flex h-full min-h-0 overflow-hidden">
        <div className="flex w-[360px] shrink-0 min-h-0 flex-col border-r border-border bg-muted/20">
          <div className="border-b border-border px-4 py-4">
            <ToggleGroup
              type="single"
              value={viewMode}
              onValueChange={(value) => {
                if (!value) return
                const nextMode = value as 'directory' | 'packages'
                setViewMode(nextMode)
                if (nextMode === 'directory') {
                  setSelected((current) => (
                    current?.kind === 'actor' || current?.kind === 'user'
                      ? current
                      : actors[0]?.id
                        ? { kind: 'actor', id: actors[0].id }
                        : members[0]?.userId
                          ? { kind: 'user', id: members[0].userId }
                          : null
                  ))
                } else {
                  setSelected((current) => (
                    current?.kind === 'package'
                      ? current
                      : actorPackages[0]?.package.id
                        ? { kind: 'package', id: actorPackages[0].package.id }
                        : current
                  ))
                }
              }}
              className="mb-4 w-full"
            >
              <ToggleGroupItem value="directory" className="flex-1">
                Directory
              </ToggleGroupItem>
              <ToggleGroupItem value="packages" className="flex-1">
                Packages
              </ToggleGroupItem>
            </ToggleGroup>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={viewMode === 'packages' ? 'Search actor packages...' : 'Search users and actors...'}
                className="pl-9"
              />
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {loading ? (
              <div className="flex flex-col gap-3">
                <Skeleton className="h-11 rounded-2xl" />
                <Skeleton className="h-11 rounded-2xl" />
                <Skeleton className="h-11 rounded-2xl" />
                <Skeleton className="h-44 rounded-3xl" />
              </div>
            ) : (
              viewMode === 'packages' ? (
                <div className="flex flex-col gap-2">
                  <div className="px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Official actor packages
                  </div>
                  {filteredPackages.length > 0 ? (
                    filteredPackages.map((actorPackage) => (
                      <PackageListItem
                        key={actorPackage.package.id}
                        actorPackage={actorPackage}
                        active={selected?.kind === 'package' && selected.id === actorPackage.package.id}
                        installCount={actors.filter((actor) => actor.sourceLink?.packageId === actorPackage.package.id).length}
                        onSelect={() => setSelected({ kind: 'package', id: actorPackage.package.id })}
                      />
                    ))
                  ) : (
                    <p className="px-1 text-sm text-muted-foreground">No actor packages found.</p>
                  )}
                </div>
              ) : (
                <div className="flex flex-col gap-6">
                  <div className="flex flex-col gap-2">
                    <div className="px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Users
                    </div>
                    {filteredUsers.length > 0 ? (
                      filteredUsers.map((member) => (
                        <ContactListItem
                          key={member.userId}
                          member={member}
                          active={selected?.kind === 'user' && selected.id === member.userId}
                          onSelect={() => setSelected({ kind: 'user', id: member.userId })}
                        />
                      ))
                    ) : (
                      <p className="px-1 text-sm text-muted-foreground">No users found.</p>
                    )}
                  </div>

                  <div className="flex flex-col gap-2">
                    <div className="flex items-center justify-between px-1">
                      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        Actors
                      </div>
                      <Button
                        size="sm"
                        onClick={() => {
                          setEditingActor(null)
                          setEditorOpen(true)
                        }}
                      >
                        <Plus data-icon="inline-start" />
                        New
                      </Button>
                    </div>

                    {filteredActors.length > 0 ? (
                      filteredActors.map((actor) => (
                        <ContactListItem
                          key={actor.id}
                          actor={actor}
                          active={selected?.kind === 'actor' && selected.id === actor.id}
                          onSelect={() => setSelected({ kind: 'actor', id: actor.id })}
                        />
                      ))
                    ) : (
                      <p className="px-1 text-sm text-muted-foreground">No actors found.</p>
                    )}
                  </div>
                </div>
              )
            )}
          </div>
        </div>

        <div className="min-w-0 flex-1 bg-background">
          {selectedUser && viewMode === 'directory' ? (
            <UserDetail member={selectedUser} />
          ) : selectedActor && viewMode === 'directory' ? (
            <ActorDetail
              actor={selectedActor}
              versions={selectedActorVersions}
              loading={detailLoading}
              onEdit={() => {
                router.push(`/dashboard/actors/${selectedActor.id}/edit`)
              }}
              onOpenHistory={() => router.push(`/dashboard/actors/${selectedActor.id}/history`)}
            />
          ) : selectedPackage && viewMode === 'packages' ? (
            <PackageDetail
              actorPackage={selectedPackage}
              installedActors={actors.filter((actor) => actor.sourceLink?.packageId === selectedPackage.package.id)}
              loading={detailLoading}
              installing={packageActionPending}
              onInstall={async () => {
                if (!workspaceId) return
                setPackageActionPending(true)
                try {
                  const result = await api.installActorPackage(workspaceId, selectedPackage.package.id, {})
                  await loadWorkspaceData(workspaceId)
                  setViewMode('directory')
                  setSelected({ kind: 'actor', id: result.actor.id })
                  setSelectedActorDetail(result.actor)
                  try {
                    const versions = await api.getActorVersions(workspaceId, result.actor.id)
                    setSelectedActorVersions(Array.isArray(versions) ? (versions as ActorVersion[]) : [])
                  } catch (error) {
                    console.error('Failed to refresh installed actor versions:', error)
                  }
                } catch (error) {
                  console.error('Failed to install actor package:', error)
                } finally {
                  setPackageActionPending(false)
                }
              }}
              onOpenActor={(actorId) => {
                setViewMode('directory')
                setSelected({ kind: 'actor', id: actorId })
              }}
            />
          ) : (
            <div className="flex h-full items-center justify-center px-6 text-center">
              <div className="max-w-sm">
                <div className="mx-auto mb-4 flex size-16 items-center justify-center rounded-full bg-muted text-muted-foreground">
                  {viewMode === 'packages' ? <Sparkles className="size-7" /> : <Users className="size-7" />}
                </div>
                <h2 className="text-lg font-semibold text-foreground">
                  {viewMode === 'packages' ? 'No package selected' : 'No contact selected'}
                </h2>
                <p className="mt-2 text-sm text-muted-foreground">
                  {viewMode === 'packages'
                    ? 'Choose an actor package to inspect its actor definition and install it into this workspace.'
                    : 'Choose a workspace user or actor from the list to inspect their profile.'}
                </p>
              </div>
            </div>
          )}
        </div>
      </div>

      <ActorEditorSheet
        open={editorOpen}
        onOpenChange={setEditorOpen}
        actor={editingActor}
        workspaceId={workspaceId}
        parentOptions={actors}
        onSaved={async (savedActor) => {
          if (!workspaceId) return
          await loadWorkspaceData(workspaceId)
          setSelected({ kind: 'actor', id: savedActor.id })
          setSelectedActorDetail(savedActor)
          try {
            const versions = await api.getActorVersions(workspaceId, savedActor.id)
            setSelectedActorVersions(Array.isArray(versions) ? (versions as ActorVersion[]) : [])
          } catch (error) {
            console.error('Failed to refresh actor versions:', error)
          }
        }}
      />
    </>
  )
}
