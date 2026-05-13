"use client"

import { Fragment, useDeferredValue, useEffect, useMemo, useState } from "react"
import { ArrowUp, Folder, Search } from "lucide-react"

import {
  buildMemoryFolderPathLabel,
  describeFolderVisibility,
  getFolderSegments,
  type MemoryFolderNode,
} from "@/components/memory-browser-model"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"

type MemoryPathPickerDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  folders: MemoryFolderNode[]
  value?: string
  title: string
  description: string
  confirmLabel: string
  disallowFolderIds?: string[]
  onConfirm: (folder: MemoryFolderNode) => Promise<void> | void
}

export function MemoryPathPickerDialog({
  open,
  onOpenChange,
  folders,
  value,
  title,
  description,
  confirmLabel,
  disallowFolderIds,
  onConfirm,
}: MemoryPathPickerDialogProps) {
  const [browseFolderId, setBrowseFolderId] = useState(value || "root")
  const [query, setQuery] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const deferredQuery = useDeferredValue(query)

  const folderMap = useMemo(
    () => new Map(folders.map((folder) => [folder.id, folder])),
    [folders]
  )
  const blockedFolderIds = useMemo(
    () => new Set(disallowFolderIds || []),
    [disallowFolderIds]
  )

  useEffect(() => {
    if (!open) return
    setBrowseFolderId(value && folderMap.has(value) ? value : "root")
    setQuery("")
  }, [folderMap, open, value])

  const activeFolder =
    folderMap.get(browseFolderId) || folderMap.get("root") || null

  const pathSegments = useMemo(
    () => (activeFolder ? getFolderSegments(activeFolder.id, folderMap) : []),
    [activeFolder, folderMap]
  )

  const childFolders = useMemo(
    () =>
      folders
        .filter((folder) => folder.parentId === activeFolder?.id)
        .sort((left, right) =>
          left.label.localeCompare(right.label, undefined, {
            sensitivity: "base",
          })
        ),
    [activeFolder?.id, folders]
  )

  const filteredChildFolders = useMemo(() => {
    const normalizedQuery = deferredQuery.trim().toLowerCase()
    if (!normalizedQuery) return childFolders

    return childFolders.filter((folder) =>
      [folder.label, folder.description || describeFolderVisibility(folder)]
        .join(" ")
        .toLowerCase()
        .includes(normalizedQuery)
    )
  }, [childFolders, deferredQuery])

  const activePathLabel = useMemo(
    () =>
      activeFolder
        ? buildMemoryFolderPathLabel(activeFolder.id, folderMap) ||
          activeFolder.label
        : "",
    [activeFolder, folderMap]
  )

  const canConfirm =
    Boolean(activeFolder?.createPreset) &&
    !blockedFolderIds.has(activeFolder?.id || "")
  const isBlockedFolder = activeFolder
    ? blockedFolderIds.has(activeFolder.id)
    : false

  async function handleConfirm() {
    if (!activeFolder?.createPreset || isBlockedFolder) return

    setSubmitting(true)
    try {
      await onConfirm(activeFolder)
      onOpenChange(false)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => !submitting && onOpenChange(nextOpen)}
    >
      <DialogContent className="max-h-[calc(100vh-4rem)] overflow-hidden p-0 sm:max-w-2xl">
        <div className="flex min-h-0 flex-col">
          <DialogHeader className="border-b border-border/70 px-6 py-5">
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>

          <div className="flex min-h-0 flex-1 flex-col gap-4 px-6 py-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <Breadcrumb>
                <BreadcrumbList>
                  {pathSegments.map((segment, index) => (
                    <Fragment key={segment.id}>
                      <BreadcrumbItem>
                        {index === pathSegments.length - 1 ? (
                          <BreadcrumbPage>{segment.label}</BreadcrumbPage>
                        ) : (
                          <BreadcrumbLink asChild>
                            <button
                              type="button"
                              onClick={() => setBrowseFolderId(segment.id)}
                            >
                              {segment.label}
                            </button>
                          </BreadcrumbLink>
                        )}
                      </BreadcrumbItem>
                      {index < pathSegments.length - 1 ? (
                        <BreadcrumbSeparator />
                      ) : null}
                    </Fragment>
                  ))}
                </BreadcrumbList>
              </Breadcrumb>

              {activeFolder?.parentId ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setBrowseFolderId(activeFolder.parentId!)}
                >
                  <ArrowUp data-icon="inline-start" />
                  Up
                </Button>
              ) : null}
            </div>

            <div className="rounded-[24px] border border-border/70 bg-muted/20 px-4 py-4">
              <div className="text-xs font-medium tracking-[0.16em] text-muted-foreground uppercase">
                Current path
              </div>
              <div className="mt-2 text-sm font-medium text-foreground">
                {activePathLabel || "Memories"}
              </div>
              <div className="mt-2 text-sm text-muted-foreground">
                {activeFolder
                  ? describeFolderVisibility(activeFolder)
                  : "Select a path to define visibility."}
              </div>
              <div className="mt-2 text-sm text-muted-foreground">
                {isBlockedFolder
                  ? "This memory is already in this path."
                  : activeFolder?.createPreset
                    ? "Use this path if this is the visibility range you want."
                    : "This level is only a container. Enter a child path to choose a concrete visibility range."}
              </div>
            </div>

            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search this level"
                className="pl-10"
              />
            </div>

            <ScrollArea className="min-h-0 flex-1 rounded-[24px] border border-border/70">
              <div className="flex flex-col p-2">
                {filteredChildFolders.length === 0 ? (
                  <div className="px-4 py-10 text-center text-sm text-muted-foreground">
                    {childFolders.length === 0
                      ? "No deeper paths here."
                      : "No paths match this search."}
                  </div>
                ) : (
                  filteredChildFolders.map((folder) => {
                    const Icon = folder.icon || Folder
                    return (
                      <button
                        key={folder.id}
                        type="button"
                        className="flex w-full items-center gap-4 rounded-[20px] px-4 py-3 text-left transition-colors hover:bg-muted/40"
                        onClick={() => setBrowseFolderId(folder.id)}
                      >
                        <div className="flex size-10 items-center justify-center rounded-2xl border border-border bg-background">
                          <Icon className="size-4 text-muted-foreground" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium text-foreground">
                            {folder.label}
                          </div>
                          <div className="truncate text-sm text-muted-foreground">
                            {folder.description ||
                              describeFolderVisibility(folder)}
                          </div>
                        </div>
                      </button>
                    )
                  })
                )}
              </div>
            </ScrollArea>
          </div>

          <DialogFooter className="border-t border-border/70 px-6 py-5">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => void handleConfirm()}
              disabled={!canConfirm || submitting}
            >
              {submitting ? "Saving..." : confirmLabel}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  )
}
