"use client"

import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react"
import { usePathname, useRouter, useSearchParams, type ReadonlyURLSearchParams } from "next/navigation"
import { ArrowRightLeft, ChevronDown, ChevronRight, FilePlus2, FileText, Folder, RefreshCw, Search, Upload } from "lucide-react"
import { toast } from "sonner"

import { useWorkspace } from "@/app/dashboard/workspace-provider"
import { fileRecordToBlock, type UploadedFile } from "@/components/actor-editor-model"
import {
  buildMemoryFolders,
  buildMemoryOwnerPayloadFromPreset,
  describeFolderVisibility,
  getFolderSegments,
  getFolderIdForOwner,
  normalizeActorOption,
  normalizeGroupOption,
  summarizeMemory,
  type Memory,
  type MemoryFolderNode,
} from "@/components/memory-browser-model"
import { MemoryPathPickerDialog } from "@/components/memory-path-picker-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { api } from "@/lib/api"
import { cn } from "@/lib/utils"
import { useAuthStore } from "@/stores/auth-store"

function buildBrowseHref(
  pathname: string,
  searchParams: URLSearchParams | ReadonlyURLSearchParams,
  overrides: Record<string, string | null | undefined>,
) {
  const nextParams = new URLSearchParams(searchParams.toString())

  for (const [key, value] of Object.entries(overrides)) {
    if (!value) {
      nextParams.delete(key)
    } else {
      nextParams.set(key, value)
    }
  }

  const queryString = nextParams.toString()
  return queryString ? `${pathname}?${queryString}` : pathname
}

function buildCreateHref(
  pathname: string,
  searchParams: URLSearchParams | ReadonlyURLSearchParams,
  folder: MemoryFolderNode,
) {
  if (!folder.createPreset) return null

  const params = new URLSearchParams({
    ownerScope: folder.createPreset.ownerScope,
    returnTo: buildBrowseHref(pathname, searchParams, { folder: folder.id }),
  })

  if (folder.createPreset.ownerActorId) {
    params.set("ownerActorId", folder.createPreset.ownerActorId)
  }
  if (folder.createPreset.ownerConversationId) {
    params.set("ownerConversationId", folder.createPreset.ownerConversationId)
  }
  if (folder.createPreset.ownerWorkspaceMemberId) {
    params.set(
      "ownerWorkspaceMemberId",
      folder.createPreset.ownerWorkspaceMemberId
    )
  }

  return `${pathname}/new?${params.toString()}`
}

type PendingFileCreate = {
  files: File[]
  folderLabel: string
  preset: NonNullable<MemoryFolderNode["createPreset"]>
  returnTo: string
}

export default function MemoryBrowser() {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const { workspaceId, workspaceName, currentWorkspaceMemberId } =
    useWorkspace()
  const { user } = useAuthStore()
  const effectiveCurrentWorkspaceMemberId = currentWorkspaceMemberId || ""
  const currentWorkspaceMemberLabel = user?.name || user?.email || "Me"

  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [creatingFromFiles, setCreatingFromFiles] = useState(false)
  const [memories, setMemories] = useState<Memory[]>([])
  const [actors, setActors] = useState<any[]>([])
  const [groups, setGroups] = useState<any[]>([])
  const [pendingFileCreate, setPendingFileCreate] = useState<PendingFileCreate | null>(null)
  const [movingMemory, setMovingMemory] = useState<Memory | null>(null)
  const [createdFromFiles, setCreatedFromFiles] = useState<{
    count: number
    latestMemoryId: string | null
    latestLabel: string
    returnTo: string
  } | null>(null)
  const [dragActive, setDragActive] = useState(false)
  const query = searchParams.get("q") || ""
  const rawWorkspaceFolderType = searchParams.get("type")
  const workspaceFolderType: "all" | "conversation" | "actor" =
    rawWorkspaceFolderType === "conversation" || rawWorkspaceFolderType === "actor"
      ? rawWorkspaceFolderType
      : "all"
  const deferredQuery = useDeferredValue(query)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const dragCounterRef = useRef(0)

  useEffect(() => {
    if (!workspaceId) return
    void loadData()
  }, [workspaceId])

  async function loadData() {
    if (!workspaceId) return
    setLoading(true)
    try {
      const [memoryData, actorData, conversationData] = await Promise.all([
        api.getMemories(workspaceId),
        api.getActors(workspaceId),
        api.getThreads(workspaceId),
      ])

      setMemories(Array.isArray(memoryData) ? memoryData : memoryData?.memories || [])
      setActors((Array.isArray(actorData) ? actorData : []).map(normalizeActorOption))
      setGroups((conversationData?.conversations || []).map(normalizeGroupOption))
    } catch (error) {
      console.error("Failed to load memories:", error)
      toast.error(error instanceof Error ? error.message : "Failed to load memories")
    } finally {
      setLoading(false)
    }
  }

  async function refreshData() {
    if (!workspaceId) return
    setRefreshing(true)
    try {
      await loadData()
      toast.success("Memories refreshed")
    } finally {
      setRefreshing(false)
    }
  }

  const folders = useMemo(
    () =>
      workspaceId && workspaceName
        ? buildMemoryFolders({
            workspaceId,
            workspaceName,
            currentWorkspaceMemberId: effectiveCurrentWorkspaceMemberId,
            currentWorkspaceMemberLabel,
            memories,
            actors,
            groups,
          })
        : [],
    [
      actors,
      effectiveCurrentWorkspaceMemberId,
      currentWorkspaceMemberLabel,
      groups,
      memories,
      workspaceId,
      workspaceName,
    ],
  )

  const folderMap = useMemo(() => new Map(folders.map((folder) => [folder.id, folder])), [folders])
  const requestedFolderId = searchParams.get("folder") || "root"
  const activeFolder = folderMap.get(requestedFolderId) || folderMap.get("root") || null

  useEffect(() => {
    if (!activeFolder || requestedFolderId === activeFolder.id) return
    router.replace(buildBrowseHref(pathname, searchParams, { folder: activeFolder.id }), { scroll: false })
  }, [activeFolder, pathname, requestedFolderId, router, searchParams])

  const folderSegments = useMemo(
    () => (activeFolder ? getFolderSegments(activeFolder.id, folderMap) : []),
    [activeFolder, folderMap],
  )
  const workspaceFolderId = workspaceId ? `folder:workspace:${workspaceId}` : null
  const isWorkspaceRoot = activeFolder?.id === workspaceFolderId

  const childFolders = useMemo(
    () =>
      folders
        .filter((folder) => folder.parentId === activeFolder?.id)
        .sort((left, right) => left.label.localeCompare(right.label, undefined, { sensitivity: "base" })),
    [activeFolder?.id, folders],
  )

  const fileRows = useMemo(
    () =>
      memories
        .filter((memory) => activeFolder?.directMemoryIds.includes(memory.id))
        .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()),
    [activeFolder?.directMemoryIds, memories],
  )

  const items = useMemo(() => {
    const normalizedQuery = deferredQuery.trim().toLowerCase()
    const folderItems = childFolders.filter((folder) => {
      if (isWorkspaceRoot && workspaceFolderType !== "all") {
        const isConversationFolder = folder.createPreset?.ownerScope === "conversation"
        const isActorFolder = folder.createPreset?.ownerScope === "actor_global"

        if (workspaceFolderType === "conversation" && !isConversationFolder) {
          return false
        }

        if (workspaceFolderType === "actor" && !isActorFolder) {
          return false
        }
      }

      if (!normalizedQuery) return true
      return [folder.label, folder.description || ""].join(" ").toLowerCase().includes(normalizedQuery)
    })
    const memoryItems = fileRows.filter((memory) => {
      if (!normalizedQuery) return true
      return [summarizeMemory(memory), memory.category, memory.tags.join(" ")].join(" ").toLowerCase().includes(normalizedQuery)
    })
    return { folderItems, memoryItems }
  }, [childFolders, deferredQuery, fileRows, isWorkspaceRoot, workspaceFolderType])

  const createHref = activeFolder ? buildCreateHref(pathname, searchParams, activeFolder) : null
  const currentBrowseHref = buildBrowseHref(pathname, searchParams, { folder: activeFolder?.id || "root" })
  const movingMemoryFolderId = useMemo(() => {
    if (!movingMemory || !workspaceId) return ""

    return getFolderIdForOwner({
      workspaceId,
      currentWorkspaceMemberId: effectiveCurrentWorkspaceMemberId,
      ownerScope: movingMemory.ownerScope,
      ownerActorId: movingMemory.ownerActorId || undefined,
      ownerConversationId: movingMemory.ownerConversationId || undefined,
      ownerWorkspaceMemberId:
        movingMemory.ownerWorkspaceMemberId || undefined,
    })
  }, [effectiveCurrentWorkspaceMemberId, movingMemory, workspaceId])

  function beginFileCreate(files: File[] | FileList | null) {
    if (!activeFolder?.createPreset) {
      toast.error("Open a concrete memory path before creating from files.")
      return
    }

    const nextFiles = Array.from(files || []).filter((file) => file.size > 0)
    if (nextFiles.length === 0) return

    setPendingFileCreate({
      files: nextFiles,
      folderLabel: activeFolder.label,
      preset: activeFolder.createPreset,
      returnTo: currentBrowseHref,
    })
  }

  async function moveMemoryToFolder(folder: MemoryFolderNode) {
    if (!workspaceId || !movingMemory?.id || !folder.createPreset) return

    try {
      const result = await api.updateMemory(
        workspaceId,
        movingMemory.id,
        buildMemoryOwnerPayloadFromPreset(
          folder.createPreset,
          effectiveCurrentWorkspaceMemberId
        ),
      )
      const savedMemory = (result?.memory || result) as Memory
      setMemories((current) => current.map((memory) => (memory.id === savedMemory.id ? savedMemory : memory)))
      toast.success("Memory path updated")
    } catch (error) {
      console.error("Failed to move memory:", error)
      toast.error(error instanceof Error ? error.message : "Failed to move memory")
      throw error
    }
  }

  async function confirmCreateFromFiles() {
    if (!workspaceId || !pendingFileCreate) return

    setCreatingFromFiles(true)
    try {
      const createdMemories: Memory[] = []

      for (const file of pendingFileCreate.files) {
        const uploaded = (await api.uploadFile(workspaceId, file)) as UploadedFile
        const result = await api.createMemory(workspaceId, {
          ownerScope: pendingFileCreate.preset.ownerScope,
          ownerActorId: pendingFileCreate.preset.ownerActorId,
          ownerConversationId: pendingFileCreate.preset.ownerConversationId,
          ownerWorkspaceMemberId:
            pendingFileCreate.preset.ownerWorkspaceMemberId,
          category: "artifact",
          status: "established",
          stability: "durable",
          importance: 0.75,
          confidence: 0.95,
          tags: [],
          textDigest: file.name,
          contentBlocks: [fileRecordToBlock(uploaded)],
        })

        createdMemories.push((result?.memory || result) as Memory)
      }

      await loadData()
      setPendingFileCreate(null)
      setCreatedFromFiles({
        count: createdMemories.length,
        latestMemoryId: createdMemories.at(-1)?.id || null,
        latestLabel: createdMemories.at(-1)?.textDigest?.trim() || pendingFileCreate.files.at(-1)?.name || "New memory",
        returnTo: pendingFileCreate.returnTo,
      })
    } catch (error) {
      console.error("Failed to create memory from files:", error)
      toast.error(error instanceof Error ? error.message : "Failed to create memory from files")
    } finally {
      setCreatingFromFiles(false)
    }
  }

  function handleDragEnter(event: React.DragEvent<HTMLDivElement>) {
    if (!activeFolder?.createPreset || !event.dataTransfer.types.includes("Files")) return
    dragCounterRef.current += 1
    setDragActive(true)
  }

  function handleDragLeave() {
    dragCounterRef.current = Math.max(0, dragCounterRef.current - 1)
    if (dragCounterRef.current === 0) {
      setDragActive(false)
    }
  }

  function handleDragOver(event: React.DragEvent<HTMLDivElement>) {
    if (!activeFolder?.createPreset || !event.dataTransfer.types.includes("Files")) return
    event.preventDefault()
    event.dataTransfer.dropEffect = "copy"
  }

  function handleDrop(event: React.DragEvent<HTMLDivElement>) {
    if (!activeFolder?.createPreset || event.dataTransfer.files.length === 0) return
    event.preventDefault()
    dragCounterRef.current = 0
    setDragActive(false)
    beginFileCreate(event.dataTransfer.files)
  }

  return (
    <div className="flex min-h-[calc(100vh-11rem)] flex-col">
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(event) => {
          beginFileCreate(event.target.files)
          event.target.value = ""
        }}
      />

      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col overflow-hidden transition-colors",
          dragActive && "rounded-[28px] bg-muted/25 ring-1 ring-primary/30",
        )}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        <div className="flex flex-wrap items-center gap-3 px-2 py-3 sm:px-3">
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm text-muted-foreground">
              {folderSegments.map((segment, index) => (
                <div key={segment.id} className="flex items-center gap-2">
                  {index > 0 ? <ChevronRight className="size-4" /> : null}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className={cn("h-auto px-0 py-0 text-sm", index === folderSegments.length - 1 ? "text-foreground" : "text-muted-foreground")}
                    onClick={() => router.push(buildBrowseHref(pathname, searchParams, { folder: segment.id }))}
                  >
                    {segment.label}
                  </Button>
                </div>
              ))}
            </div>
            {activeFolder ? (
              <div className="text-sm text-muted-foreground">
                {describeFolderVisibility(activeFolder)} Move a memory to another path to change who can read it.
              </div>
            ) : null}
          </div>

          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
            {isWorkspaceRoot ? (
              <Select
                value={workspaceFolderType}
                onValueChange={(value: "all" | "conversation" | "actor") =>
                  router.replace(
                    buildBrowseHref(pathname, searchParams, { type: value === "all" ? null : value }),
                    { scroll: false },
                  )
                }
              >
                <SelectTrigger className="w-[180px]">
                  <SelectValue placeholder="Type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  <SelectItem value="conversation">Conversation</SelectItem>
                  <SelectItem value="actor">Actor</SelectItem>
                </SelectContent>
              </Select>
            ) : null}

            <Button type="button" variant="outline" size="sm" onClick={refreshData} disabled={refreshing}>
              <RefreshCw data-icon="inline-start" className={cn(refreshing && "animate-spin")} />
              Refresh
            </Button>

            <div className="relative w-40 sm:w-52 lg:w-72">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) =>
                  router.replace(
                    buildBrowseHref(pathname, searchParams, { q: event.target.value || null }),
                    { scroll: false },
                  )
                }
                placeholder="Search in this path"
                className="pl-10"
              />
            </div>

            {createHref ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button type="button" size="sm">
                    <FilePlus2 data-icon="inline-start" />
                    New Memory
                    <ChevronDown />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-48">
                  <DropdownMenuItem onSelect={() => router.push(createHref)}>
                    <FilePlus2 />
                    Blank Memory
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => {
                      fileInputRef.current?.click()
                    }}
                  >
                    <Upload />
                    From File
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </div>
        </div>

        <Separator />

        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col">
            {loading ? (
              <div className="px-5 py-10 text-sm text-muted-foreground">Loading memories...</div>
            ) : items.folderItems.length === 0 && items.memoryItems.length === 0 ? (
              <div className="px-5 py-10 text-center">
                <div className="text-base font-medium text-foreground">This path is empty</div>
                <div className="mt-2 text-sm text-muted-foreground">
                  {createHref ? "Create a memory here. Its visibility will follow this path." : "Navigate into a concrete path to start creating memories."}
                </div>
              </div>
            ) : (
              <>
                {items.folderItems.map((folder) => {
                  const Icon = folder.icon || Folder
                  return (
                    <button
                      key={folder.id}
                      type="button"
                      className="flex w-full items-center gap-4 border-b border-border/70 px-5 py-4 text-left transition-colors hover:bg-muted/30"
                      onClick={() => router.push(buildBrowseHref(pathname, searchParams, { folder: folder.id }))}
                    >
                      <div className="flex size-10 items-center justify-center rounded-2xl border border-border bg-muted/30">
                        <Icon className="size-4 text-muted-foreground" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium text-foreground">{folder.label}</div>
                        {folder.description ? (
                          <div className="truncate text-sm text-muted-foreground">{folder.description}</div>
                        ) : null}
                      </div>
                      <Badge variant="outline">{folder.directMemoryIds.length}</Badge>
                    </button>
                  )
                })}

                {items.memoryItems.map((memory) => (
                  <div key={memory.id} className="flex items-center gap-3 border-b border-border/70 px-5 py-4">
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-center gap-4 text-left transition-colors hover:text-foreground"
                      onClick={() =>
                        router.push(
                          `/dashboard/memories/${memory.id}?returnTo=${encodeURIComponent(
                            buildBrowseHref(pathname, searchParams, { folder: activeFolder?.id || "root" }),
                          )}`,
                        )
                      }
                    >
                      <div className="flex size-10 items-center justify-center rounded-2xl border border-border bg-background">
                        <FileText className="size-4 text-muted-foreground" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium text-foreground">{summarizeMemory(memory)}</div>
                        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                          <Badge variant="outline">{memory.category}</Badge>
                          <span>{new Date(memory.updatedAt).toLocaleString()}</span>
                          <span>{memory.contentBlocks.length} blocks</span>
                        </div>
                      </div>
                    </button>

                    <Button type="button" variant="outline" size="sm" onClick={() => setMovingMemory(memory)}>
                      <ArrowRightLeft data-icon="inline-start" />
                      Change Path
                    </Button>
                  </div>
                ))}
              </>
            )}
          </div>
        </ScrollArea>
      </div>

      <Dialog open={pendingFileCreate !== null} onOpenChange={(open) => !open && !creatingFromFiles && setPendingFileCreate(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create memory from file{pendingFileCreate?.files.length === 1 ? "" : "s"}?</DialogTitle>
            <DialogDescription>
              {pendingFileCreate
                ? `Upload ${pendingFileCreate.files.length} file${pendingFileCreate.files.length === 1 ? "" : "s"} into ${pendingFileCreate.folderLabel}. Anyone who can read that path will be able to read the new mem${pendingFileCreate.files.length === 1 ? "ory" : "ories"}.`
                : ""}
            </DialogDescription>
          </DialogHeader>

          {pendingFileCreate ? (
            <div className="max-h-48 overflow-y-auto rounded-2xl border border-border/70 bg-muted/20 px-4 py-3">
              <div className="flex flex-col gap-2 text-sm text-foreground">
                {pendingFileCreate.files.slice(0, 6).map((file) => (
                  <div key={`${file.name}-${file.size}`} className="truncate">
                    {file.name}
                  </div>
                ))}
                {pendingFileCreate.files.length > 6 ? (
                  <div className="text-muted-foreground">
                    +{pendingFileCreate.files.length - 6} more
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setPendingFileCreate(null)}
              disabled={creatingFromFiles}
            >
              Cancel
            </Button>
            <Button type="button" onClick={() => void confirmCreateFromFiles()} disabled={creatingFromFiles}>
              {creatingFromFiles ? "Uploading..." : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={createdFromFiles !== null} onOpenChange={(open) => !open && setCreatedFromFiles(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Memory created</DialogTitle>
            <DialogDescription>
              {createdFromFiles
                ? `Created ${createdFromFiles.count} memor${createdFromFiles.count === 1 ? "y" : "ies"} from file upload.`
                : ""}
            </DialogDescription>
          </DialogHeader>

          {createdFromFiles ? (
            <div className="rounded-2xl border border-border/70 bg-muted/20 px-4 py-3 text-sm text-foreground">
              {createdFromFiles.latestLabel}
            </div>
          ) : null}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setCreatedFromFiles(null)}
            >
              Done
            </Button>
            {createdFromFiles?.latestMemoryId ? (
              <Button
                type="button"
                onClick={() => {
                  const target = `/dashboard/memories/${createdFromFiles.latestMemoryId}?returnTo=${encodeURIComponent(createdFromFiles.returnTo)}`
                  setCreatedFromFiles(null)
                  router.push(target)
                }}
              >
                Edit
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <MemoryPathPickerDialog
        open={movingMemory !== null}
        onOpenChange={(open) => !open && setMovingMemory(null)}
        folders={folders}
        value={movingMemoryFolderId}
        title={movingMemory ? `Change path for ${summarizeMemory(movingMemory)}` : "Change memory path"}
        description="Browse the path tree and choose the new visibility range for this memory."
        confirmLabel="Move to this path"
        disallowFolderIds={movingMemoryFolderId ? [movingMemoryFolderId] : undefined}
        onConfirm={moveMemoryToFolder}
      />
    </div>
  )
}
