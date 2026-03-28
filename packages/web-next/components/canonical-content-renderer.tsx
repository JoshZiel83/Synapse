"use client"

import { type CanonicalContentBlock } from "@synapse/shared"
import { FileAudio, FileText, Film, ImageIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { cn, resolveFileUrl } from "@/lib/utils"

type FileRefBlock = Extract<CanonicalContentBlock, { type: "file_ref" }>
type MentionBlock = Extract<CanonicalContentBlock, { type: "mention" }>

function FilePreview({ file }: { file: FileRefBlock }) {
  const fileUrl = resolveFileUrl(file.url)

  if (file.category === "image") {
    return (
      <a
        href={fileUrl}
        target="_blank"
        rel="noreferrer"
        className="overflow-hidden rounded-3xl border border-border bg-muted/30"
      >
        {fileUrl ? (
          <img
            src={fileUrl}
            alt={file.originalName}
            className="aspect-[16/10] w-full object-cover"
          />
        ) : (
          <div className="flex aspect-[16/10] items-center justify-center">
            <ImageIcon className="size-8 text-muted-foreground" />
          </div>
        )}
        <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-3">
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-foreground">
              {file.originalName}
            </div>
            <div className="text-xs text-muted-foreground">{file.mimeType}</div>
          </div>
          <Badge variant="outline">image</Badge>
        </div>
      </a>
    )
  }

  if (file.category === "video") {
    return (
      <div className="overflow-hidden rounded-3xl border border-border bg-muted/30">
        {fileUrl ? (
          <video
            controls
            src={fileUrl}
            className="aspect-video w-full bg-black/90"
          />
        ) : (
          <div className="flex aspect-video items-center justify-center">
            <Film className="size-8 text-muted-foreground" />
          </div>
        )}
        <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-3">
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-foreground">
              {file.originalName}
            </div>
            <div className="text-xs text-muted-foreground">{file.mimeType}</div>
          </div>
          <Badge variant="outline">video</Badge>
        </div>
      </div>
    )
  }

  if (file.category === "audio") {
    return (
      <div className="rounded-3xl border border-border bg-muted/30 p-4">
        <div className="mb-3 flex items-center gap-3">
          <div className="flex size-11 items-center justify-center rounded-2xl bg-background text-muted-foreground">
            <FileAudio className="size-5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-foreground">
              {file.originalName}
            </div>
            <div className="text-xs text-muted-foreground">{file.mimeType}</div>
          </div>
          <Badge variant="outline">audio</Badge>
        </div>
        {fileUrl ? <audio controls src={fileUrl} className="w-full" /> : null}
      </div>
    )
  }

  return (
    <a
      href={fileUrl}
      target="_blank"
      rel="noreferrer"
      className="flex items-center gap-3 rounded-3xl border border-border bg-muted/30 px-4 py-4 transition-colors hover:bg-accent/60"
    >
      <div className="flex size-11 items-center justify-center rounded-2xl bg-background text-muted-foreground">
        <FileText className="size-5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-foreground">
          {file.originalName}
        </div>
        <div className="text-xs text-muted-foreground">{file.mimeType}</div>
      </div>
      <Badge variant="outline">document</Badge>
    </a>
  )
}

function MentionPreview({ block }: { block: MentionBlock }) {
  const name = block.mention.name?.trim() || "Unknown"

  return (
    <div className="inline-flex items-center gap-2 rounded-full border border-border bg-muted/30 px-3 py-1.5 text-sm text-foreground">
      <span className="font-medium">@{name}</span>
      <span className="text-xs text-muted-foreground">
        {block.mention.memberType}
      </span>
    </div>
  )
}

export function CanonicalContentRenderer({
  blocks,
  emptyText = "No content yet.",
  className,
}: {
  blocks: CanonicalContentBlock[]
  emptyText?: string
  className?: string
}) {
  if (blocks.length === 0) {
    return (
      <p className={cn("text-sm text-muted-foreground", className)}>
        {emptyText}
      </p>
    )
  }

  return (
    <div className={cn("flex flex-col gap-5", className)}>
      {blocks.map((block) =>
        block.type === "text" ? (
          <div
            key={block.id}
            className="rounded-3xl border border-border bg-background/70 px-4 py-3 text-sm leading-7 whitespace-pre-wrap text-foreground/85"
          >
            {block.text || (
              <span className="text-muted-foreground">Empty text block</span>
            )}
          </div>
        ) : block.type === "mention" ? (
          <MentionPreview key={block.id} block={block} />
        ) : (
          <FilePreview key={block.id} file={block} />
        )
      )}
    </div>
  )
}
