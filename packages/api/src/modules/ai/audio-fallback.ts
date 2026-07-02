// AI audio fallback — builds the model-facing text shown when a candidate model
// can't accept audio natively. This is PROMPT PRESENTATION (it emits hedging copy
// + a <FileRef>), so it lives in ai/ alongside its image twin; the actual
// speech-to-text runs through the provider-agnostic modules/transcription facade.
//
// Transcription is on the OUTBOUND-LLM critical path (once per audio block) and
// is slower than OCR (seconds), so it is bounded by a short best-effort inline
// deadline: a slow sidecar / long clip must not stall the whole turn. The
// underlying transcribe() keeps running in the background and populates the
// shared cache, so the next turn benefits.

import type { CanonicalContentBlock } from "@synapse/shared"
import { config } from "../../config/index.js"
import { transcribe } from "../transcription/index.js"
import type { TranscriptionResult } from "../transcription/index.js"

type FileRefBlock = Extract<CanonicalContentBlock, { type: "file_ref" }>
type AudioFileBlock = FileRefBlock & { category: "audio" }

/**
 * Resolve `transcribe` but give up after `deadlineMs`, returning a synthetic
 * "unavailable" result. transcribe never rejects and keeps running in the
 * background (caching its eventual result), so abandoning it here only bounds
 * THIS request's latency.
 */
function withInlineDeadline(
  promise: Promise<TranscriptionResult>,
  deadlineMs: number
): Promise<TranscriptionResult> {
  return new Promise<TranscriptionResult>((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve({
        ok: false,
        text: "",
        provider: "",
        engineVersion: "",
        error: "transcription skipped (inline deadline exceeded)",
        retryable: true,
      })
    }, deadlineMs)
    promise.then(
      (result) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(result)
      },
      () => {
        // transcribe never rejects; guard anyway so the deadline still fires.
      }
    )
  })
}

export async function buildAudioFallbackContext(
  block: AudioFileBlock,
  reason: string
): Promise<string> {
  const result = await withInlineDeadline(
    transcribe({ sha256: block.sha256, mimeType: block.mimeType }),
    config.transcription.inlineDeadlineMs
  )

  const fileRef = `<FileRef id="${block.sha256}"/>`
  const lines = [
    `[Audio fallback] ${reason} The platform pre-transcribed this audio before building this request.`,
    `Original audio FileRef: ${fileRef}`,
  ]

  if (result.ok && result.text) {
    lines.push(`Reference transcript (may contain errors): ${result.text}`)
  } else {
    lines.push(
      `Reference transcript unavailable: ${result.error || "unknown error"}.`
    )
  }

  lines.push(
    `If you need the original audio for another tool, pass the same FileRef ${fileRef} to that tool's fileRef parameter.`
  )
  return lines.join("\n")
}
