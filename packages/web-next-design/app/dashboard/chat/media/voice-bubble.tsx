"use client"

// WhatsApp/Telegram-style voice bubble: a real loudness waveform as the
// scrubber, a circular play/pause, a live time counter, and a speed pill.
// Chrome is shadcn/lucide; wavesurfer only draws + seeks the waveform. Mounted
// client-only via next/dynamic(ssr:false) from message-bubble so its Web-Audio
// engine never runs during SSR and stays out of the timeline bundle.
import { useState } from "react"
import WavesurferPlayer from "@wavesurfer/react"
import type WaveSurfer from "wavesurfer.js"
import { Pause, Play } from "lucide-react"

const SPEEDS = [1, 1.5, 2] as const

function fmt(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "0:00"
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${s.toString().padStart(2, "0")}`
}

export default function VoiceBubble({
  url,
  name,
}: {
  url?: string
  name: string
}) {
  const [ws, setWs] = useState<WaveSurfer | null>(null)
  const [playing, setPlaying] = useState(false)
  const [current, setCurrent] = useState(0)
  const [duration, setDuration] = useState(0)
  const [speedIdx, setSpeedIdx] = useState(0)

  const cycleSpeed = () => {
    const next = (speedIdx + 1) % SPEEDS.length
    setSpeedIdx(next)
    ws?.setPlaybackRate(SPEEDS[next]) // preserves pitch by default
  }

  // Show elapsed once playback has started, total duration before that.
  const shown = current > 0 ? current : duration

  return (
    <div className="flex w-64 max-w-full items-center gap-2.5 rounded-lg bg-gray-50 p-2.5 ring-1 ring-gray-200 dark:bg-white/[0.03] dark:ring-white/[0.06]">
      <button
        type="button"
        onClick={() => ws?.playPause()}
        disabled={!ws}
        aria-label={playing ? "暂停" : "播放"}
        className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
      >
        {playing ? (
          <Pause className="size-4" />
        ) : (
          <Play className="size-4 translate-x-px" />
        )}
      </button>

      <div className="min-w-0 flex-1">
        <div className="mb-1 truncate text-[11px] text-muted-foreground">
          {name}
        </div>
        <WavesurferPlayer
          height={28}
          waveColor="#94a3b8"
          progressColor="#6366f1"
          cursorWidth={0}
          barWidth={2.5}
          barGap={2}
          barRadius={3}
          url={url}
          onReady={(w) => {
            setWs(w)
            setDuration(w.getDuration())
          }}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onFinish={() => {
            setPlaying(false)
            setCurrent(0)
          }}
          onTimeupdate={(w) => setCurrent(w.getCurrentTime())}
        />
      </div>

      <div className="flex shrink-0 flex-col items-end gap-1">
        <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
          {fmt(shown)}
        </span>
        <button
          type="button"
          onClick={cycleSpeed}
          aria-label="播放速度"
          className="rounded px-1 text-[10px] font-medium text-muted-foreground ring-1 ring-gray-200 transition ring-inset hover:text-foreground dark:ring-white/10"
        >
          {SPEEDS[speedIdx]}×
        </button>
      </div>
    </div>
  )
}
