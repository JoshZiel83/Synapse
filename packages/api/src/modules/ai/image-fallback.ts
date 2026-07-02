// AI image fallback — builds the model-facing text shown when a candidate model
// can't accept an image natively. This is PROMPT PRESENTATION (it emits hedging
// copy + a <FileRef>), so it lives in ai/ alongside its audio twin; the actual
// OCR runs through the provider-agnostic modules/ocr facade.
//
// The OCR here is on the OUTBOUND-LLM critical path (once per image block), so
// it is bounded by a short best-effort inline deadline independent of the
// parse-pipeline timeout: a slow OCR sidecar must not stall the prompt. The
// underlying recognizeOcr() keeps running in the background and populates the
// shared cache, so the next turn (or the parse pipeline) still benefits.

import type { CanonicalContentBlock } from "@synapse/shared"
import { config } from "../../config/index.js"
import { recognizeOcr } from "../ocr/index.js"
import type { OcrResult } from "../ocr/index.js"

type FileRefBlock = Extract<CanonicalContentBlock, { type: "file_ref" }>
type ImageFileBlock = FileRefBlock & { category: "image" }

/**
 * Resolve `recognizeOcr` but give up after `inlineDeadlineMs`, returning a
 * synthetic "unavailable" result. recognizeOcr never rejects and keeps running
 * in the background (caching its eventual result), so abandoning it here only
 * bounds THIS request's latency.
 */
function withInlineDeadline(
  promise: Promise<OcrResult>,
  deadlineMs: number
): Promise<OcrResult> {
  return new Promise<OcrResult>((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve({
        ok: false,
        text: "",
        provider: "",
        engineVersion: "",
        error: "OCR skipped (inline deadline exceeded)",
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
        // recognizeOcr never rejects; guard anyway so the deadline still fires.
      }
    )
  })
}

export async function buildImageFallbackContext(
  block: ImageFileBlock,
  reason: string
): Promise<string> {
  const ocr = await withInlineDeadline(
    recognizeOcr({ sha256: block.sha256, mimeType: block.mimeType }),
    config.ocr.inlineDeadlineMs
  )

  const fileRef = `<FileRef id="${block.sha256}"/>`
  const lines = [
    `[Image fallback] ${reason}`,
    `Original image FileRef: ${fileRef}`,
  ]

  if (ocr.ok && ocr.text) {
    lines.push(
      `The platform ran an OCR pass on this image; reference text (may be incomplete or incorrect): ${ocr.text}`
    )
  } else {
    lines.push(
      `Reference OCR text is unavailable (${ocr.error || "unknown error"}).`
    )
  }

  lines.push(
    `If you need the original image for another tool, pass the same FileRef ${fileRef} to that tool's fileRef parameter.`
  )
  return lines.join("\n")
}
