/**
 * The ONE place canonical conversation → AI-SDK ModelMessage[] conversion happens.
 *
 * Replaces the per-adapter convertMessages/resolveBlocks that lived in all four
 * hand-rolled providers. The output is provider-NEUTRAL: the AI-SDK provider
 * converters fan it out to each wire format (Anthropic tool_use / OpenAI
 * tool_calls / Responses function_call) on every call, regenerating native tool
 * ids from the neutral toolCallId. This is why a single compiled array continues
 * correctly across a provider switch (Spike 2).
 *
 * It is compiled PER CANDIDATE: attachment/multimodal degradation depends on the
 * candidate binding's MultimodalConfig, so the same ConversationMessage[] yields
 * different ModelMessage[] for a vision-capable vs text-only model.
 *
 * Synapse conventions that the SDK does NOT know about are preserved here:
 *  - FileRef/CAS resolution (sha256 → bytes), base64-inline vs hosted-URL threshold
 *  - multimodal capability gate + text fallback (audio/image fallback context)
 *  - FileRef hint injection after every file_ref
 *  - MCP structuredContent suffix on tool results
 */
import type {
  CanonicalContentBlock,
  CanonicalFileRefBlock,
  CanonicalToolResult,
  ConversationMessage,
  MultimodalConfig,
} from "@synapse/shared"
import {
  extractText,
  formatBytes,
  formatMentionText,
  formatStructuredContentForProvider,
} from "@synapse/shared"
import type {
  ModelMessage,
  FilePart,
  ImagePart,
  TextPart,
  ToolCallPart,
  ToolResultPart,
} from "ai"
import {
  getFullContentUrlBySha,
  readContentBufferBySha,
} from "../../files/service.js"
import { buildAudioFallbackContext } from "../audio-fallback.js"
import { buildImageFallbackContext } from "../image-fallback.js"
import { createLogger } from "../../../infrastructure/logger/index.js"

const log = createLogger("ai.to-model-messages")

const SUPPORTED_IMAGE_FORMATS = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
])

// Inline as base64 below this size; above it, hand the provider a hosted URL.
// (Anthropic enforces 5 MB; OpenAI 20 MB. We use the conservative 5 MB so a
//  single neutral array is safe to send to ANY candidate after a switch.)
const BASE64_THRESHOLD = 5 * 1024 * 1024

type UserPart = TextPart | ImagePart | FilePart

async function ensureSupportedImage(
  buffer: Buffer,
  mimeType: string
): Promise<{ buffer: Buffer; mimeType: string }> {
  if (SUPPORTED_IMAGE_FORMATS.has(mimeType)) return { buffer, mimeType }
  try {
    const sharp = (await import("sharp")).default
    const converted = await sharp(buffer).png().toBuffer()
    return { buffer: converted, mimeType: "image/png" }
  } catch (err) {
    log.error({ err }, `Failed to convert ${mimeType} to PNG`)
    return { buffer, mimeType }
  }
}

function buildFileRefHint(block: CanonicalFileRefBlock): string {
  const handle = block.path ?? `sha256:${block.sha256}`
  return [
    `This ${block.category} "${block.name}" is available at ${handle}.`,
    block.path
      ? `To reference it, use its path: ${block.path}.`
      : `It is a stored content reference (no live path).`,
  ].join(" ")
}

/** Resolve a single file_ref into AI-SDK user parts (the media part + a hint),
 *  or a text fallback when the candidate can't accept this category. */
async function resolveFileRef(
  block: CanonicalFileRefBlock,
  supported: Set<string>
): Promise<UserPart[]> {
  const hintPart: TextPart = { type: "text", text: buildFileRefHint(block) }

  if (!supported.has(block.category)) {
    let desc: string
    switch (block.category) {
      case "audio":
        desc = await buildAudioFallbackContext(
          { ...block, category: "audio" },
          "Audio input is not enabled for this model configuration."
        )
        break
      case "image":
        desc = await buildImageFallbackContext(
          { ...block, category: "image" },
          "Image input is not enabled for this model configuration."
        )
        break
      default:
        desc = `[${block.category}: ${block.name} (${block.mimeType}, ${formatBytes(block.sizeBytes)})]`
    }
    return [{ type: "text", text: desc }, hintPart]
  }

  try {
    let buffer = await readContentBufferBySha(block.sha256)
    if (!buffer) throw new Error("file not found")
    let mimeType = block.mimeType

    if (block.category === "image") {
      const converted = await ensureSupportedImage(buffer, mimeType)
      buffer = converted.buffer
      mimeType = converted.mimeType
    }

    const underThreshold = buffer.length <= BASE64_THRESHOLD

    if (block.category === "image") {
      const image: ImagePart = underThreshold
        ? { type: "image", image: buffer, mediaType: mimeType }
        : {
            type: "image",
            image: new URL(getFullContentUrlBySha(block.sha256)),
            mediaType: mimeType,
          }
      return [image, hintPart]
    }

    // document / audio / video → FilePart (the SDK + provider decide support;
    // unsupported ones degrade provider-side). Audio/video that a provider
    // can't take will surface as a provider error, which the loop classifies.
    const file: FilePart = underThreshold
      ? {
          type: "file",
          data: buffer,
          mediaType: mimeType,
          filename: block.name,
        }
      : {
          type: "file",
          data: new URL(getFullContentUrlBySha(block.sha256)),
          mediaType: mimeType,
          filename: block.name,
        }
    return [file, hintPart]
  } catch (err: any) {
    log.error(
      { err: err?.message },
      `Failed to resolve file_ref ${block.sha256}`
    )
    return [
      {
        type: "text",
        text: `[${block.category}: ${block.name} (read failed)]`,
      },
      hintPart,
    ]
  }
}

async function resolveUserParts(
  blocks: CanonicalContentBlock[],
  supported: Set<string>
): Promise<UserPart[]> {
  const parts: UserPart[] = []
  for (const block of blocks) {
    if (block.type === "text") {
      parts.push({ type: "text", text: block.text })
    } else if (block.type === "mention") {
      parts.push({ type: "text", text: formatMentionText(block) })
    } else {
      parts.push(...(await resolveFileRef(block, supported)))
    }
  }
  return parts
}

/** Build the tool-result `output` discriminated union. Never a bare object
 *  (avoids Anthropic [object Object]); errors → error-text; structured-only →
 *  json; otherwise text/content with the structuredContent suffix appended. */
function toToolOutput(result: CanonicalToolResult): ToolResultPart["output"] {
  const text = extractText(result.content)
  const suffix = formatStructuredContentForProvider(result.structuredContent)
  const combined = (text + suffix).trim()

  if (result.isError) {
    return { type: "error-text", value: combined || "tool error" }
  }
  // If there is no textual content but there IS structured content, send it as
  // JSON so the model receives the structured payload faithfully.
  if (!text && result.structuredContent) {
    return { type: "json", value: result.structuredContent as any }
  }
  return { type: "text", value: combined }
}

export async function toModelMessages(
  messages: ConversationMessage[],
  opts: { multimodal?: MultimodalConfig } = {}
): Promise<ModelMessage[]> {
  const supported = opts.multimodal?.supported
    ? new Set<string>(opts.multimodal.types)
    : new Set<string>()

  const out: ModelMessage[] = []

  for (const msg of messages) {
    switch (msg.role) {
      case "user": {
        const parts = await resolveUserParts(msg.content, supported)
        out.push({
          role: "user",
          content: parts.length > 0 ? parts : "",
        })
        break
      }
      case "assistant": {
        const content: Array<TextPart | ToolCallPart> = []
        const text = extractText(msg.content)
        if (text) content.push({ type: "text", text })
        for (const tc of msg.toolCalls ?? []) {
          content.push({
            type: "tool-call",
            toolCallId: tc.callId,
            toolName: tc.toolName,
            input: tc.input,
          })
        }
        out.push({ role: "assistant", content })
        break
      }
      case "tool_result": {
        const content: ToolResultPart[] = msg.results.map((tr) => ({
          type: "tool-result",
          toolCallId: tr.toolCallId,
          toolName: tr.toolName,
          output: toToolOutput(tr),
        }))
        out.push({ role: "tool", content })
        break
      }
    }
  }

  return out
}
