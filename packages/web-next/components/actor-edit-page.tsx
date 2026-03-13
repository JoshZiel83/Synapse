"use client"

import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { useEffect, useMemo, useState } from "react"
import { type Actor, type ActorDoc } from "@synapse/shared"
import {
  ArrowLeft,
  Bot,
  History,
  Loader2,
  Plus,
  Save,
  Trash2,
} from "lucide-react"
import { toast } from "sonner"

import { useWorkspace } from "@/app/dashboard/workspace-provider"
import {
  ACTOR_DOC_GROUPS,
  ACTOR_ROLE_OPTIONS,
  VISIBILITY_OPTIONS,
  buildInitialState,
  editableDocToActorDoc,
  formatDate,
  isCustomDocKey,
  splitList,
  summarizeDoc,
  titleCase,
  type ActorDocVisibility,
  type ActorFormState,
  type ActorRole,
  type EditableDoc,
  type UploadedFile,
} from "@/components/actor-editor-model"
import { ActorDocCreateDialog } from "@/components/actor-doc-create-dialog"
import { CanonicalContentEditor } from "@/components/canonical-content-editor"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { api } from "@/lib/api"
import { resolveFileUrl } from "@/lib/utils"

const BASIC_SECTION_KEY = "basic"

function buildSectionHref(actorId: string, sectionKey: string) {
  return `/dashboard/actors/${actorId}/edit?section=${encodeURIComponent(sectionKey)}`
}

function SectionListItem({
  active,
  title,
  subtitle,
  badge,
  onSelect,
}: {
  active: boolean
  title: string
  subtitle: string
  badge?: string
  onSelect: () => void
}) {
  return (
    <button
      onClick={onSelect}
      className={`w-full overflow-hidden rounded-3xl border px-4 py-3 text-left transition-colors ${
        active ? "border-primary bg-accent" : "border-transparent hover:bg-accent/60"
      }`}
      title={subtitle}
    >
      <div className="flex flex-col gap-1">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{title}</div>
          {badge ? <Badge variant="outline" className="shrink-0">{badge}</Badge> : null}
        </div>
        <div className="truncate text-sm text-muted-foreground">{subtitle}</div>
      </div>
    </button>
  )
}

function BasicSection({
  actor,
  form,
  updateForm,
  parentOptions,
  avatarUploading,
  onAvatarUpload,
}: {
  actor: Actor
  form: ActorFormState
  updateForm: (updater: (current: ActorFormState) => ActorFormState) => void
  parentOptions: Actor[]
  avatarUploading: boolean
  onAvatarUpload: (file: File) => Promise<void>
}) {
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Core identity</CardTitle>
          <CardDescription>
            Stable fields for identity, hierarchy, and permission-aware behavior.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="actor-name">Name</FieldLabel>
              <Input
                id="actor-name"
                value={form.name}
                onChange={(event) => updateForm((current) => ({ ...current, name: event.target.value }))}
                placeholder="Alice"
              />
            </Field>

            <FieldGroup className="md:grid md:grid-cols-2 md:gap-4">
              <Field>
                <FieldLabel>Role</FieldLabel>
                <Select
                  value={form.role}
                  onValueChange={(value) => updateForm((current) => ({ ...current, role: value as ActorRole }))}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select a role" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {ACTOR_ROLE_OPTIONS.map((role) => (
                        <SelectItem key={role} value={role}>
                          {titleCase(role)}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>

              <Field>
                <FieldLabel htmlFor="actor-title">Title</FieldLabel>
                <Input
                  id="actor-title"
                  value={form.title}
                  onChange={(event) => updateForm((current) => ({ ...current, title: event.target.value }))}
                  placeholder="Principal Researcher"
                />
              </Field>
            </FieldGroup>

            <FieldGroup className="md:grid md:grid-cols-2 md:gap-4">
              <Field>
                <FieldLabel>Reports to</FieldLabel>
                <Select
                  value={form.parentId || "none"}
                  onValueChange={(value) =>
                    updateForm((current) => ({ ...current, parentId: value === "none" ? null : value }))
                  }
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="No manager" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="none">No manager</SelectItem>
                      {parentOptions
                        .filter((option) => option.id !== actor.id)
                        .map((option) => (
                          <SelectItem key={option.id} value={option.id}>
                            {option.definition.name} · {option.definition.title || titleCase(option.definition.role)}
                          </SelectItem>
                        ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>

              <Field orientation="horizontal" className="items-start rounded-3xl border border-border p-4">
                <FieldContent>
                  <FieldLabel htmlFor="represent-user">Can represent user</FieldLabel>
                  <FieldDescription>
                    Hard switch. The permission system still decides what is allowed at runtime.
                  </FieldDescription>
                </FieldContent>
                <Switch
                  id="represent-user"
                  checked={form.canRepresentUser}
                  onCheckedChange={(checked) => updateForm((current) => ({ ...current, canRepresentUser: checked }))}
                />
              </Field>
            </FieldGroup>
          </FieldGroup>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Avatar and capability metadata</CardTitle>
          <CardDescription>
            Structured metadata stays machine-readable. Installable skills still belong to the capability system.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-6 xl:grid-cols-[280px_minmax(0,1fr)]">
          <div className="rounded-[28px] border border-dashed border-border p-4">
            <div className="mb-4 flex items-center gap-4">
              <Avatar className="size-20 rounded-3xl">
                <AvatarImage src={resolveFileUrl(form.avatarUrl) || undefined} alt={form.name || actor.definition.name} />
                <AvatarFallback className="rounded-3xl bg-primary/10 text-primary">
                  <Bot className="size-8" />
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-foreground">{form.name || "Unnamed actor"}</div>
                <div className="text-sm text-muted-foreground">{form.title || titleCase(form.role)}</div>
              </div>
            </div>
            <Input
              id="actor-avatar"
              type="file"
              accept="image/*"
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) {
                  void onAvatarUpload(file)
                }
                event.target.value = ""
              }}
            />
            {avatarUploading ? (
              <div className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                Uploading avatar...
              </div>
            ) : null}
          </div>

          <Field>
            <FieldLabel htmlFor="actor-capabilities">Capabilities</FieldLabel>
            <Textarea
              id="actor-capabilities"
              rows={3}
              value={form.capabilities}
              onChange={(event) => updateForm((current) => ({ ...current, capabilities: event.target.value }))}
              placeholder="code.review, research, incident.response"
            />
            <FieldDescription>Comma or newline separated.</FieldDescription>
          </Field>
        </CardContent>
      </Card>

      {actor.templateLink ? (
        <Card>
          <CardHeader>
            <CardTitle>Template source</CardTitle>
            <CardDescription>This actor was cloned from an official template and can receive upgrade notices.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 text-sm md:grid-cols-2">
            <div className="rounded-2xl border border-border p-4">
              <div className="text-xs uppercase tracking-wide text-muted-foreground">Source</div>
              <div className="mt-2 font-medium text-foreground">{actor.templateLink.templateDisplayName}</div>
            </div>
            <div className="rounded-2xl border border-border p-4">
              <div className="text-xs uppercase tracking-wide text-muted-foreground">Sync status</div>
              <div className="mt-2">
                <Badge variant="outline">{titleCase(actor.templateLink.status.replace(/_/g, " "))}</Badge>
              </div>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Current profile preview</CardTitle>
          <CardDescription>This is the same definition summary other surfaces currently see.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="rounded-[28px] border border-border bg-muted/20 p-5">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <Badge variant="secondary">{titleCase(form.role)}</Badge>
              <Badge variant="outline">v{actor.currentVersion}</Badge>
              {form.canRepresentUser ? <Badge variant="outline">Can represent user</Badge> : null}
            </div>
            <p className="text-sm text-muted-foreground">
              {form.title || "No title set"} · Updated {formatDate(actor.updatedAt)}
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

function DocSection({
  doc,
  workspaceId,
  onChange,
  onRemove,
}: {
  doc: EditableDoc
  workspaceId: string | null
  onChange: (updater: (doc: EditableDoc) => EditableDoc) => void
  onRemove: () => void
}) {
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div>
            <CardTitle>{doc.title}</CardTitle>
            <CardDescription>{doc.description}</CardDescription>
          </div>
          <Badge variant="outline">{doc.visibility.replace(/_/g, " ")}</Badge>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          <FieldGroup className="md:grid md:grid-cols-[minmax(0,1fr)_140px_120px] md:gap-4">
            <Field>
              <FieldLabel>Section title</FieldLabel>
              <Input value={doc.title} onChange={(event) => onChange((current) => ({ ...current, title: event.target.value }))} />
            </Field>

            <Field>
              <FieldLabel>Visibility</FieldLabel>
              <Select
                value={doc.visibility}
                onValueChange={(value) =>
                  onChange((current) => ({
                    ...current,
                    visibility: value as ActorDocVisibility,
                  }))
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {VISIBILITY_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>

            <Field>
              <FieldLabel>Priority</FieldLabel>
              <Input
                type="number"
                value={String(doc.priority)}
                onChange={(event) =>
                  onChange((current) => ({
                    ...current,
                    priority: Number(event.target.value || 0),
                  }))
                }
              />
            </Field>
          </FieldGroup>

          <CanonicalContentEditor
            workspaceId={workspaceId}
            value={doc.content}
            onChange={(blocks) => onChange((current) => ({ ...current, content: blocks }))}
            placeholder="Write this actor the way you would describe a real person."
          />
        </CardContent>
      </Card>

      {isCustomDocKey(doc.key) ? (
        <Card>
          <CardHeader>
            <CardTitle>Custom section controls</CardTitle>
            <CardDescription>Remove this section if it no longer belongs in the actor definition.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button type="button" variant="outline" onClick={onRemove}>
              <Trash2 data-icon="inline-start" />
              Remove custom section
            </Button>
          </CardContent>
        </Card>
      ) : null}
    </div>
  )
}

export function ActorEditPage({ actorId }: { actorId: string }) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { workspaceId } = useWorkspace()

  const [actor, setActor] = useState<Actor | null>(null)
  const [actors, setActors] = useState<Actor[]>([])
  const [form, setForm] = useState<ActorFormState | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [avatarUploading, setAvatarUploading] = useState(false)
  const [createDocDialogOpen, setCreateDocDialogOpen] = useState(false)

  useEffect(() => {
    if (!workspaceId) return
    const currentWorkspaceId = workspaceId
    let cancelled = false

    async function load() {
      setLoading(true)
      try {
        const [actorResponse, actorsResponse] = await Promise.all([
          api.getActor(currentWorkspaceId, actorId),
          api.getActors(currentWorkspaceId),
        ])
        if (cancelled) return
        const nextActor = actorResponse as Actor
        const actorList = Array.isArray(actorsResponse) ? (actorsResponse as Actor[]) : []
        setActor(nextActor)
        setActors(actorList)
        setForm(buildInitialState(nextActor))
      } catch (error) {
        console.error("Failed to load actor editor:", error)
        if (!cancelled) {
          toast.error(error instanceof Error ? error.message : "Failed to load actor")
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

  const sectionKey = searchParams.get("section") || BASIC_SECTION_KEY

  const sectionItems = useMemo(() => {
    if (!form) return []
    return [
      {
        key: BASIC_SECTION_KEY,
        title: "Basic information",
        subtitle: `${form.title || titleCase(form.role)} · ${splitList(form.capabilities).length} capabilities`,
        badge: "core",
      },
      ...form.docs.map((doc) => ({
        key: doc.id,
        title: doc.title,
        subtitle: summarizeDoc({ content: doc.content }, 120) || doc.description,
        badge: doc.visibility.replace(/_/g, " "),
      })),
    ]
  }, [form])

  const currentSummary = useMemo(() => {
    if (!form) return ""
    return (
      form.docs
        .slice()
        .sort((left, right) => right.priority - left.priority)
        .map((doc) => summarizeDoc({ content: doc.content }, 140))
        .find(Boolean) ||
      form.title ||
      titleCase(form.role)
    )
  }, [form])

  useEffect(() => {
    if (!form) return
    const keys = new Set(sectionItems.map((item) => item.key))
    if (!keys.has(sectionKey)) {
      router.replace(buildSectionHref(actorId, BASIC_SECTION_KEY))
    }
  }, [actorId, form, router, sectionItems, sectionKey])

  async function handleAvatarUpload(file: File) {
    if (!workspaceId) return
    setAvatarUploading(true)
    try {
      const uploaded = (await api.uploadFile(workspaceId, file)) as UploadedFile
      setForm((current) =>
        current
          ? {
              ...current,
              avatarFileId: uploaded.id,
              avatarUrl: resolveFileUrl(uploaded.url || uploaded.fullUrl),
            }
          : current,
      )
      toast.success("Avatar uploaded")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Avatar upload failed")
    } finally {
      setAvatarUploading(false)
    }
  }

  function updateDoc(docId: string, updater: (doc: EditableDoc) => EditableDoc) {
    setForm((current) =>
      current
        ? {
            ...current,
            docs: current.docs.map((doc) => (doc.id === docId ? updater(doc) : doc)),
          }
        : current,
    )
  }

  async function saveActor() {
    if (!workspaceId || !actor || !form) return
    if (!form.name.trim()) {
      toast.error("Name is required")
      return
    }

    const docs = form.docs.map(editableDocToActorDoc).filter((doc): doc is ActorDoc => !!doc)
    const payload = {
      name: form.name.trim(),
      role: form.role,
      title: form.title.trim(),
      avatarFileId: form.avatarFileId,
      parentId: form.parentId || undefined,
      canRepresentUser: form.canRepresentUser,
      docs,
      capabilities: splitList(form.capabilities),
    }

    setSaving(true)
    try {
      const saved = (await api.updateActor(workspaceId, actor.id, payload)) as Actor
      setActor(saved)
      setForm(buildInitialState(saved))
      setActors((current) => current.map((item) => (item.id === saved.id ? saved : item)))
      toast.success("Actor updated")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to save actor")
    } finally {
      setSaving(false)
    }
  }

  if (loading || !form) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Loading actor editor...
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
            <CardDescription>This actor is unavailable in the current workspace.</CardDescription>
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

  const selectedDoc = sectionKey === BASIC_SECTION_KEY ? null : form.docs.find((doc) => doc.id === sectionKey) || null

  return (
    <div className="flex h-full min-h-0 overflow-hidden">
      <div className="flex min-h-0 min-w-0 w-[360px] max-w-[360px] basis-[360px] shrink-0 flex-col overflow-hidden border-r border-border bg-muted/20">
        <div className="border-b border-border px-4 py-4">
          <div className="flex items-start gap-3 rounded-[28px] border border-border bg-background p-4">
            <Avatar className="size-14 rounded-3xl">
              <AvatarImage src={resolveFileUrl(form.avatarUrl || actor.avatarUrl) || undefined} alt={form.name} />
              <AvatarFallback className="rounded-3xl bg-primary/10 text-primary">
                <Bot className="size-6" />
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <div className="truncate text-base font-semibold text-foreground">{form.name}</div>
                <Badge variant="secondary">{titleCase(form.role)}</Badge>
              </div>
              <div className="mt-1 text-sm text-muted-foreground">{form.title || "No title set"}</div>
              <div className="mt-2 line-clamp-2 break-all text-sm text-muted-foreground">{currentSummary}</div>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href="/dashboard/contacts">
                <ArrowLeft data-icon="inline-start" />
                Back
              </Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link href={`/dashboard/actors/${actor.id}/history`}>
                <History data-icon="inline-start" />
                History
              </Link>
            </Button>
            <Button size="sm" variant="outline" onClick={() => setCreateDocDialogOpen(true)}>
              <Plus data-icon="inline-start" />
              Add doc
            </Button>
          </div>
        </div>

        <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto p-3">
          <div className="flex w-full min-w-0 max-w-full flex-col gap-6">
            <div className="flex flex-col gap-2">
              <div className="px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Structure</div>
              {sectionItems
                .filter((item) => item.key === BASIC_SECTION_KEY)
                .map((item) => (
                  <SectionListItem
                    key={item.key}
                    active={sectionKey === item.key}
                    title={item.title}
                    subtitle={item.subtitle}
                    badge={item.badge}
                    onSelect={() => router.replace(buildSectionHref(actor.id, item.key))}
                  />
                ))}
            </div>

            {ACTOR_DOC_GROUPS.map((group) => {
              const groupKeys = group.keys as readonly string[]
              const docs = form.docs.filter((doc) => groupKeys.includes(doc.key))
              if (docs.length === 0) return null
              return (
                <div key={group.value} className="flex flex-col gap-2">
                  <div className="px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{group.label}</div>
                  {docs.map((doc) => (
                    <SectionListItem
                      key={doc.id}
                      active={sectionKey === doc.id}
                      title={doc.title}
                      subtitle={summarizeDoc({ content: doc.content }, 120) || doc.description}
                      badge={doc.visibility.replace(/_/g, " ")}
                      onSelect={() => router.replace(buildSectionHref(actor.id, doc.id))}
                    />
                  ))}
                </div>
              )
            })}

            {form.docs.some((doc) => isCustomDocKey(doc.key)) ? (
              <div className="flex flex-col gap-2">
                <div className="px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Custom</div>
                {form.docs
                  .filter((doc) => isCustomDocKey(doc.key))
                  .map((doc) => (
                    <SectionListItem
                      key={doc.id}
                      active={sectionKey === doc.id}
                      title={doc.title}
                      subtitle={summarizeDoc({ content: doc.content }, 120) || doc.description}
                      badge={doc.visibility.replace(/_/g, " ")}
                      onSelect={() => router.replace(buildSectionHref(actor.id, doc.id))}
                    />
                  ))}
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <div className="min-w-0 flex-1 bg-background">
        <div className="flex h-full flex-col">
          <div className="border-b border-border px-6 py-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="text-2xl font-semibold text-foreground">
                    {selectedDoc ? selectedDoc.title : "Edit actor"}
                  </h1>
                  <Badge variant="outline">v{actor.currentVersion}</Badge>
                  {avatarUploading ? <Badge variant="outline">Uploading avatar</Badge> : null}
                </div>
                <p className="mt-2 text-sm text-muted-foreground">
                  {selectedDoc
                    ? "Narrative sections participate directly in context construction."
                    : "Structured fields define identity, hierarchy, and hard switches."}
                </p>
              </div>

              <Button onClick={() => void saveActor()} disabled={saving || avatarUploading}>
                {saving ? <Loader2 className="animate-spin" data-icon="inline-start" /> : <Save data-icon="inline-start" />}
                Save changes
              </Button>
            </div>
          </div>

          <ScrollArea className="min-h-0 flex-1">
            <div className="p-6">
              {selectedDoc ? (
                <DocSection
                  doc={selectedDoc}
                  workspaceId={workspaceId}
                  onChange={(updater) => updateDoc(selectedDoc.id, updater)}
                  onRemove={() => {
                    setForm((current) =>
                      current
                        ? {
                            ...current,
                            docs: current.docs.filter((item) => item.id !== selectedDoc.id),
                          }
                        : current,
                    )
                    router.replace(buildSectionHref(actor.id, BASIC_SECTION_KEY))
                  }}
                />
              ) : (
                <BasicSection
                  actor={actor}
                  form={form}
                  updateForm={(updater) =>
                    setForm((current) => (current ? updater(current) : current))
                  }
                  parentOptions={actors}
                  avatarUploading={avatarUploading}
                  onAvatarUpload={handleAvatarUpload}
                />
              )}
            </div>
          </ScrollArea>
        </div>
      </div>

      <ActorDocCreateDialog
        open={createDocDialogOpen}
        onOpenChange={setCreateDocDialogOpen}
        docs={form.docs}
        onCreate={(doc) => {
          setForm((current) =>
            current
              ? {
                  ...current,
                  docs: [...current.docs, doc].sort((left, right) => {
                    if (right.priority !== left.priority) return right.priority - left.priority
                    return left.title.localeCompare(right.title)
                  }),
                }
              : current,
          )
          router.replace(buildSectionHref(actor.id, doc.id))
        }}
      />
    </div>
  )
}
