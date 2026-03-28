"use client"

import { useRef, useState } from "react"
import {
  closestCenter,
  DndContext,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core"
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { type CanonicalContentBlock } from "@synapse/shared"
import {
  GripVertical,
  Loader2,
  Paperclip,
  Plus,
  Trash2,
  Type,
} from "lucide-react"
import { toast } from "sonner"

import {
  createEmptyTextContentBlock,
  fileRecordToBlock,
  type UploadedFile,
} from "@/components/actor-editor-model"
import { CanonicalContentRenderer } from "@/components/canonical-content-renderer"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Textarea } from "@/components/ui/textarea"
import { api } from "@/lib/api"

type FileRefBlock = Extract<CanonicalContentBlock, { type: "file_ref" }>

function InsertBar({
  onInsertText,
  onInsertFile,
}: {
  onInsertText: () => void
  onInsertFile: () => void
}) {
  return (
    <div className="flex flex-wrap items-center justify-center gap-2 rounded-2xl border border-dashed border-border bg-background/70 px-3 py-2">
      <Button type="button" variant="ghost" size="sm" onClick={onInsertText}>
        <Type data-icon="inline-start" />
        Insert text
      </Button>
      <Button type="button" variant="ghost" size="sm" onClick={onInsertFile}>
        <Paperclip data-icon="inline-start" />
        Insert file
      </Button>
    </div>
  )
}

function SortableBlockCard({
  block,
  onTextChange,
  onRemove,
}: {
  block: CanonicalContentBlock
  onTextChange: (blockId: string, text: string) => void
  onRemove: (blockId: string) => void
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: block.id,
  })

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`rounded-[28px] border bg-background/90 ${isDragging ? "border-primary shadow-lg" : "border-border"}`}
    >
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="flex items-center gap-3">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="cursor-grab active:cursor-grabbing"
            {...attributes}
            {...listeners}
          >
            <GripVertical />
            <span className="sr-only">Reorder block</span>
          </Button>
          <Badge variant="outline">
            {block.type === "text"
              ? "Text"
              : block.type === "mention"
                ? "Mention"
                : "File"}
          </Badge>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => onRemove(block.id)}
          >
            <Trash2 />
            <span className="sr-only">Delete block</span>
          </Button>
        </div>
      </div>

      <div className="p-4">
        {block.type === "text" ? (
          <Textarea
            rows={1}
            value={block.text}
            onChange={(event) => onTextChange(block.id, event.target.value)}
            placeholder="Write one text block at a time."
            className="min-h-24 rounded-2xl border-0 bg-muted/30 px-0 py-0 shadow-none focus-visible:ring-0"
          />
        ) : (
          <CanonicalContentRenderer blocks={[block]} />
        )}
      </div>
    </div>
  )
}

export function CanonicalContentEditor({
  workspaceId,
  value,
  onChange,
  placeholder,
  label = "Block editor",
  description,
  showCount = true,
}: {
  workspaceId: string | null
  value: CanonicalContentBlock[]
  onChange: (value: CanonicalContentBlock[]) => void
  placeholder?: string
  label?: string
  description?: string | null
  showCount?: boolean
}) {
  const [uploading, setUploading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const pendingInsertIndexRef = useRef<number | null>(null)

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 180, tolerance: 8 },
    })
  )

  function commit(next: CanonicalContentBlock[]) {
    onChange(next)
  }

  function openFilePicker(insertIndex: number) {
    pendingInsertIndexRef.current = insertIndex
    fileInputRef.current?.click()
  }

  function insertTextBlock(insertIndex: number, text = "") {
    const next = [...value]
    next.splice(insertIndex, 0, createEmptyTextContentBlock(text))
    commit(next)
  }

  function updateTextBlock(blockId: string, text: string) {
    commit(
      value.map((block) =>
        block.id === blockId && block.type === "text"
          ? { ...block, text }
          : block
      )
    )
  }

  function removeBlock(blockId: string) {
    commit(value.filter((block) => block.id !== blockId))
  }

  async function insertFiles(insertIndex: number, files: File[]) {
    if (!workspaceId || files.length === 0) return
    setUploading(true)
    try {
      const uploadedBlocks: FileRefBlock[] = []
      for (const file of files) {
        const uploaded = (await api.uploadFile(
          workspaceId,
          file
        )) as UploadedFile
        uploadedBlocks.push(fileRecordToBlock(uploaded))
      }

      const next = [...value]
      next.splice(insertIndex, 0, ...uploadedBlocks)
      commit(next)
      toast.success(
        `${uploadedBlocks.length} file reference${uploadedBlocks.length > 1 ? "s" : ""} attached`
      )
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Attachment failed")
    } finally {
      setUploading(false)
    }
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return

    const oldIndex = value.findIndex((block) => block.id === active.id)
    const newIndex = value.findIndex((block) => block.id === over.id)
    if (oldIndex < 0 || newIndex < 0) return

    commit(arrayMove(value, oldIndex, newIndex))
  }

  function handleEditorDrop(event: React.DragEvent<HTMLDivElement>) {
    const droppedFiles = Array.from(event.dataTransfer.files || [])
    if (droppedFiles.length === 0) return

    event.preventDefault()
    const blockContainer = (event.target as HTMLElement | null)?.closest(
      "[data-block-index]"
    )
    const blockIndex = blockContainer
      ? Number(blockContainer.getAttribute("data-block-index"))
      : value.length - 1
    const insertIndex =
      Number.isFinite(blockIndex) && blockIndex >= 0
        ? blockIndex + 1
        : value.length
    void insertFiles(insertIndex, droppedFiles)
  }

  function handleEditorDragOver(event: React.DragEvent<HTMLDivElement>) {
    if (event.dataTransfer.files.length > 0) {
      event.preventDefault()
    }
  }

  const helperText =
    description !== undefined
      ? description
      : placeholder ||
        "Compose the section as ordered text blocks and file blocks."

  return (
    <div className="flex flex-col gap-5">
      <FieldGroup>
        <Field>
          {label || helperText || showCount ? (
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                {label ? <FieldLabel>{label}</FieldLabel> : null}
                {helperText ? (
                  <FieldDescription>{helperText}</FieldDescription>
                ) : null}
              </div>
              {showCount ? (
                <Badge variant="outline">{value.length} blocks</Badge>
              ) : null}
            </div>
          ) : null}

          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(event) => {
              const files = Array.from(event.target.files || [])
              const insertIndex = pendingInsertIndexRef.current ?? value.length
              if (files.length > 0) {
                void insertFiles(insertIndex, files)
              }
              pendingInsertIndexRef.current = null
              event.target.value = ""
            }}
          />

          <div
            className="rounded-[28px] border border-dashed border-border bg-muted/10 p-4"
            onDrop={handleEditorDrop}
            onDragOver={handleEditorDragOver}
          >
            {value.length > 0 ? (
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={handleDragEnd}
              >
                <SortableContext
                  items={value.map((block) => block.id)}
                  strategy={verticalListSortingStrategy}
                >
                  <div className="flex flex-col gap-3">
                    <InsertBar
                      onInsertText={() => insertTextBlock(0)}
                      onInsertFile={() => openFilePicker(0)}
                    />
                    {value.map((block, index) => (
                      <div
                        key={block.id}
                        data-block-index={index}
                        className="flex flex-col gap-3"
                      >
                        <SortableBlockCard
                          block={block}
                          onTextChange={updateTextBlock}
                          onRemove={removeBlock}
                        />
                        <InsertBar
                          onInsertText={() => insertTextBlock(index + 1)}
                          onInsertFile={() => openFilePicker(index + 1)}
                        />
                      </div>
                    ))}
                  </div>
                </SortableContext>
              </DndContext>
            ) : (
              <div className="flex min-h-40 flex-col items-center justify-center gap-4 rounded-[24px] border border-border bg-background/70 p-6 text-center">
                <div className="space-y-1">
                  <div className="text-sm font-medium text-foreground">
                    No blocks yet
                  </div>
                  <div className="text-sm text-muted-foreground">
                    Add a text block, attach a file block, or drop files here.
                  </div>
                </div>
                <div className="flex flex-wrap justify-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => insertTextBlock(0)}
                  >
                    <Plus data-icon="inline-start" />
                    Add text block
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => openFilePicker(0)}
                  >
                    <Paperclip data-icon="inline-start" />
                    Add file block
                  </Button>
                </div>
              </div>
            )}

            {uploading ? (
              <div className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                Uploading files into the selected position...
              </div>
            ) : null}
          </div>
        </Field>
      </FieldGroup>
    </div>
  )
}
