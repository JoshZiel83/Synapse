"use client"

import * as React from "react"
import { EmojiPicker as EmojiPickerPrimitive } from "frimousse"
import { LoaderIcon, SearchIcon } from "lucide-react"

import { cn } from "@/lib/utils"

// shadcn-styled wrapper around Frimousse (https://frimousse.liveblocks.io) — a
// headless, virtualized emoji picker. Data is fetched from Emojibase (jsDelivr
// CDN) at runtime and cached. Compose inside a <Popover>.
function EmojiPicker({
  className,
  ...props
}: React.ComponentProps<typeof EmojiPickerPrimitive.Root>) {
  return (
    <EmojiPickerPrimitive.Root
      data-slot="emoji-picker"
      // web-next-design: load emojibase data from a self-hosted local copy
      // (public/emojibase/, copied by scripts/fetch-twemoji.mjs) instead of
      // Frimousse's default jsDelivr CDN — no external resources at runtime.
      emojibaseUrl="/emojibase"
      className={cn(
        "isolate flex h-full w-fit flex-col overflow-hidden rounded-md bg-popover text-popover-foreground",
        className
      )}
      {...props}
    />
  )
}

function EmojiPickerSearch({
  className,
  ...props
}: React.ComponentProps<typeof EmojiPickerPrimitive.Search>) {
  return (
    <div
      data-slot="emoji-picker-search-wrapper"
      className="flex h-9 items-center gap-2 border-b px-3"
    >
      <SearchIcon className="size-4 shrink-0 opacity-50" />
      <EmojiPickerPrimitive.Search
        data-slot="emoji-picker-search"
        className={cn(
          "flex h-10 w-full rounded-md bg-transparent py-3 text-sm outline-hidden placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50",
          className
        )}
        {...props}
      />
    </div>
  )
}

function EmojiPickerContent({
  className,
  ...props
}: React.ComponentProps<typeof EmojiPickerPrimitive.Viewport>) {
  return (
    <EmojiPickerPrimitive.Viewport
      data-slot="emoji-picker-content"
      className={cn("relative flex-1 outline-hidden", className)}
      {...props}
    >
      <EmojiPickerPrimitive.Loading className="absolute inset-0 flex items-center justify-center text-muted-foreground">
        <LoaderIcon className="size-4 animate-spin" />
      </EmojiPickerPrimitive.Loading>
      <EmojiPickerPrimitive.Empty className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
        未找到表情
      </EmojiPickerPrimitive.Empty>
      <EmojiPickerPrimitive.List
        className={cn(
          "pb-1 select-none",
          "[&_[frimousse-category-header]]:bg-popover [&_[frimousse-category-header]]:px-3 [&_[frimousse-category-header]]:pt-3 [&_[frimousse-category-header]]:pb-1.5 [&_[frimousse-category-header]]:text-xs [&_[frimousse-category-header]]:font-medium [&_[frimousse-category-header]]:text-muted-foreground",
          "[&_[frimousse-row]]:px-1",
          "[&_[frimousse-emoji]]:flex [&_[frimousse-emoji]]:size-8 [&_[frimousse-emoji]]:items-center [&_[frimousse-emoji]]:justify-center [&_[frimousse-emoji]]:rounded-md [&_[frimousse-emoji]]:text-lg [&_[frimousse-emoji][data-active]]:bg-accent"
        )}
      />
    </EmojiPickerPrimitive.Viewport>
  )
}

export { EmojiPicker, EmojiPickerSearch, EmojiPickerContent }
