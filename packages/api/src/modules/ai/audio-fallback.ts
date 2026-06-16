import type { CanonicalContentBlock } from "@synapse/shared"
import { execFile } from "node:child_process"
import { createRequire } from "module"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { LRUCache } from "lru-cache"
import { z } from "zod"
import { config } from "../../config/index.js"
import { createLogger } from "../../infrastructure/logger/index.js"
import { readContentBufferBySha } from "../files/service.js"

type FileRefBlock = Extract<CanonicalContentBlock, { type: "file_ref" }>
type AudioFileBlock = FileRefBlock & { category: "audio" }

interface AudioTranscriptResult {
  ok: boolean
  text?: string
  error?: string
}

// Bounded, TTL'd cache (was an unbounded Map). Caches the in-flight Promise so
// concurrent callers for the same key share one transcription run.
const transcriptCache = new LRUCache<string, Promise<AudioTranscriptResult>>({
  max: 500,
  ttl: 60 * 60 * 1000, // 1h
})
const localRequire = createRequire(import.meta.url)
const execFileAsync = promisify(execFile)
const warnedMessages = new Set<string>()
const log = createLogger("ai.audio-fallback")
const SherpaOnnxConfigJsonSchema = z.object({}).passthrough()

type SherpaOnnxModule = {
  OfflineRecognizer: new (config: Record<string, unknown>) => {
    createStream(): {
      acceptWaveform(obj: { sampleRate: number; samples: Float32Array }): void
    }
    decode(stream: unknown): void
    getResult(stream: unknown): Record<string, unknown>
  }
  readWaveFromBinary(
    data: Uint8Array,
    enableExternalBuffer?: boolean
  ): {
    sampleRate: number
    samples: Float32Array
  }
}

type NodeAvFfmpegModule = {
  ffmpegPath(): string
  isFfmpegAvailable(): boolean
}

let sherpaModulePromise: Promise<SherpaOnnxModule | null> | null = null
let ffmpegModulePromise: Promise<NodeAvFfmpegModule | null> | null = null
let recognizerPromise: Promise<InstanceType<
  SherpaOnnxModule["OfflineRecognizer"]
> | null> | null = null

function warnOnce(message: string): void {
  if (warnedMessages.has(message)) return
  warnedMessages.add(message)
  log.warn(`[audio-fallback] ${message}`)
}

function normalizeTranscript(text: string): string {
  return text.trim().replace(/\s+/g, " ").slice(0, 4000)
}

function guessExtension(block: AudioFileBlock): string {
  const byName = path
    .extname(block.name || "")
    .replace(".", "")
    .trim()
  if (byName) return byName

  const mime = block.mimeType.toLowerCase()
  if (mime.includes("mpeg") || mime.includes("mp3")) return "mp3"
  if (mime.includes("wav")) return "wav"
  if (mime.includes("webm")) return "webm"
  if (mime.includes("ogg")) return "ogg"
  if (mime.includes("aac")) return "aac"
  if (mime.includes("mp4") || mime.includes("m4a")) return "m4a"
  if (mime.includes("flac")) return "flac"
  return "bin"
}

export function parseSherpaOnnxConfigJson(
  rawConfig: string
): Record<string, unknown> | null {
  const raw = rawConfig.trim()
  if (!raw) return null

  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (err: any) {
    throw new Error(
      `invalid SHERPA_ONNX_CONFIG_JSON: ${err?.message || "parse failed"}`
    )
  }

  const parsed = SherpaOnnxConfigJsonSchema.safeParse(value)
  if (!parsed.success) {
    throw new Error("invalid SHERPA_ONNX_CONFIG_JSON: expected a JSON object")
  }
  return parsed.data
}

function getLocalSherpaConfig(): Record<string, unknown> | null {
  return parseSherpaOnnxConfigJson(config.audioFallback.sherpaOnnxConfigJson)
}

function pickTranscriptText(payload: unknown): string | null {
  if (typeof payload === "string") return payload.trim() || null
  if (!payload || typeof payload !== "object") return null

  const candidate = payload as Record<string, unknown>
  const directKeys = ["text", "transcript", "result"]
  for (const key of directKeys) {
    const value = candidate[key]
    if (typeof value === "string" && value.trim()) return value.trim()
  }

  if (candidate.result && typeof candidate.result === "object") {
    const nested = pickTranscriptText(candidate.result)
    if (nested) return nested
  }

  if (Array.isArray(candidate.segments)) {
    const joined = candidate.segments
      .map((segment) => {
        if (typeof segment === "string") return segment
        if (
          segment &&
          typeof segment === "object" &&
          typeof (segment as Record<string, unknown>).text === "string"
        ) {
          return String((segment as Record<string, unknown>).text)
        }
        return ""
      })
      .filter(Boolean)
      .join(" ")
    if (joined.trim()) return joined.trim()
  }

  return null
}

async function loadSherpaModule(): Promise<SherpaOnnxModule | null> {
  if (!sherpaModulePromise) {
    sherpaModulePromise = Promise.resolve().then(() => {
      try {
        return localRequire("sherpa-onnx-node") as SherpaOnnxModule
      } catch {
        return null
      }
    })
  }

  return sherpaModulePromise
}

async function loadNodeAvFfmpegModule(): Promise<NodeAvFfmpegModule | null> {
  if (!ffmpegModulePromise) {
    ffmpegModulePromise = Promise.resolve().then(() => {
      try {
        return localRequire("node-av/ffmpeg") as NodeAvFfmpegModule
      } catch {
        warnOnce(
          "node-av/ffmpeg is not installed. Audio transcoding and local transcription fallback will be skipped."
        )
        return null
      }
    })
  }

  return ffmpegModulePromise
}

async function transcodeAudioToWave(
  block: AudioFileBlock,
  inputBuffer: Buffer
): Promise<Buffer> {
  const ffmpeg = await loadNodeAvFfmpegModule()
  if (!ffmpeg) {
    throw new Error(
      "skipped audio transcoding and transcription because node-av/ffmpeg is not installed"
    )
  }

  if (!ffmpeg.isFfmpegAvailable()) {
    warnOnce(
      "node-av ffmpeg binary is not available. Audio transcoding and local transcription fallback will be skipped."
    )
    throw new Error(
      "skipped audio transcoding and transcription because the local node-av ffmpeg binary is not available"
    )
  }

  const tempDir = await mkdtemp(path.join(tmpdir(), "synapse-audio-"))
  const inputPath = path.join(tempDir, `input.${guessExtension(block)}`)
  const outputPath = path.join(tempDir, "output.wav")

  try {
    await writeFile(inputPath, inputBuffer)
    await execFileAsync(
      ffmpeg.ffmpegPath(),
      [
        "-y",
        "-i",
        inputPath,
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        "-f",
        "wav",
        outputPath,
      ],
      {
        timeout: config.audioFallback.timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
      }
    )

    return await readFile(outputPath)
  } catch (err: any) {
    const stderr = typeof err?.stderr === "string" ? err.stderr.trim() : ""
    throw new Error(
      stderr
        ? `audio transcode failed: ${stderr}`
        : `audio transcode failed: ${err?.message || "unknown error"}`
    )
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}

async function getLocalRecognizer(): Promise<InstanceType<
  SherpaOnnxModule["OfflineRecognizer"]
> | null> {
  const localConfig = getLocalSherpaConfig()
  if (!localConfig) return null

  if (!recognizerPromise) {
    recognizerPromise = (async () => {
      const sherpa = await loadSherpaModule()
      if (!sherpa) return null
      return new sherpa.OfflineRecognizer(localConfig)
    })()
  }

  return recognizerPromise
}

async function transcribeWithLocalSherpaOnnx(
  block: AudioFileBlock
): Promise<AudioTranscriptResult> {
  try {
    const recognizer = await getLocalRecognizer()
    if (!recognizer) {
      return {
        ok: false,
        error: "local sherpa-onnx recognizer is not configured",
      }
    }

    const buffer = await readContentBufferBySha(block.sha256)
    if (!buffer) {
      return {
        ok: false,
        error: "audio file not found",
      }
    }
    const waveBuffer = await transcodeAudioToWave(block, buffer)

    const sherpa = await loadSherpaModule()
    if (!sherpa) {
      return {
        ok: false,
        error: "sherpa-onnx-node is not installed",
      }
    }

    const wave = sherpa.readWaveFromBinary(new Uint8Array(waveBuffer))
    const stream = recognizer.createStream()
    stream.acceptWaveform({
      sampleRate: wave.sampleRate,
      samples: wave.samples,
    })
    recognizer.decode(stream)
    const result = recognizer.getResult(stream)
    const transcript = pickTranscriptText(result)
    if (!transcript) {
      return {
        ok: false,
        error: "local sherpa-onnx did not return a transcript",
      }
    }

    return {
      ok: true,
      text: normalizeTranscript(transcript),
    }
  } catch (err: any) {
    return {
      ok: false,
      error:
        err?.message || "failed to transcribe audio with local sherpa-onnx",
    }
  }
}

async function transcribeWithSherpaOnnx(
  block: AudioFileBlock
): Promise<AudioTranscriptResult> {
  return transcribeWithLocalSherpaOnnx(block)
}

async function getTranscript(
  block: AudioFileBlock
): Promise<AudioTranscriptResult> {
  const cacheKey = `${config.audioFallback.provider}:${block.sha256}`
  let pending = transcriptCache.get(cacheKey)
  if (!pending) {
    pending = transcribeWithSherpaOnnx(block)
    transcriptCache.set(cacheKey, pending)
  }
  return pending
}

export async function buildAudioFallbackContext(
  block: AudioFileBlock,
  reason: string
): Promise<string> {
  const transcript = await getTranscript(block)
  const fileRef = `<FileRef id="${block.sha256}"/>`
  const lines = [
    `[Audio fallback] ${reason} The platform pre-transcribed this audio with the default sherpa-onnx transcriber before building this request.`,
    `Original audio FileRef: ${fileRef}`,
  ]

  if (transcript.ok && transcript.text) {
    lines.push(`Reference transcript (may contain errors): ${transcript.text}`)
  } else {
    lines.push(
      `Reference transcript unavailable: ${transcript.error || "unknown error"}.`
    )
  }

  lines.push(
    `If you need the original audio for another tool, pass the same FileRef ${fileRef} to that tool's fileRef parameter.`
  )
  return lines.join("\n")
}
