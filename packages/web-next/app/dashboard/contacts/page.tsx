'use client'

import { useRouter } from 'next/navigation'
import { useDeferredValue, useEffect, useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { extractText, type Actor, type ActorDoc, type ActorTemplateRecord, type ActorVersion } from '@synapse/shared'
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
  | { kind: 'template'; id: string }
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

function templateSummary(template: ActorTemplateRecord) {
  const actor = template.manifest.actor
  const docs = [...(actor.docs || [])].sort((left, right) => right.priority - left.priority)
  const summary = docs.map((doc) => summarizeDoc(doc, 140)).find(Boolean)
  return summary || template.package.description || actor.title || titleCase(actor.role)
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

function TemplateListItem({
  template,
  active,
  clonedCount,
  onSelect,
}: {
  template: ActorTemplateRecord
  active: boolean
  clonedCount: number
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
          <AvatarImage src={template.package.iconUrl || undefined} alt={template.package.displayName} />
          <AvatarFallback className="rounded-2xl bg-primary/10 text-primary">
            <Sparkles className="size-4" />
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <div className="truncate text-sm font-medium text-foreground">{template.package.displayName}</div>
            {clonedCount > 0 ? <Badge variant="secondary">{clonedCount} cloned</Badge> : null}
          </div>
          <div className="truncate text-sm text-muted-foreground">{templateSummary(template)}</div>
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
            {version.delta?.changedDocs?.length ? (
              <div className="mt-3 flex flex-wrap gap-2">
                {version.delta.changedDocs.map((doc) => (
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

            {actor.templateLink ? (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Template source</CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col gap-3 text-sm">
                  <div className="flex items-center justify-between gap-4">
                    <span className="text-muted-foreground">Source</span>
                    <span className="font-medium text-foreground">{actor.templateLink.templateDisplayName}</span>
                  </div>
                  <Separator />
                  <div className="flex items-center justify-between gap-4">
                    <span className="text-muted-foreground">Imported revision</span>
                    <span className="font-medium text-foreground">{actor.templateLink.importedTemplateVersion || 'Unknown'}</span>
                  </div>
                  <Separator />
                  <div className="flex items-center justify-between gap-4">
                    <span className="text-muted-foreground">Latest official revision</span>
                    <span className="font-medium text-foreground">{actor.templateLink.latestTemplateVersion || 'Unknown'}</span>
                  </div>
                  <Separator />
                  <div className="flex items-center justify-between gap-4">
                    <span className="text-muted-foreground">Sync status</span>
                    <Badge variant="outline">{titleCase(actor.templateLink.status.replace(/_/g, ' '))}</Badge>
                  </div>
                </CardContent>
              </Card>
            ) : null}

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Capabilities</CardTitle>
              </CardHeader>
              <CardContent>
                {definition.capabilities.length > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    {definition.capabilities.map((capability) => (
                      <Badge key={capability} variant="outline">
                        {capability}
                      </Badge>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">No structured capabilities configured.</p>
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

function TemplateDetail({
  template,
  linkedActors,
  loading,
  cloning,
  onClone,
  onOpenActor,
}: {
  template: ActorTemplateRecord | null
  linkedActors: Actor[]
  loading: boolean
  cloning: boolean
  onClone: () => void
  onOpenActor: (actorId: string) => void
}) {
  if (!template && loading) {
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

  if (!template) return null

  const actor = template.manifest.actor
  const docs = [...(actor.docs || [])]
    .filter((doc) => doc.content.length > 0)
    .sort((left, right) => right.priority - left.priority)
  const checksById = new Map((template.requirementChecks || []).map((check) => [check.requirementId, check]))

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-6 py-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-4">
            <Avatar className="size-16 rounded-3xl">
              <AvatarImage src={template.package.iconUrl || undefined} alt={template.package.displayName} />
              <AvatarFallback className="rounded-3xl bg-primary/10 text-primary">
                <Sparkles className="size-8" />
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-xl font-semibold text-foreground">{template.package.displayName}</h2>
                <Badge variant="secondary">Official template</Badge>
                {template.package.publisher?.displayName ? (
                  <Badge variant="outline">{template.package.publisher.displayName}</Badge>
                ) : null}
                {linkedActors.length > 0 ? <Badge variant="outline">{linkedActors.length} local copies</Badge> : null}
              </div>
              <p className="mt-1 text-sm text-muted-foreground">{actor.title || template.package.description}</p>
              <p className="mt-3 max-w-3xl text-sm text-muted-foreground">{templateSummary(template)}</p>
            </div>
          </div>

          <Button onClick={onClone} disabled={cloning}>
            <Plus data-icon="inline-start" />
            {cloning ? 'Cloning...' : 'Clone to workspace'}
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
                  <CardTitle className="text-base">Template docs</CardTitle>
                  <CardDescription>No actor docs were bundled with this template.</CardDescription>
                </CardHeader>
              </Card>
            )}

            {template.manifest.setupGuide.length > 0 ? (
              <ContentBlocksCard title="Setup Guide" blocks={template.manifest.setupGuide} badge="template" />
            ) : null}
            {template.manifest.releaseNotes.length > 0 ? (
              <ContentBlocksCard title="Release Notes" blocks={template.manifest.releaseNotes} badge="template" />
            ) : null}
          </div>

          <div className="flex flex-col gap-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Template package</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-3 text-sm">
                <div className="flex items-center justify-between gap-4">
                  <span className="text-muted-foreground">Version</span>
                  <span className="font-medium text-foreground">{template.package.latestRevision?.version || 'Unversioned'}</span>
                </div>
                <Separator />
                <div className="flex items-center justify-between gap-4">
                  <span className="text-muted-foreground">Actor role</span>
                  <span className="font-medium text-foreground">{titleCase(actor.role)}</span>
                </div>
                <Separator />
                <div className="flex items-center justify-between gap-4">
                  <span className="text-muted-foreground">Representation</span>
                  <span className="font-medium text-foreground">{actor.canRepresentUser ? 'Allowed by template' : 'Disabled by template'}</span>
                </div>
                <Separator />
                <div className="flex items-center justify-between gap-4">
                  <span className="text-muted-foreground">Published</span>
                  <span className="font-medium text-foreground">{formatDate(template.package.updatedAt)}</span>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Dependencies</CardTitle>
                <CardDescription>Template requirements are evaluated against the current workspace before and after cloning.</CardDescription>
              </CardHeader>
              <CardContent>
                {template.dependencies.length > 0 ? (
                  <div className="flex flex-col gap-3">
                    {template.dependencies.map((dependency) => {
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
                  <p className="text-sm text-muted-foreground">This template does not declare plugin or skill dependencies.</p>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Local copies</CardTitle>
              </CardHeader>
              <CardContent>
                {linkedActors.length > 0 ? (
                  <div className="flex flex-col gap-2">
                    {linkedActors.map((actorInstance) => (
                      <button
                        key={actorInstance.id}
                        onClick={() => onOpenActor(actorInstance.id)}
                        className="flex items-center justify-between rounded-2xl border border-border px-3 py-3 text-left transition-colors hover:bg-accent/60"
                      >
                        <div>
                          <div className="font-medium text-foreground">{actorInstance.definition.name}</div>
                          <div className="text-sm text-muted-foreground">
                            v{actorInstance.currentVersion}
                            {actorInstance.templateLink ? ` · ${titleCase(actorInstance.templateLink.status.replace(/_/g, ' '))}` : ''}
                          </div>
                        </div>
                        <Badge variant="outline">{actorInstance.definition.title || titleCase(actorInstance.definition.role)}</Badge>
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">No local copies yet. Clone this template to create a workspace actor.</p>
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
  const { workspaceId } = useWorkspace()
  const [members, setMembers] = useState<WorkspaceMember[]>([])
  const [actors, setActors] = useState<Actor[]>([])
  const [templates, setTemplates] = useState<ActorTemplateRecord[]>([])
  const [selected, setSelected] = useState<SelectedContact>(null)
  const [viewMode, setViewMode] = useState<'directory' | 'templates'>('directory')
  const [search, setSearch] = useState('')
  const deferredSearch = useDeferredValue(search)
  const [loading, setLoading] = useState(true)
  const [detailLoading, setDetailLoading] = useState(false)
  const [selectedActorDetail, setSelectedActorDetail] = useState<Actor | null>(null)
  const [selectedActorVersions, setSelectedActorVersions] = useState<ActorVersion[]>([])
  const [selectedTemplateDetail, setSelectedTemplateDetail] = useState<ActorTemplateRecord | null>(null)
  const [templateActionPending, setTemplateActionPending] = useState(false)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editingActor, setEditingActor] = useState<Actor | null>(null)

  async function loadWorkspaceData(currentWorkspaceId: string) {
    const [memberResponse, actorResponse, templateResponse] = await Promise.all([
      api.getWorkspaceMembers(currentWorkspaceId),
      api.getActors(currentWorkspaceId),
      api.getActorTemplates(currentWorkspaceId),
    ])

    const nextMembers = Array.isArray(memberResponse) ? memberResponse : (memberResponse?.data || [])
    const nextActors = Array.isArray(actorResponse) ? actorResponse : (actorResponse?.actors || [])
    const nextTemplates = Array.isArray(templateResponse) ? templateResponse : []

    setMembers(nextMembers)
    setActors(nextActors)
    setTemplates(nextTemplates)
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
    if (!workspaceId || selected?.kind !== 'template') {
      setSelectedTemplateDetail(null)
      setDetailLoading(false)
      return
    }

    const currentWorkspaceId = workspaceId
    const templateId = selected.id
    let cancelled = false

    async function loadTemplateDetails() {
      setDetailLoading(true)
      try {
        const template = await api.getActorTemplate(currentWorkspaceId, templateId)
        if (cancelled) return
        setSelectedTemplateDetail(template)
      } catch (error) {
        console.error('Failed to load actor template:', error)
      } finally {
        if (!cancelled) setDetailLoading(false)
      }
    }

    void loadTemplateDetails()

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

  const filteredTemplates = useMemo(() => {
    const needle = deferredSearch.trim().toLowerCase()
    if (!needle) return templates
    return templates.filter((template) => {
      const actor = template.manifest.actor
      const haystack = `${template.package.displayName} ${template.package.description} ${actor.name} ${actor.title} ${actor.role} ${templateSummary(template)}`.toLowerCase()
      return haystack.includes(needle)
    })
  }, [deferredSearch, templates])

  const selectedUser = selected?.kind === 'user'
    ? members.find((member) => member.userId === selected.id) || null
    : null
  const selectedActor = selected?.kind === 'actor'
    ? selectedActorDetail || actors.find((actor) => actor.id === selected.id) || null
    : null
  const selectedTemplate = selected?.kind === 'template'
    ? selectedTemplateDetail || templates.find((template) => template.package.id === selected.id) || null
    : null

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
                const nextMode = value as 'directory' | 'templates'
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
                    current?.kind === 'template'
                      ? current
                      : templates[0]?.package.id
                        ? { kind: 'template', id: templates[0].package.id }
                        : current
                  ))
                }
              }}
              className="mb-4 w-full"
            >
              <ToggleGroupItem value="directory" className="flex-1">
                Directory
              </ToggleGroupItem>
              <ToggleGroupItem value="templates" className="flex-1">
                Templates
              </ToggleGroupItem>
            </ToggleGroup>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={viewMode === 'templates' ? 'Search official templates...' : 'Search users and actors...'}
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
              viewMode === 'templates' ? (
                <div className="flex flex-col gap-2">
                  <div className="px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Official templates
                  </div>
                  {filteredTemplates.length > 0 ? (
                    filteredTemplates.map((template) => (
                      <TemplateListItem
                        key={template.package.id}
                        template={template}
                        active={selected?.kind === 'template' && selected.id === template.package.id}
                        clonedCount={actors.filter((actor) => actor.templateLink?.templatePackageId === template.package.id).length}
                        onSelect={() => setSelected({ kind: 'template', id: template.package.id })}
                      />
                    ))
                  ) : (
                    <p className="px-1 text-sm text-muted-foreground">No templates found.</p>
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
          ) : selectedTemplate && viewMode === 'templates' ? (
            <TemplateDetail
              template={selectedTemplate}
              linkedActors={actors.filter((actor) => actor.templateLink?.templatePackageId === selectedTemplate.package.id)}
              loading={detailLoading}
              cloning={templateActionPending}
              onClone={async () => {
                if (!workspaceId) return
                setTemplateActionPending(true)
                try {
                  const result = await api.cloneActorTemplate(workspaceId, selectedTemplate.package.id, {})
                  await loadWorkspaceData(workspaceId)
                  setViewMode('directory')
                  setSelected({ kind: 'actor', id: result.actor.id })
                  setSelectedActorDetail(result.actor)
                  try {
                    const versions = await api.getActorVersions(workspaceId, result.actor.id)
                    setSelectedActorVersions(Array.isArray(versions) ? (versions as ActorVersion[]) : [])
                  } catch (error) {
                    console.error('Failed to refresh cloned actor versions:', error)
                  }
                } catch (error) {
                  console.error('Failed to clone actor template:', error)
                } finally {
                  setTemplateActionPending(false)
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
                  {viewMode === 'templates' ? <Sparkles className="size-7" /> : <Users className="size-7" />}
                </div>
                <h2 className="text-lg font-semibold text-foreground">
                  {viewMode === 'templates' ? 'No template selected' : 'No contact selected'}
                </h2>
                <p className="mt-2 text-sm text-muted-foreground">
                  {viewMode === 'templates'
                    ? 'Choose an official template to inspect its actor definition and clone it into this workspace.'
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
