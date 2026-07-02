"use client"

// In-bubble video = a lightweight poster thumbnail (first frame via
// preload="metadata", no player chrome) with a centered play button + duration
// badge — the iMessage/Telegram/WhatsApp pattern. Clicking opens the full
// Vidstack player in a theater dialog, where it has room for its control bar
// (cramming the full layout into a 360px bubble is what overflowed before).
import { useState } from "react"
import dynamic from "next/dynamic"
import { Play } from "lucide-react"

const VideoTheater = dynamic(() => import("./video-theater"), { ssr: false })

function fmt(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return ""
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${s.toString().padStart(2, "0")}`
}

export default function VideoPlayer({
  url,
  title,
}: {
  url?: string
  mimeType?: string
  title: string
}) {
  const [open, setOpen] = useState(false)
  const [duration, setDuration] = useState(0)
  if (!url) return null

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`播放视频 ${title}`}
        className="group/vid relative block w-[360px] max-w-full overflow-hidden rounded-lg ring-1 ring-gray-200 dark:ring-white/[0.06]"
      >
        <video
          src={url}
          preload="metadata"
          muted
          playsInline
          tabIndex={-1}
          className="pointer-events-none aspect-video w-full bg-black object-cover"
          onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
        />
        <span className="absolute inset-0 flex items-center justify-center">
          <span className="flex size-12 items-center justify-center rounded-full bg-black/55 backdrop-blur-sm transition group-hover/vid:scale-105 group-hover/vid:bg-black/70">
            <Play
              className="size-6 translate-x-0.5 text-white"
              fill="currentColor"
            />
          </span>
        </span>
        {duration > 0 && (
          <span className="absolute right-2 bottom-2 rounded bg-black/65 px-1.5 py-0.5 font-mono text-[11px] text-white tabular-nums">
            {fmt(duration)}
          </span>
        )}
      </button>
      {open && (
        <VideoTheater url={url} title={title} onClose={() => setOpen(false)} />
      )}
    </>
  )
}
