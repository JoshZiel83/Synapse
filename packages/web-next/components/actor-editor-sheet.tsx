'use client'

import { useEffect, useState } from 'react'
import {
  type Actor,
  type ActorDoc,
} from '@synapse/shared'
import { Loader2, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

import { api } from '@/lib/api'
import {
  ACTOR_ROLE_OPTIONS,
  VISIBILITY_OPTIONS,
  buildInitialState,
  editableDocToActorDoc,
  isCustomDocKey,
  splitList,
  type ActorFormState,
  type ActorRole,
  type ActorDocVisibility,
  type EditableDoc,
  type UploadedFile,
} from '@/components/actor-editor-model'
import { ActorDocCreateDialog } from '@/components/actor-doc-create-dialog'
import { CanonicalContentEditor } from '@/components/canonical-content-editor'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { resolveFileUrl } from '@/lib/utils'

export function ActorEditorSheet({
  open,
  onOpenChange,
  actor,
  workspaceId,
  parentOptions,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  actor?: Actor | null
  workspaceId: string | null
  parentOptions: Actor[]
  onSaved: (actor: Actor) => void | Promise<void>
}) {
  const [form, setForm] = useState<ActorFormState>(() => buildInitialState(actor))
  const [avatarUploading, setAvatarUploading] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [createDocDialogOpen, setCreateDocDialogOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    setForm(buildInitialState(actor))
  }, [actor, open])

  function updateDoc(docId: string, updater: (doc: EditableDoc) => EditableDoc) {
    setForm((current) => ({
      ...current,
      docs: current.docs.map((doc) => (doc.id === docId ? updater(doc) : doc)),
    }))
  }

  async function handleAvatarUpload(file: File) {
    if (!workspaceId) return
    setAvatarUploading(true)
    try {
      const uploaded = (await api.uploadFile(workspaceId, file)) as UploadedFile
      setForm((current) => ({
        ...current,
        avatarFileId: uploaded.id,
        avatarUrl: resolveFileUrl(uploaded.url || uploaded.fullUrl),
      }))
      toast.success('Avatar uploaded')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Avatar upload failed')
    } finally {
      setAvatarUploading(false)
    }
  }

  async function saveActor() {
    if (!workspaceId) return
    if (!form.name.trim()) {
      toast.error('Name is required')
      return
    }

    const docs = form.docs
      .map(editableDocToActorDoc)
      .filter((doc): doc is ActorDoc => !!doc)

    const payload = {
      name: form.name.trim(),
      role: form.role,
      title: form.title.trim(),
      avatarFileId: form.avatarFileId,
      parentId: form.parentId || undefined,
      canRepresentUser: form.canRepresentUser,
      docs,
      specialties: splitList(form.specialties),
    }

    setIsSaving(true)
    try {
      const saved = actor
        ? ((await api.updateActor(workspaceId, actor.id, payload)) as Actor)
        : ((await api.createActor(workspaceId, payload)) as Actor)

      toast.success(actor ? 'Actor updated' : 'Actor created')
      await onSaved(saved)
      onOpenChange(false)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to save actor')
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full p-0 sm:max-w-4xl">
        <SheetHeader className="border-b border-border">
          <SheetTitle>{actor ? `Edit ${actor.definition.name}` : 'Create actor'}</SheetTitle>
          <SheetDescription>
            Define the actor as a person with structured authority fields and editable narrative docs.
          </SheetDescription>
        </SheetHeader>

        <ScrollArea className="flex-1">
          <div className="flex flex-col gap-6 p-6">
            <Card>
              <CardHeader>
                <CardTitle>Core identity</CardTitle>
                <CardDescription>
                  These structured fields drive routing, hierarchy, and permission-aware behavior.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-6">
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor="actor-name">Name</FieldLabel>
                    <Input
                      id="actor-name"
                      value={form.name}
                      onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
                      placeholder="Alice"
                    />
                  </Field>

                  <FieldGroup className="md:grid md:grid-cols-2 md:gap-4">
                    <Field>
                      <FieldLabel>Role</FieldLabel>
                      <Select
                        value={form.role}
                        onValueChange={(value) => setForm((current) => ({ ...current, role: value as ActorRole }))}
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder="Select a role" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            {ACTOR_ROLE_OPTIONS.map((role) => (
                              <SelectItem key={role} value={role}>
                                {role.replace(/_/g, ' ')}
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
                        onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))}
                        placeholder="Principal Researcher"
                      />
                    </Field>
                  </FieldGroup>

                  <FieldGroup className="md:grid md:grid-cols-2 md:gap-4">
                    <Field>
                      <FieldLabel>Reports to</FieldLabel>
                      <Select
                        value={form.parentId || 'none'}
                        onValueChange={(value) => setForm((current) => ({ ...current, parentId: value === 'none' ? null : value }))}
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder="No manager" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            <SelectItem value="none">No manager</SelectItem>
                            {parentOptions
                              .filter((option) => option.id !== actor?.id)
                              .map((option) => (
                                <SelectItem key={option.id} value={option.id}>
                                  {option.definition.name} · {option.definition.title || option.definition.role}
                                </SelectItem>
                              ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    </Field>

                    <Field orientation="horizontal" className="items-start rounded-2xl border border-border p-4">
                      <FieldContent>
                        <FieldLabel htmlFor="represent-user">Can represent user</FieldLabel>
                        <FieldDescription>
                          Hard switch. The permission system still decides what is actually allowed at runtime.
                        </FieldDescription>
                      </FieldContent>
                      <Switch
                        id="represent-user"
                        checked={form.canRepresentUser}
                        onCheckedChange={(checked) => setForm((current) => ({ ...current, canRepresentUser: checked }))}
                      />
                    </Field>
                  </FieldGroup>

                  <Field>
                    <FieldLabel htmlFor="actor-avatar">Avatar file</FieldLabel>
                    <div className="flex flex-col gap-3 rounded-2xl border border-dashed border-border p-4">
                      {form.avatarUrl ? (
                        <img
                          src={resolveFileUrl(form.avatarUrl)}
                          alt={form.name || 'Actor avatar'}
                          className="size-20 rounded-2xl object-cover"
                        />
                      ) : (
                        <div className="flex size-20 items-center justify-center rounded-2xl bg-muted text-xs text-muted-foreground">
                          No avatar
                        </div>
                      )}
                      <div className="flex flex-wrap items-center gap-3">
                        <Input
                          id="actor-avatar"
                          type="file"
                          accept="image/*"
                          onChange={(event) => {
                            const file = event.target.files?.[0]
                            if (file) {
                              void handleAvatarUpload(file)
                            }
                            event.target.value = ''
                          }}
                        />
                        {avatarUploading ? (
                          <div className="flex items-center gap-2 text-sm text-muted-foreground">
                            <Loader2 className="size-4 animate-spin" />
                            Uploading avatar...
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </Field>
                </FieldGroup>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Specialties</CardTitle>
                <CardDescription>
                  Structured specialties stay machine-readable. Installable skills are managed separately.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Field>
                  <FieldLabel htmlFor="actor-specialties">Specialties</FieldLabel>
                  <Textarea
                    id="actor-specialties"
                    value={form.specialties}
                    onChange={(event) => setForm((current) => ({ ...current, specialties: event.target.value }))}
                    placeholder="code.review, research, incident.response"
                    rows={3}
                  />
                  <FieldDescription>Comma or newline separated.</FieldDescription>
                </Field>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-start justify-between gap-4">
                <div>
                  <CardTitle>Profile documents</CardTitle>
                  <CardDescription>
                    Only existing docs are listed here. Add standard or custom sections explicitly when needed.
                  </CardDescription>
                </div>
                <Button type="button" variant="outline" onClick={() => setCreateDocDialogOpen(true)}>
                  <Plus data-icon="inline-start" />
                  Add doc
                </Button>
              </CardHeader>
              <CardContent>
                {form.docs.length > 0 ? (
                  <div className="flex flex-col gap-4">
                    {form.docs.map((doc) => (
                      <Card key={doc.id}>
                        <CardHeader>
                          <CardTitle className="text-sm">{doc.title}</CardTitle>
                          <CardDescription>{doc.description}</CardDescription>
                        </CardHeader>
                        <CardContent className="flex flex-col gap-4">
                          <FieldGroup className="md:grid md:grid-cols-[minmax(0,1fr)_140px_120px] md:gap-4">
                            <Field>
                              <FieldLabel>Section title</FieldLabel>
                              <Input
                                value={doc.title}
                                onChange={(event) => updateDoc(doc.id, (current) => ({ ...current, title: event.target.value }))}
                              />
                            </Field>

                            <Field>
                              <FieldLabel>Visibility</FieldLabel>
                              <Select
                                value={doc.visibility}
                                onValueChange={(value) =>
                                  updateDoc(doc.id, (current) => ({
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
                                  updateDoc(doc.id, (current) => ({
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
                            onChange={(blocks) => updateDoc(doc.id, (current) => ({ ...current, content: blocks }))}
                            placeholder="Write this actor the way you would describe a real person."
                          />

                          {isCustomDocKey(doc.key) ? (
                            <div>
                              <Button
                                type="button"
                                variant="outline"
                                onClick={() =>
                                  setForm((current) => ({
                                    ...current,
                                    docs: current.docs.filter((item) => item.id !== doc.id),
                                  }))
                                }
                              >
                                <Trash2 data-icon="inline-start" />
                                Remove custom section
                              </Button>
                            </div>
                          ) : null}
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                ) : (
                  <div className="rounded-3xl border border-dashed border-border p-6 text-sm text-muted-foreground">
                    No docs yet. Add a standard doc or a custom section to start defining this actor.
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </ScrollArea>

        <SheetFooter className="border-t border-border">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => void saveActor()}
            disabled={isSaving || avatarUploading}
          >
            {isSaving ? <Loader2 className="animate-spin" data-icon="inline-start" /> : null}
            {actor ? 'Save actor' : 'Create actor'}
          </Button>
        </SheetFooter>
      </SheetContent>

      <ActorDocCreateDialog
        open={createDocDialogOpen}
        onOpenChange={setCreateDocDialogOpen}
        docs={form.docs}
        onCreate={(doc) =>
          setForm((current) => ({
            ...current,
            docs: [...current.docs, doc].sort((left, right) => {
              if (right.priority !== left.priority) return right.priority - left.priority
              return left.title.localeCompare(right.title)
            }),
          }))
        }
      />
    </Sheet>
  )
}
