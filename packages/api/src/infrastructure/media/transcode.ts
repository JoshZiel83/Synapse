/**
 * Audio transcoding for IM voice notes.
 *
 * Telegram (`sendVoice`), WhatsApp Cloud (`audio/ogg; codecs=opus`) and
 * WhatsApp/Baileys (`ptt:true`) all require a true voice note to be
 * **OGG/Opus, mono**. Arbitrary inbound audio (mp3/m4a/aac/wav/…) the
 * agent wants to send as a voice note must therefore be transcoded. The
 * repo had no transcoder before this; connectors shell out through here.
 *
 * Operational notes (see docs/telegram-whatsapp-connectors-plan.md §5.2):
 *  - `ffmpeg` is an OPERATIONAL dependency (must be on PATH or pointed at
 *    via `FFMPEG_PATH`). Callers gate `supportsVoice` on `ffmpegAvailable()`
 *    so a missing binary degrades voice → placeholder text rather than
 *    failing a send silently.
 *  - Transcoding runs in the API process and competes with the (currently
 *    concurrency-1) IM delivery worker, so it is bounded by a semaphore
 *    (`FFMPEG_MAX_CONCURRENCY`, default 2) and an input-duration cap. A
 *    16 MB transcode can pin a core; keep the bound low.
 */

import { spawn } from "node:child_process"
import { once } from "node:events"

/** Injected for tests; defaults to the real `child_process.spawn`. */
export type SpawnImpl = typeof spawn

const FFMPEG_BIN = process.env.FFMPEG_PATH || "ffmpeg"

function maxConcurrency(): number {
  const raw = Number.parseInt(process.env.FFMPEG_MAX_CONCURRENCY || "", 10)
  return Number.isFinite(raw) && raw > 0 ? raw : 2
}

// ───────────────────────── Bounded concurrency ─────────────────────────

let active = 0
const waiters: Array<() => void> = []

async function acquire(): Promise<void> {
  if (active < maxConcurrency()) {
    active += 1
    return
  }
  await new Promise<void>((resolve) => waiters.push(resolve))
  active += 1
}

function release(): void {
  active -= 1
  const next = waiters.shift()
  if (next) next()
}

// ───────────────────────── Opus detection ─────────────────────────

/**
 * Cheap, dependency-free check that a buffer is ALREADY an OGG container
 * carrying an Opus stream — in which case it is a valid voice note and we
 * skip the ffmpeg round-trip. An OGG file starts with the "OggS" capture
 * pattern and the first logical page of an Opus stream begins with the
 * "OpusHead" magic. We scan a small prefix for both.
 */
export function isOggOpus(buf: Buffer): boolean {
  if (buf.length < 36) return false
  if (buf.subarray(0, 4).toString("latin1") !== "OggS") return false
  // OpusHead lives in the first page; 64 bytes is a generous bound.
  return buf.subarray(0, 64).toString("latin1").includes("OpusHead")
}

// ───────────────────────── ffmpeg availability ─────────────────────────

let availabilityProbe: Promise<boolean> | undefined

/**
 * Whether `ffmpeg` can be invoked. Cached after the first probe (process
 * lifetime). Pass `force` in tests to re-probe. Never throws.
 */
export async function ffmpegAvailable(
  opts: { force?: boolean; spawnImpl?: SpawnImpl } = {}
): Promise<boolean> {
  if (!opts.force && availabilityProbe) return availabilityProbe
  const spawnImpl = opts.spawnImpl ?? spawn
  availabilityProbe = (async () => {
    try {
      const child = spawnImpl(FFMPEG_BIN, ["-version"], {
        stdio: ["ignore", "ignore", "ignore"],
      })
      const [code] = (await once(child, "close")) as [number | null]
      return code === 0
    } catch {
      return false
    }
  })()
  return availabilityProbe
}

// ───────────────────────── Transcode ─────────────────────────

export class TranscodeError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "TranscodeError"
  }
}

export interface TranscodeOpts {
  /**
   * Hard cap on the OUTPUT duration in seconds (ffmpeg `-t`). Bounds the
   * work for a hostile/huge input. Default 600 (10 min) — platforms reject
   * longer voice notes anyway.
   */
  maxDurationSec?: number
  /** Opus target bitrate; default 64k (voice-grade). */
  bitrate?: string
  /** Test seam. */
  spawnImpl?: SpawnImpl
  signal?: AbortSignal
}

/**
 * Transcode arbitrary audio (or the audio track of a video) into an
 * OGG/Opus **mono** 48 kHz buffer suitable for a voice note. Returns the
 * input unchanged when it is already OGG/Opus.
 *
 * Input is fed on stdin and output captured on stdout (OGG is streamable,
 * so no temp files / seeking are required for the muxer; the demuxer reads
 * the whole stdin buffer before producing output).
 */
export async function transcodeToOpusVoiceNote(
  input: Buffer,
  opts: TranscodeOpts = {}
): Promise<Buffer> {
  if (isOggOpus(input)) return input

  const spawnImpl = opts.spawnImpl ?? spawn
  const maxDurationSec = opts.maxDurationSec ?? 600
  const bitrate = opts.bitrate ?? "64k"

  await acquire()
  try {
    const args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      "pipe:0",
      // Strip video/subtitle/data — voice notes are audio only.
      "-vn",
      "-sn",
      "-dn",
      "-ar",
      "48000",
      "-ac",
      "1",
      "-c:a",
      "libopus",
      "-b:a",
      bitrate,
      "-t",
      String(maxDurationSec),
      "-f",
      "ogg",
      "pipe:1",
    ]

    const child = spawnImpl(FFMPEG_BIN, args, {
      stdio: ["pipe", "pipe", "pipe"],
      signal: opts.signal,
    })

    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    child.stdout?.on("data", (c: Buffer) => stdoutChunks.push(c))
    child.stderr?.on("data", (c: Buffer) => stderrChunks.push(c))

    // Surface stdin EPIPE (ffmpeg exiting before we finish writing) as a
    // transcode failure rather than an unhandled process error.
    let stdinError: unknown
    child.stdin?.on("error", (err) => {
      stdinError = err
    })
    child.stdin?.end(input)

    const [code] = (await once(child, "close")) as [number | null]
    if (code !== 0) {
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim()
      throw new TranscodeError(
        `ffmpeg exited ${code ?? "null"} transcoding voice note${
          stderr ? `: ${stderr.slice(0, 500)}` : ""
        }`,
        { cause: stdinError }
      )
    }
    const out = Buffer.concat(stdoutChunks)
    if (out.length === 0) {
      throw new TranscodeError("ffmpeg produced empty Opus output")
    }
    return out
  } catch (err) {
    if (err instanceof TranscodeError) throw err
    throw new TranscodeError(
      `voice-note transcode failed: ${(err as Error).message}`,
      { cause: err }
    )
  } finally {
    release()
  }
}
