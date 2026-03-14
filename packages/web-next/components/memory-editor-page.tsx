"use client"

import { useEffect, useMemo, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { ArrowLeft, Save, Trash2 } from "lucide-react"
import { toast } from "sonner"

import { useWorkspace } from "@/app/dashboard/workspace-provider"
import {
  buildMemoryPayload,
  createDraftState,
  createEditorStateFromMemory,
  hasMeaningfulBlocks,
  normalizeActorOption,
  normalizeGroupOption,
  serializeEditorState,
  type EditorState,
  type Memory,
  type MemoryScope,
} from "@/components/memory-browser-model"
import { CanonicalContentEditor } from "@/components/canonical-content-editor"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { api } from "@/lib/api"
import { useAuthStore } from "@/stores/auth-store"

function isMemoryScope(value: string | null): value is MemoryScope {
  return value === "workspace" || value === "user" || value === "conversation" || value === "actor_global" || value === "actor_conversation"
}

export default function MemoryEditorPage({ memoryId }: { memoryId?: string }) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { workspaceId } = useWorkspace()
  const { user } = useAuthStore()
  const currentUserId = user?.id || user?.userId || ""
  const currentUserLabel = user?.name || user?.email || "Me"

  const returnTo = searchParams.get("returnTo") || "/dashboard/memories"

  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [baselineSignature, setBaselineSignature] = useState("")
  const [actors, setActors] = useState<any[]>([])
  const [groups, setGroups] = useState<any[]>([])
  const [memory, setMemory] = useState<Memory | null>(null)
  const [activeTab, setActiveTab] = useState<"content" | "location" | "attributes" | "grants">("content")

  useEffect(() => {
    if (!workspaceId) return
    void loadPage()
  }, [memoryId, workspaceId])

  async function loadPage() {
    if (!workspaceId) return
    setLoading(true)
    try {
      const [actorData, groupData, memoryData] = await Promise.all([
        api.getActors(workspaceId),
        api.getGroups(workspaceId),
        memoryId ? api.getMemory(workspaceId, memoryId) : Promise.resolve(null),
      ])

      const actorItems = (Array.isArray(actorData) ? actorData : []).map(normalizeActorOption)
      const groupItems = (Array.isArray(groupData) ? groupData : groupData?.groups || []).map(normalizeGroupOption)
      setActors(actorItems)
      setGroups(groupItems)

      if (memoryId) {
        const nextMemory = (memoryData?.memory || memoryData) as Memory
        const nextEditor = createEditorStateFromMemory(nextMemory)
        setMemory(nextMemory)
        setEditor(nextEditor)
        setBaselineSignature(serializeEditorState(nextEditor))
      } else {
        const ownerScopeParam = searchParams.get("ownerScope")
        const nextEditor = createDraftState(
          {
            ownerScope: isMemoryScope(ownerScopeParam) ? ownerScopeParam : "workspace",
            ownerActorId: searchParams.get("ownerActorId") || undefined,
            ownerConversationId: searchParams.get("ownerConversationId") || undefined,
            ownerUserId: searchParams.get("ownerUserId") || currentUserId || undefined,
          },
          currentUserId,
        )
        setMemory(null)
        setEditor(nextEditor)
        setBaselineSignature(serializeEditorState(nextEditor))
      }
    } catch (error) {
      console.error("Failed to load memory editor:", error)
      toast.error(error instanceof Error ? error.message : "Failed to load memory")
    } finally {
      setLoading(false)
    }
  }

  const dirty = useMemo(
    () => serializeEditorState(editor) !== baselineSignature,
    [baselineSignature, editor],
  )

  function updateEditor(updater: (current: EditorState) => EditorState) {
    setEditor((current) => (current ? updater(current) : current))
  }

  function leavePage() {
    if (dirty && !window.confirm("Discard unsaved memory changes?")) {
      return
    }
    router.push(returnTo)
  }

  async function saveMemory() {
    if (!workspaceId || !editor) return
    if (!hasMeaningfulBlocks(editor.contentBlocks) && !editor.textDigest.trim()) {
      toast.error("Add at least one non-empty block or a text digest before saving.")
      return
    }

    setSaving(true)
    try {
      const payload = buildMemoryPayload(editor)
      const result = editor.mode === "create"
        ? await api.createMemory(workspaceId, payload)
        : await api.updateMemory(workspaceId, editor.id!, payload)
      const savedMemory = (result?.memory || result) as Memory

      if (editor.mode === "create") {
        toast.success("Memory created")
        router.push(`/dashboard/memories/${savedMemory.id}?returnTo=${encodeURIComponent(returnTo)}`)
        return
      }

      const nextEditor = createEditorStateFromMemory(savedMemory)
      setMemory(savedMemory)
      setEditor(nextEditor)
      setBaselineSignature(serializeEditorState(nextEditor))
      toast.success("Memory updated")
    } catch (error) {
      console.error("Failed to save memory:", error)
      toast.error(error instanceof Error ? error.message : "Failed to save memory")
    } finally {
      setSaving(false)
    }
  }

  async function deleteMemory() {
    if (!workspaceId || !editor?.id) return
    if (!window.confirm("Delete this memory?")) return

    try {
      await api.deleteMemory(workspaceId, editor.id)
      toast.success("Memory deleted")
      router.push(returnTo)
    } catch (error) {
      console.error("Failed to delete memory:", error)
      toast.error(error instanceof Error ? error.message : "Failed to delete memory")
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 px-3 py-3 sm:px-4 lg:px-6">
        <div className="flex items-center gap-3">
          <Button type="button" variant="outline" size="sm" onClick={leavePage}>
            <ArrowLeft data-icon="inline-start" />
            Back
          </Button>
          {memoryId ? (
            <div className="flex flex-col gap-1">
              <div className="text-xl font-semibold text-foreground">Edit Memory</div>
              <div className="text-sm text-muted-foreground">Edit one memory as ordered blocks.</div>
            </div>
          ) : null}
        </div>

        {editor ? (
          <div className="flex items-center gap-2">
            {memoryId ? (
              <Button type="button" variant="outline" size="sm" onClick={deleteMemory} disabled={saving}>
                <Trash2 data-icon="inline-start" />
                Delete
              </Button>
            ) : null}
            <Button type="button" size="sm" onClick={saveMemory} disabled={saving}>
              <Save data-icon="inline-start" />
              {saving ? "Saving..." : "Save"}
            </Button>
          </div>
        ) : null}
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="px-3 pb-6 pt-2 sm:px-4 sm:pt-3 lg:px-6">
        {loading || !editor ? (
          <Card className="rounded-[28px]">
            <CardContent className="px-6 py-10 text-sm text-muted-foreground">Loading memory editor...</CardContent>
          </Card>
        ) : (
          <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as typeof activeTab)} className="flex flex-col gap-4">
            <TabsList className="w-full justify-start">
              <TabsTrigger value="content">Content</TabsTrigger>
              <TabsTrigger value="location">Location</TabsTrigger>
              <TabsTrigger value="attributes">Attributes</TabsTrigger>
              <TabsTrigger value="grants">Grants</TabsTrigger>
            </TabsList>

            <TabsContent value="content" className="mt-0">
              <Card className="rounded-[28px]">
                <CardContent>
                  <CanonicalContentEditor
                    workspaceId={workspaceId || null}
                    value={editor.contentBlocks}
                    onChange={(blocks) => updateEditor((current) => ({ ...current, contentBlocks: blocks }))}
                    label="Edit Memory Content"
                    description={null}
                    showCount={false}
                  />
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="location" className="mt-0">
              <Card className="rounded-[28px]">
                <CardHeader>
                  <CardTitle>Location</CardTitle>
                  <CardDescription>Choose which folder this memory belongs to.</CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-6">
                  <Field>
                    <FieldLabel>Owner scope</FieldLabel>
                    <Select
                      value={editor.ownerScope}
                      onValueChange={(value) =>
                        updateEditor((current) => ({
                          ...current,
                          ownerScope: value as MemoryScope,
                          ownerActorId: value === "actor_global" || value === "actor_conversation" ? current.ownerActorId : "",
                          ownerConversationId: value === "conversation" || value === "actor_conversation" ? current.ownerConversationId : "",
                          ownerUserId: value === "user" ? current.ownerUserId || currentUserId : current.ownerUserId,
                        }))
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectItem value="workspace">Workspace</SelectItem>
                          <SelectItem value="user">User</SelectItem>
                          <SelectItem value="conversation">Conversation</SelectItem>
                          <SelectItem value="actor_global">Actor</SelectItem>
                          <SelectItem value="actor_conversation">Actor + Conversation</SelectItem>
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </Field>

                  {(editor.ownerScope === "actor_global" || editor.ownerScope === "actor_conversation") ? (
                    <Field>
                      <FieldLabel>Actor</FieldLabel>
                      <Select
                        value={editor.ownerActorId}
                        onValueChange={(value) => updateEditor((current) => ({ ...current, ownerActorId: value }))}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Select an actor" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            {actors.map((actor) => (
                              <SelectItem key={actor.id} value={actor.id}>
                                {actor.name}{actor.title ? ` · ${actor.title}` : ""}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    </Field>
                  ) : null}

                  {(editor.ownerScope === "conversation" || editor.ownerScope === "actor_conversation") ? (
                    <Field>
                      <FieldLabel>Conversation</FieldLabel>
                      <Select
                        value={editor.ownerConversationId}
                        onValueChange={(value) => updateEditor((current) => ({ ...current, ownerConversationId: value }))}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Select a conversation" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            {groups.map((group) => (
                              <SelectItem key={group.id} value={group.id}>
                                {group.title}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    </Field>
                  ) : null}

                  {editor.ownerScope === "user" ? (
                    <Field>
                      <FieldLabel>User folder</FieldLabel>
                      <Input value={currentUserLabel} disabled />
                      <FieldDescription>User-scoped memories stay under your personal folder.</FieldDescription>
                    </Field>
                  ) : null}
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="attributes" className="mt-0">
              <Card className="rounded-[28px]">
                <CardHeader>
                  <CardTitle>Attributes</CardTitle>
                  <CardDescription>These values affect recall and memory lifecycle.</CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-6">
                  <Field>
                    <FieldLabel>Text digest</FieldLabel>
                    <Input
                      value={editor.textDigest}
                      onChange={(event) => updateEditor((current) => ({ ...current, textDigest: event.target.value }))}
                      placeholder="Short summary for list views"
                    />
                  </Field>

                  <FieldGroup className="md:grid md:grid-cols-3">
                    <Field>
                      <FieldLabel>Category</FieldLabel>
                      <Select
                        value={editor.category}
                        onValueChange={(value) => updateEditor((current) => ({ ...current, category: value as typeof current.category }))}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            <SelectItem value="fact">Fact</SelectItem>
                            <SelectItem value="preference">Preference</SelectItem>
                            <SelectItem value="decision">Decision</SelectItem>
                            <SelectItem value="relationship">Relationship</SelectItem>
                            <SelectItem value="procedure">Procedure</SelectItem>
                            <SelectItem value="artifact">Artifact</SelectItem>
                            <SelectItem value="summary">Summary</SelectItem>
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    </Field>

                    <Field>
                      <FieldLabel>Status</FieldLabel>
                      <Select
                        value={editor.status}
                        onValueChange={(value) => updateEditor((current) => ({ ...current, status: value as typeof current.status }))}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            <SelectItem value="candidate">Candidate</SelectItem>
                            <SelectItem value="established">Established</SelectItem>
                            <SelectItem value="superseded">Superseded</SelectItem>
                            <SelectItem value="retracted">Retracted</SelectItem>
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    </Field>

                    <Field>
                      <FieldLabel>Stability</FieldLabel>
                      <Select
                        value={editor.stability}
                        onValueChange={(value) => updateEditor((current) => ({ ...current, stability: value as typeof current.stability }))}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            <SelectItem value="durable">Durable</SelectItem>
                            <SelectItem value="ephemeral">Ephemeral</SelectItem>
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    </Field>
                  </FieldGroup>

                  <FieldGroup className="md:grid md:grid-cols-2">
                    <Field>
                      <FieldLabel>Importance</FieldLabel>
                      <Input
                        type="number"
                        min={0}
                        max={1}
                        step={0.05}
                        value={String(editor.importance)}
                        onChange={(event) => updateEditor((current) => ({ ...current, importance: Number(event.target.value || 0) }))}
                      />
                    </Field>

                    <Field>
                      <FieldLabel>Confidence</FieldLabel>
                      <Input
                        type="number"
                        min={0}
                        max={1}
                        step={0.05}
                        value={String(editor.confidence)}
                        onChange={(event) => updateEditor((current) => ({ ...current, confidence: Number(event.target.value || 0) }))}
                      />
                    </Field>
                  </FieldGroup>

                  <Field>
                    <FieldLabel>Tags</FieldLabel>
                    <Input
                      value={editor.tags}
                      onChange={(event) => updateEditor((current) => ({ ...current, tags: event.target.value }))}
                      placeholder="comma, separated, tags"
                    />
                  </Field>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="grants" className="mt-0">
              <Card className="rounded-[28px]">
                <CardHeader>
                  <CardTitle>Direct Grants</CardTitle>
                  <CardDescription>Optional exceptions on top of the folder-based owner model.</CardDescription>
                </CardHeader>
                <CardContent>
                  <Field>
                    <FieldLabel>Grant JSON</FieldLabel>
                    <Textarea
                      rows={8}
                      value={editor.grantsJson}
                      onChange={(event) => updateEditor((current) => ({ ...current, grantsJson: event.target.value }))}
                      className="font-mono"
                      placeholder='[{"permission":"read","grantScope":"conversation","conversationId":"..."}]'
                    />
                  </Field>
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        )}
        </div>
      </ScrollArea>
    </div>
  )
}
