"use client"

// A block editor that reads like a DOCUMENT, not a form. A borderless ordered list
// of our three canonical block kinds (text plain-string / file_ref / mention): no
// per-block card, no type label, no always-on trash, no between-block insert rails.
// Affordances are on-demand — a hover-revealed left gutter (⊕ 添加 / ⠿ 拖动), a "/"
// insert menu, Enter/Backspace block flow, pointer-drag reorder with a DragOverlay
// ghost. Neutral-dominant; primary only on the focus ring + upload progress (~10%).
// Shared by Skills, Actor docs, and Memory — one editor, upgraded everywhere.
import { useEffect, useRef, useState } from "react"
import {
  closestCenter,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core"
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { type CanonicalContentBlock } from "@synapse/shared"
import { GripVertical, Loader2, Paperclip, Plus, Type } from "lucide-react"
import { toast } from "sonner"

import {
  createEmptyTextContentBlock,
  fileRecordToBlock,
  type UploadedFile,
} from "@/components/actor-editor-model"
import { CanonicalContentRenderer } from "@/components/canonical-content-renderer"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import { api } from "@/lib/api"

type FileRefBlock = Extract<CanonicalContentBlock, { type: "file_ref" }>
type PendingFocus = { id: string; offset: number }

// ── insert menu (⊕ and "/" both open this) ──────────────────────────────────
function InsertMenu({
  open,
  onOpenChange,
  onPick,
  children,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  onPick: (kind: "text" | "file") => void
  children: React.ReactNode
}) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align="start" side="bottom" className="w-44 p-1">
        <button
          type="button"
          onClick={() => onPick("text")}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent"
        >
          <Type className="size-4 text-muted-foreground" /> 文本
        </button>
        <button
          type="button"
          onClick={() => onPick("file")}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent"
        >
          <Paperclip className="size-4 text-muted-foreground" /> 文件 / 图片
        </button>
      </PopoverContent>
    </Popover>
  )
}

// ── grip menu (⠿ click) ──────────────────────────────────────────────────────
function GripMenu({
  open,
  onOpenChange,
  onMove,
  onDuplicate,
  onRemove,
  children,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  onMove: (dir: -1 | 1) => void
  onDuplicate: () => void
  onRemove: () => void
  children: React.ReactNode
}) {
  const item =
    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent"
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align="start" side="bottom" className="w-32 p-1">
        <button type="button" className={item} onClick={() => onMove(-1)}>
          上移
        </button>
        <button type="button" className={item} onClick={() => onMove(1)}>
          下移
        </button>
        <button type="button" className={item} onClick={onDuplicate}>
          复制
        </button>
        <button
          type="button"
          className={cn(item, "text-red-600")}
          onClick={onRemove}
        >
          删除
        </button>
      </PopoverContent>
    </Popover>
  )
}

// ── one block row: hover gutter + content ────────────────────────────────────
function BlockRow({
  block,
  registerRef,
  onTextChange,
  onKeyDown,
  onInsert,
  onMove,
  onDuplicate,
  onRemove,
}: {
  block: CanonicalContentBlock
  registerRef: (id: string, el: HTMLTextAreaElement | null) => void
  onTextChange: (id: string, text: string) => void
  onKeyDown: (
    e: React.KeyboardEvent<HTMLTextAreaElement>,
    block: CanonicalContentBlock
  ) => void
  onInsert: (afterId: string, kind: "text" | "file") => void
  onMove: (id: string, dir: -1 | 1) => void
  onDuplicate: (id: string) => void
  onRemove: (id: string) => void
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: block.id })
  const [insertOpen, setInsertOpen] = useState(false)
  const [gripOpen, setGripOpen] = useState(false)

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "group relative flex items-start gap-1",
        isDragging && "opacity-40"
      )}
    >
      {/* left gutter — hidden at rest, fades in on hover/focus-within/menu-open */}
      <div
        className={cn(
          "flex shrink-0 items-center gap-0.5 pt-1 opacity-0 transition-opacity duration-100 group-focus-within:opacity-100 group-hover:opacity-100 motion-reduce:transition-none",
          (insertOpen || gripOpen) && "opacity-100"
        )}
      >
        <InsertMenu
          open={insertOpen}
          onOpenChange={setInsertOpen}
          onPick={(kind) => {
            setInsertOpen(false)
            onInsert(block.id, kind)
          }}
        >
          <button
            type="button"
            aria-label="添加"
            className="rounded p-0.5 text-muted-foreground/60 hover:bg-accent hover:text-foreground"
          >
            <Plus className="size-4" />
          </button>
        </InsertMenu>
        <GripMenu
          open={gripOpen}
          onOpenChange={setGripOpen}
          onMove={(dir) => {
            setGripOpen(false)
            onMove(block.id, dir)
          }}
          onDuplicate={() => {
            setGripOpen(false)
            onDuplicate(block.id)
          }}
          onRemove={() => {
            setGripOpen(false)
            onRemove(block.id)
          }}
        >
          <button
            type="button"
            aria-label="拖动"
            className="cursor-grab rounded p-0.5 text-muted-foreground/60 hover:bg-accent hover:text-foreground active:cursor-grabbing"
            {...attributes}
            {...listeners}
          >
            <GripVertical className="size-4" />
          </button>
        </GripMenu>
      </div>

      {/* content */}
      <div className="min-w-0 flex-1">
        {block.type === "text" ? (
          <textarea
            ref={(el) => registerRef(block.id, el)}
            rows={1}
            value={block.text}
            onChange={(e) => onTextChange(block.id, e.target.value)}
            onKeyDown={(e) => onKeyDown(e, block)}
            placeholder="输入内容，按 / 插入文件"
            className="[field-sizing:content] w-full resize-none border-0 bg-transparent p-0 text-sm leading-7 shadow-none outline-none placeholder:text-muted-foreground/50 focus-visible:ring-0"
          />
        ) : (
          <div className="py-0.5">
            <CanonicalContentRenderer blocks={[block]} />
          </div>
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
  label,
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
  const [activeId, setActiveId] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const pendingInsertRef = useRef<{ index: number; removeId?: string } | null>(
    null
  )
  const taRefs = useRef(new Map<string, HTMLTextAreaElement | null>())
  const pendingFocusRef = useRef<PendingFocus | null>(null)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 180, tolerance: 8 },
    }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  // focus the target block after a structural change (split / merge / insert)
  useEffect(() => {
    const pf = pendingFocusRef.current
    if (!pf) return
    const el = taRefs.current.get(pf.id)
    if (el) {
      el.focus()
      const at = Math.min(pf.offset, el.value.length)
      el.setSelectionRange(at, at)
      pendingFocusRef.current = null
    }
  }, [value])

  const registerRef = (id: string, el: HTMLTextAreaElement | null) => {
    if (el) taRefs.current.set(id, el)
    else taRefs.current.delete(id)
  }
  const indexOf = (id: string) => value.findIndex((b) => b.id === id)

  const updateText = (id: string, text: string) =>
    onChange(
      value.map((b) => (b.id === id && b.type === "text" ? { ...b, text } : b))
    )

  const insertText = (afterIndex: number, focus = true) => {
    const blk = createEmptyTextContentBlock("")
    const next = [...value]
    next.splice(afterIndex, 0, blk)
    if (focus) pendingFocusRef.current = { id: blk.id, offset: 0 }
    onChange(next)
  }

  const removeBlock = (id: string) => {
    onChange(value.filter((b) => b.id !== id))
  }
  const moveBlock = (id: string, dir: -1 | 1) => {
    const i = indexOf(id)
    const j = i + dir
    if (i < 0 || j < 0 || j >= value.length) return
    onChange(arrayMove(value, i, j))
  }
  const duplicateBlock = (id: string) => {
    const i = indexOf(id)
    if (i < 0) return
    const src = value[i]
    const copy =
      src.type === "text"
        ? createEmptyTextContentBlock(src.text)
        : { ...src, id: createEmptyTextContentBlock("").id }
    const next = [...value]
    next.splice(i + 1, 0, copy as CanonicalContentBlock)
    onChange(next)
  }

  const openFilePicker = (index: number, removeId?: string) => {
    pendingInsertRef.current = { index, removeId }
    fileInputRef.current?.click()
  }

  const onInsert = (afterId: string, kind: "text" | "file") => {
    const i = indexOf(afterId)
    const anchor = value[i]
    const anchorEmpty = anchor?.type === "text" && anchor.text.trim() === ""
    if (kind === "text") {
      insertText(i + 1)
    } else {
      // "/" on an empty block replaces it; ⊕ inserts after
      openFilePicker(anchorEmpty ? i : i + 1, anchorEmpty ? afterId : undefined)
    }
  }

  async function insertFiles(index: number, files: File[], removeId?: string) {
    if (!workspaceId || files.length === 0) return
    setUploading(true)
    try {
      const blocks: FileRefBlock[] = []
      for (const file of files) {
        const uploaded = (await api.uploadFile(
          workspaceId,
          file
        )) as UploadedFile
        blocks.push(fileRecordToBlock(uploaded))
      }
      let base = removeId ? value.filter((b) => b.id !== removeId) : [...value]
      const at = removeId ? Math.min(index, base.length) : index
      base = [...base.slice(0, at), ...blocks, ...base.slice(at)]
      onChange(base)
      toast.success(`已插入 ${blocks.length} 个文件`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "文件插入失败")
    } finally {
      setUploading(false)
    }
  }

  // keyboard block-flow: Enter split · Backspace-at-start merge · "/" menu
  function onKeyDown(
    e: React.KeyboardEvent<HTMLTextAreaElement>,
    block: CanonicalContentBlock
  ) {
    if (e.nativeEvent.isComposing) return // IME guard — never split mid-pinyin
    if (block.type !== "text") return
    const ta = e.currentTarget
    const i = indexOf(block.id)

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      const before = block.text.slice(0, ta.selectionStart)
      const after = block.text.slice(ta.selectionEnd)
      const blk = createEmptyTextContentBlock(after)
      const next = value.map((b) =>
        b.id === block.id && b.type === "text" ? { ...b, text: before } : b
      )
      next.splice(i + 1, 0, blk)
      pendingFocusRef.current = { id: blk.id, offset: 0 }
      onChange(next)
      return
    }

    if (
      e.key === "Backspace" &&
      ta.selectionStart === 0 &&
      ta.selectionEnd === 0 &&
      i > 0
    ) {
      const prev = value[i - 1]
      if (prev.type === "text") {
        e.preventDefault()
        const merged = prev.text + block.text
        const next = value
          .map((b) =>
            b.id === prev.id && b.type === "text" ? { ...b, text: merged } : b
          )
          .filter((b) => b.id !== block.id)
        pendingFocusRef.current = { id: prev.id, offset: prev.text.length }
        onChange(next)
      } else if (block.text === "") {
        // empty text block after an atom → drop the atom
        e.preventDefault()
        onChange(value.filter((b) => b.id !== prev.id))
      }
      return
    }

    if (e.key === "ArrowUp" && ta.selectionStart === 0 && i > 0) {
      const prev = taRefs.current.get(value[i - 1].id)
      if (prev) {
        e.preventDefault()
        prev.focus()
        prev.setSelectionRange(prev.value.length, prev.value.length)
      }
      return
    }
    if (
      e.key === "ArrowDown" &&
      ta.selectionStart === ta.value.length &&
      i < value.length - 1
    ) {
      const nxt = taRefs.current.get(value[i + 1].id)
      if (nxt) {
        e.preventDefault()
        nxt.focus()
        nxt.setSelectionRange(0, 0)
      }
      return
    }

    if (
      (e.metaKey || e.ctrlKey) &&
      e.shiftKey &&
      (e.key === "ArrowUp" || e.key === "ArrowDown")
    ) {
      e.preventDefault()
      moveBlock(block.id, e.key === "ArrowUp" ? -1 : 1)
    }
  }

  function onDragEnd(e: DragEndEvent) {
    setActiveId(null)
    const { active, over } = e
    if (!over || active.id === over.id) return
    const oldIndex = indexOf(String(active.id))
    const newIndex = indexOf(String(over.id))
    if (oldIndex < 0 || newIndex < 0) return
    onChange(arrayMove(value, oldIndex, newIndex))
  }

  function onEditorDrop(e: React.DragEvent<HTMLDivElement>) {
    const files = Array.from(e.dataTransfer.files || [])
    if (files.length === 0) return
    e.preventDefault()
    void insertFiles(value.length, files)
  }

  const activeBlock = activeId ? value.find((b) => b.id === activeId) : null

  return (
    <div className="flex flex-col gap-2">
      {(label || description || showCount) && (
        <div className="flex items-center justify-between gap-3">
          <div>
            {label && <div className="text-sm font-medium">{label}</div>}
            {description && (
              <div className="text-xs text-muted-foreground">{description}</div>
            )}
          </div>
          {showCount && (
            <span className="text-xs text-muted-foreground/60">
              {value.length} 块
            </span>
          )}
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files || [])
          const pending = pendingInsertRef.current
          if (files.length > 0)
            void insertFiles(
              pending?.index ?? value.length,
              files,
              pending?.removeId
            )
          pendingInsertRef.current = null
          e.target.value = ""
        }}
      />

      <div
        onDrop={onEditorDrop}
        onDragOver={(e) =>
          e.dataTransfer.files.length > 0 && e.preventDefault()
        }
      >
        {value.length === 0 ? (
          <button
            type="button"
            onClick={() => insertText(0)}
            className="w-full rounded-lg px-1 py-2 text-left text-sm text-muted-foreground/50 hover:text-muted-foreground"
          >
            {placeholder || "输入内容，按 / 插入文件…"}
          </button>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragStart={(e: DragStartEvent) =>
              setActiveId(String(e.active.id))
            }
            onDragEnd={onDragEnd}
            onDragCancel={() => setActiveId(null)}
          >
            <SortableContext
              items={value.map((b) => b.id)}
              strategy={verticalListSortingStrategy}
            >
              <div className="flex flex-col gap-0.5">
                {value.map((block) => (
                  <BlockRow
                    key={block.id}
                    block={block}
                    registerRef={registerRef}
                    onTextChange={updateText}
                    onKeyDown={onKeyDown}
                    onInsert={onInsert}
                    onMove={moveBlock}
                    onDuplicate={duplicateBlock}
                    onRemove={removeBlock}
                  />
                ))}
              </div>
            </SortableContext>
            <DragOverlay>
              {activeBlock ? (
                <div className="rounded-lg border bg-card px-2 py-1 text-sm opacity-90 shadow-lg ring-1 ring-border">
                  {activeBlock.type === "text"
                    ? activeBlock.text.slice(0, 60) || "空文本块"
                    : activeBlock.type === "file_ref"
                      ? activeBlock.name
                      : "提及"}
                </div>
              ) : null}
            </DragOverlay>
          </DndContext>
        )}

        {uploading && (
          <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin text-primary" /> 正在上传…
          </div>
        )}
      </div>
    </div>
  )
}
