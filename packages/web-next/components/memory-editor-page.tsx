"use client"

import { useEffect, useMemo, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { ArrowLeft, FolderOpen, Save, Trash2 } from "lucide-react"
import { toast } from "sonner"

import { useWorkspace } from "@/app/dashboard/workspace-provider"
import {
  buildMemoryFolders,
  buildMemoryFolderPathLabel,
  buildMemoryOwnerStateFromPreset,
  buildMemoryPayload,
  createDraftState,
  createEditorStateFromMemory,
  describeFolderVisibility,
  getFolderIdForOwner,
  hasMeaningfulBlocks,
  normalizeActorOption,
  normalizeGroupOption,
  serializeEditorState,
  type EditorState,
  type MemoryFolderNode,
  type Memory,
  type MemorySpaceType,
} from "@/components/memory-browser-model"
import { MemoryPathPickerDialog } from "@/components/memory-path-picker-dialog"
import { CanonicalContentEditor } from "@/components/canonical-content-editor"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Field,
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { api } from "@/lib/api"
import { useAuthStore } from "@/stores/auth-store"

function isMemorySpaceType(value: string | null): value is MemorySpaceType {
  return (
    value === "workspace_shared" ||
    value === "conversation_shared" ||
    value === "actor_private" ||
    value === "participant_private" ||
    value === "user_private"
  )
}

export default function MemoryEditorPage({ memoryId }: { memoryId?: string }) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { workspaceId, workspaceName, currentWorkspaceMemberId } =
    useWorkspace()
  const { user } = useAuthStore()
  const effectiveCurrentWorkspaceMemberId = currentWorkspaceMemberId || ""
  const currentWorkspaceMemberLabel = user?.name || user?.email || "Me"

  const returnTo = searchParams.get("returnTo") || "/dashboard/memories"

  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [baselineSignature, setBaselineSignature] = useState("")
  const [actors, setActors] = useState<any[]>([])
  const [groups, setGroups] = useState<any[]>([])
  const [memory, setMemory] = useState<Memory | null>(null)
  const [activeTab, setActiveTab] = useState<
    "content" | "location" | "attributes"
  >("content")
  const [pathPickerOpen, setPathPickerOpen] = useState(false)

  useEffect(() => {
    if (!workspaceId) return
    void loadPage()
  }, [memoryId, workspaceId])

  async function loadPage() {
    if (!workspaceId) return
    setLoading(true)
    try {
      const [actorData, conversationData, memoryData] = await Promise.all([
        api.getActors(workspaceId),
        api.loadConversationCatalog(workspaceId),
        memoryId ? api.getMemory(workspaceId, memoryId) : Promise.resolve(null),
      ])

      const actorItems = (Array.isArray(actorData) ? actorData : []).map(
        normalizeActorOption
      )
      const groupItems = conversationData.map(normalizeGroupOption)
      setActors(actorItems)
      setGroups(groupItems)

      if (memoryId) {
        const nextMemory = (memoryData?.memory || memoryData) as Memory
        const nextEditor = createEditorStateFromMemory(nextMemory)
        setMemory(nextMemory)
        setEditor(nextEditor)
        setBaselineSignature(serializeEditorState(nextEditor))
      } else {
        const spaceTypeParam =
          searchParams.get("spaceType") || searchParams.get("ownerScope")
        const nextEditor = createDraftState(
          {
            spaceType: isMemorySpaceType(spaceTypeParam)
              ? spaceTypeParam
              : "workspace_shared",
            actorId:
              searchParams.get("actorId") ||
              searchParams.get("ownerActorId") ||
              undefined,
            conversationId:
              searchParams.get("conversationId") ||
              searchParams.get("ownerConversationId") ||
              undefined,
            workspaceMemberId:
              searchParams.get("workspaceMemberId") ||
              searchParams.get("ownerWorkspaceMemberId") ||
              effectiveCurrentWorkspaceMemberId ||
              undefined,
          },
          effectiveCurrentWorkspaceMemberId
        )
        setMemory(null)
        setEditor(nextEditor)
        setBaselineSignature(serializeEditorState(nextEditor))
      }
    } catch (error) {
      console.error("Failed to load memory editor:", error)
      toast.error(
        error instanceof Error ? error.message : "Failed to load memory"
      )
    } finally {
      setLoading(false)
    }
  }

  const dirty = useMemo(
    () => serializeEditorState(editor) !== baselineSignature,
    [baselineSignature, editor]
  )

  const folders = useMemo(
    () =>
      workspaceId && workspaceName
        ? buildMemoryFolders({
            workspaceId,
            workspaceName,
            currentWorkspaceMemberId: effectiveCurrentWorkspaceMemberId,
            currentWorkspaceMemberLabel,
            memories: memory ? [memory] : [],
            actors,
            groups,
          })
        : [],
    [
      actors,
      effectiveCurrentWorkspaceMemberId,
      currentWorkspaceMemberLabel,
      groups,
      memory,
      workspaceId,
      workspaceName,
    ]
  )

  const folderMap = useMemo(
    () => new Map(folders.map((folder) => [folder.id, folder])),
    [folders]
  )

  const selectedFolderId = useMemo(() => {
    if (!editor || !workspaceId) return ""
    return getFolderIdForOwner({
      workspaceId,
      currentWorkspaceMemberId: effectiveCurrentWorkspaceMemberId,
      spaceType: editor.spaceType,
      actorId: editor.actorId || undefined,
      conversationId: editor.conversationId || undefined,
      workspaceMemberId: editor.workspaceMemberId || undefined,
    })
  }, [effectiveCurrentWorkspaceMemberId, editor, workspaceId])

  const selectedFolder = useMemo(
    () => folderMap.get(selectedFolderId) || null,
    [folderMap, selectedFolderId]
  )

  const selectedFolderLabel = useMemo(
    () =>
      selectedFolderId
        ? buildMemoryFolderPathLabel(selectedFolderId, folderMap)
        : "",
    [folderMap, selectedFolderId]
  )

  function updateEditor(updater: (current: EditorState) => EditorState) {
    setEditor((current) => (current ? updater(current) : current))
  }

  function selectFolder(folder: MemoryFolderNode) {
    const preset = folder.createPreset
    if (!preset) return

    updateEditor((current) => ({
      ...current,
      ...buildMemoryOwnerStateFromPreset(
        preset,
        effectiveCurrentWorkspaceMemberId
      ),
    }))
  }

  function leavePage() {
    if (dirty && !window.confirm("Discard unsaved memory changes?")) {
      return
    }
    router.push(returnTo)
  }

  async function saveMemory() {
    if (!workspaceId || !editor) return
    if (
      !hasMeaningfulBlocks(editor.contentBlocks) &&
      !editor.textDigest.trim()
    ) {
      toast.error(
        "Add at least one non-empty block or a text digest before saving."
      )
      return
    }

    setSaving(true)
    try {
      const payload = buildMemoryPayload(editor)
      const result =
        editor.mode === "create"
          ? await api.createMemory(workspaceId, payload)
          : await api.updateMemory(workspaceId, editor.id!, payload)
      const savedMemory = (result?.memory || result) as Memory

      if (editor.mode === "create") {
        toast.success("Memory created")
        router.push(
          `/dashboard/memories/${savedMemory.id}?returnTo=${encodeURIComponent(returnTo)}`
        )
        return
      }

      const nextEditor = createEditorStateFromMemory(savedMemory)
      setMemory(savedMemory)
      setEditor(nextEditor)
      setBaselineSignature(serializeEditorState(nextEditor))
      toast.success("Memory updated")
    } catch (error) {
      console.error("Failed to save memory:", error)
      toast.error(
        error instanceof Error ? error.message : "Failed to save memory"
      )
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
      toast.error(
        error instanceof Error ? error.message : "Failed to delete memory"
      )
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
          <div className="flex flex-col gap-1">
            <div className="text-xl font-semibold text-foreground">
              {memoryId ? "Edit Memory" : "New Memory"}
            </div>
            <div className="text-sm text-muted-foreground">
              Edit the content or move it to another path to change who can read
              it.
            </div>
          </div>
        </div>

        {editor ? (
          <div className="flex items-center gap-2">
            {memoryId ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={deleteMemory}
                disabled={saving}
              >
                <Trash2 data-icon="inline-start" />
                Delete
              </Button>
            ) : null}
            <Button
              type="button"
              size="sm"
              onClick={saveMemory}
              disabled={saving}
            >
              <Save data-icon="inline-start" />
              {saving ? "Saving..." : "Save"}
            </Button>
          </div>
        ) : null}
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="px-3 pt-2 pb-6 sm:px-4 sm:pt-3 lg:px-6">
          {loading || !editor ? (
            <Card className="rounded-[28px]">
              <CardContent className="px-6 py-10 text-sm text-muted-foreground">
                Loading memory editor...
              </CardContent>
            </Card>
          ) : (
            <Tabs
              value={activeTab}
              onValueChange={(value) => setActiveTab(value as typeof activeTab)}
              className="flex flex-col gap-4"
            >
              <TabsList className="w-full justify-start">
                <TabsTrigger value="content">Content</TabsTrigger>
                <TabsTrigger value="location">Visibility</TabsTrigger>
                <TabsTrigger value="attributes">Attributes</TabsTrigger>
              </TabsList>

              <TabsContent value="content" className="mt-0">
                <Card className="rounded-[28px]">
                  <CardContent>
                    <CanonicalContentEditor
                      workspaceId={workspaceId || null}
                      value={editor.contentBlocks}
                      onChange={(blocks) =>
                        updateEditor((current) => ({
                          ...current,
                          contentBlocks: blocks,
                        }))
                      }
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
                    <CardTitle>Path And Visibility</CardTitle>
                    <CardDescription>
                      A memory inherits visibility from its path. Moving it to
                      another path changes who can read it.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-6">
                    <Field>
                      <FieldLabel>Visibility path</FieldLabel>
                      <Button
                        type="button"
                        variant="outline"
                        className="h-auto w-full justify-between gap-4 px-4 py-4"
                        onClick={() => setPathPickerOpen(true)}
                      >
                        <div className="min-w-0 text-left">
                          <div className="truncate text-sm font-medium text-foreground">
                            {selectedFolderLabel || "Select a path"}
                          </div>
                          <div className="mt-1 truncate text-sm text-muted-foreground">
                            {selectedFolder
                              ? describeFolderVisibility(selectedFolder)
                              : "Select a path to define visibility."}
                          </div>
                        </div>
                        <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
                      </Button>
                      <FieldDescription>
                        Choose the path first. The selected path is the visible
                        range.
                      </FieldDescription>
                    </Field>

                    <Field>
                      <FieldLabel>Selected path</FieldLabel>
                      <Input
                        value={selectedFolderLabel || "Select a path"}
                        disabled
                      />
                    </Field>

                    <Field>
                      <FieldLabel>Who can read it</FieldLabel>
                      <Input
                        value={
                          selectedFolder
                            ? describeFolderVisibility(selectedFolder)
                            : "Select a path to define visibility"
                        }
                        disabled
                      />
                      <FieldDescription>
                        Managers of the destination path can edit, move, or
                        delete memories stored there.
                      </FieldDescription>
                    </Field>
                  </CardContent>
                </Card>

                <MemoryPathPickerDialog
                  open={pathPickerOpen}
                  onOpenChange={setPathPickerOpen}
                  folders={folders}
                  value={selectedFolderId}
                  title="Choose visibility path"
                  description="Browse the path tree. The path you choose becomes the memory's visibility range."
                  confirmLabel="Use this path"
                  onConfirm={(folder) => {
                    selectFolder(folder)
                  }}
                />
              </TabsContent>

              <TabsContent value="attributes" className="mt-0">
                <Card className="rounded-[28px]">
                  <CardHeader>
                    <CardTitle>Attributes</CardTitle>
                    <CardDescription>
                      These values affect recall and memory lifecycle.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-6">
                    <Field>
                      <FieldLabel>Text digest</FieldLabel>
                      <Input
                        value={editor.textDigest}
                        onChange={(event) =>
                          updateEditor((current) => ({
                            ...current,
                            textDigest: event.target.value,
                          }))
                        }
                        placeholder="Short summary for list views"
                      />
                    </Field>

                    <FieldGroup className="md:grid md:grid-cols-2">
                      <Field>
                        <FieldLabel>Category</FieldLabel>
                        <Select
                          value={editor.category}
                          onValueChange={(value) =>
                            updateEditor((current) => ({
                              ...current,
                              category: value as typeof current.category,
                            }))
                          }
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              <SelectItem value="fact">Fact</SelectItem>
                              <SelectItem value="preference">
                                Preference
                              </SelectItem>
                              <SelectItem value="decision">Decision</SelectItem>
                              <SelectItem value="relationship">
                                Relationship
                              </SelectItem>
                              <SelectItem value="procedure">
                                Procedure
                              </SelectItem>
                              <SelectItem value="artifact">Artifact</SelectItem>
                              <SelectItem value="summary">Summary</SelectItem>
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                      </Field>

                      <Field>
                        <FieldLabel>State</FieldLabel>
                        <Select
                          value={editor.state}
                          onValueChange={(value) =>
                            updateEditor((current) => ({
                              ...current,
                              state: value as typeof current.state,
                            }))
                          }
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              <SelectItem value="active">Active</SelectItem>
                              <SelectItem value="superseded">
                                Superseded
                              </SelectItem>
                              <SelectItem value="archived">Archived</SelectItem>
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
                          onChange={(event) =>
                            updateEditor((current) => ({
                              ...current,
                              importance: Number(event.target.value || 0),
                            }))
                          }
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
                          onChange={(event) =>
                            updateEditor((current) => ({
                              ...current,
                              confidence: Number(event.target.value || 0),
                            }))
                          }
                        />
                      </Field>
                    </FieldGroup>

                    <Field>
                      <FieldLabel>Tags</FieldLabel>
                      <Input
                        value={editor.tags}
                        onChange={(event) =>
                          updateEditor((current) => ({
                            ...current,
                            tags: event.target.value,
                          }))
                        }
                        placeholder="comma, separated, tags"
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
