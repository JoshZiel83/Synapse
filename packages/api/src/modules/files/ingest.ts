/**
 * Unified ingest funnel — single entry point for converting heterogeneous
 * tool outputs into CanonicalContentBlock[].
 *
 * Sources:
 *   - Remote MCP server responses (text / image base64 / image url /
 *     audio / resource / pre-canonical file_ref / mention)
 *   - Device-runtime MCP async results (same shapes as remote MCP)
 *   - Callable plugin returns (already canonical, but may include raw text)
 *   - Model response media (image blocks returned by Anthropic et al)
 *
 * Replaces the previously duplicated logic in mcp-plugins/result-normalizer
 * (normalizeMcpContentArray) and ai/content-ingest (ingestToolResultContent).
 * Origin-aware: caller supplies a ToolResultOrigin and we attribute every
 * stored file (and downstream CanonicalToolResult.origin) accordingly.
 */
import {
  normalizeCanonicalContentBlocks,
  parseJsonObjectOrUndefined,
  textBlock,
  type CanonicalContentBlock,
  type ToolResultOrigin,
} from "@synapse/shared"
import { FILE_ORIGIN_SYSTEMS } from "@synapse/shared/constants"
import {
  saveFromBase64,
  saveFromUrl,
  type FileRecord,
} from "../../infrastructure/storage/file-io.js"
import {
  buildModelOutputOrigin,
  buildToolOutputOrigin,
  resolveModelResponseMediaOriginSystem,
  toCanonicalFileRefBlock,
  type FileOriginInput,
} from "./service.js"
import { createLogger } from "../../infrastructure/logger/index.js"

const log = createLogger("files.ingest")

export interface IngestContext {
  workspaceId: string
  origin: ToolResultOrigin
  // Optional extra metadata to merge into the FileRecord origin.details
  // (per-call hints like task id, conversation id).
  binaryMetadata?: Record<string, unknown>
  // Test seam: override the disk persistence functions. Defaults call the
  // real storage layer. Tests pass stubs so they don't need disk/DB.
  storage?: {
    saveFromBase64?: typeof saveFromBase64
    saveFromUrl?: typeof saveFromUrl
    toFileRefBlock?: (rec: FileRecord) => CanonicalContentBlock
  }
}

function getStorage(ctx: IngestContext) {
  return {
    saveFromBase64: ctx.storage?.saveFromBase64 || saveFromBase64,
    saveFromUrl: ctx.storage?.saveFromUrl || saveFromUrl,
    toFileRefBlock: ctx.storage?.toFileRefBlock || toCanonicalFileRefBlock,
  }
}

/**
 * Translate a CanonicalToolResult ToolResultOrigin into the FileOriginInput
 * shape the storage layer expects. The mapping is:
 *
 *   system / plugin / device / provider_native → tool_output family
 *     (system always MCP_TOOL_RESULT_INGEST; the discriminator + per-kind
 *     fields are preserved in origin.details so downstream audit can see
 *     where the file came from)
 *   model_response → model_output family
 *     (system picked per provider; providerKey set from origin.providerType)
 */
function originToFileOrigin(
  origin: ToolResultOrigin,
  extraDetails?: Record<string, unknown>
): FileOriginInput {
  const baseDetails: Record<string, unknown> = { ...(extraDetails || {}) }

  if (origin.kind === "model_response") {
    return buildModelOutputOrigin({
      system: resolveModelResponseMediaOriginSystem(origin.providerType),
      providerKey: origin.providerType,
      details: { ...baseDetails, originKind: origin.kind },
    })
  }

  const details: Record<string, unknown> = {
    ...baseDetails,
    originKind: origin.kind,
    ...origin,
  }

  let providerKey: string | undefined
  let pluginId: string | undefined
  if (origin.kind === "system") {
    providerKey = origin.registryKey
  } else if (origin.kind === "plugin") {
    providerKey = origin.installationId
    pluginId = origin.installationId
  } else if (origin.kind === "device") {
    providerKey = origin.exposureStableKey
  } else if (origin.kind === "provider_native") {
    providerKey = `${origin.providerType}:${origin.toolName}`
  }

  return buildToolOutputOrigin({
    system: FILE_ORIGIN_SYSTEMS.MCP_TOOL_RESULT_INGEST,
    providerKey,
    pluginId: pluginId ?? null,
    details,
  })
}

// Business JSON decode → shared parseJsonObjectOrUndefined (object-only,
// array-reject, undefined fallback). r6 P1-8: replaces a local copy.
const asRecord = parseJsonObjectOrUndefined

function mergeBinaryMetadata(
  base?: Record<string, unknown>,
  specific?: Record<string, unknown>
): Record<string, unknown> {
  if (!base && !specific) return {}
  return { ...(base || {}), ...(specific || {}) }
}

/**
 * Convert any tool-output payload into CanonicalContentBlock[].
 *
 * Accepts:
 *  - string → wrapped as a single text block
 *  - unknown[] → MCP content blocks (text / image / audio / resource /
 *    pre-canonical file_ref / mention); binaries stored to files table
 *  - already-canonical CanonicalContentBlock[] → pass through normalizer
 */
export async function ingestToolOutput(
  raw: string | unknown[],
  ctx: IngestContext
): Promise<CanonicalContentBlock[]> {
  if (typeof raw === "string") {
    return [textBlock(raw)]
  }

  if (!Array.isArray(raw)) {
    return [
      textBlock(typeof raw === "object" ? JSON.stringify(raw) : String(raw)),
    ]
  }

  const blocks: CanonicalContentBlock[] = []
  const origin = originToFileOrigin(ctx.origin, ctx.binaryMetadata)
  const storage = getStorage(ctx)

  for (const item of raw) {
    if (!item || typeof item !== "object") {
      blocks.push(textBlock(String(item)))
      continue
    }
    const block = item as Record<string, unknown>

    switch (block.type) {
      case "text":
        blocks.push(textBlock(typeof block.text === "string" ? block.text : ""))
        break

      case "file_ref":
        // Already canonical — validate and pass through.
        blocks.push(...normalizeCanonicalContentBlocks([block as any]))
        break

      case "mention":
        // Pre-canonical mention block (rare; emitted by Synapse-built MCP
        // servers). Validate and pass through.
        blocks.push(...normalizeCanonicalContentBlocks([block as any]))
        break

      case "image":
        await ingestImage(block, ctx.workspaceId, origin, storage, blocks)
        break

      case "audio":
        await ingestAudio(block, ctx.workspaceId, origin, storage, blocks)
        break

      case "resource":
        await ingestResource(block, ctx, origin, storage, blocks)
        break

      default:
        if (typeof block.text === "string" && block.text) {
          blocks.push(textBlock(block.text))
        } else {
          blocks.push(textBlock(JSON.stringify(block)))
        }
        break
    }
  }

  return blocks
}

async function ingestImage(
  block: Record<string, unknown>,
  workspaceId: string,
  origin: FileOriginInput,
  storage: ReturnType<typeof getStorage>,
  blocks: CanonicalContentBlock[]
): Promise<void> {
  try {
    const source = asRecord(block.source)
    // Anthropic-style {source: {type:"base64", media_type, data}}
    if (source && typeof source.data === "string") {
      const mimeType = (source.media_type as string) || "image/png"
      const rec = await storage.saveFromBase64(
        source.data,
        `mcp-image.${extensionForMime(mimeType)}`,
        mimeType,
        workspaceId,
        null,
        origin
      )
      blocks.push(storage.toFileRefBlock(rec))
      return
    }
    // Anthropic-style {source: {type:"url", url}}
    if (source && source.type === "url" && typeof source.url === "string") {
      const rec = await storage.saveFromUrl(
        source.url,
        workspaceId,
        null,
        "mcp-image.png",
        origin
      )
      blocks.push(storage.toFileRefBlock(rec))
      return
    }
    // MCP-standard {data, mimeType}
    if (typeof block.data === "string") {
      const mimeType =
        (block.mimeType as string) || (block.mime_type as string) || "image/png"
      const rec = await storage.saveFromBase64(
        block.data,
        `mcp-image.${extensionForMime(mimeType)}`,
        mimeType,
        workspaceId,
        null,
        origin
      )
      blocks.push(storage.toFileRefBlock(rec))
      return
    }
    blocks.push(
      textBlock(`[Image: missing data, keys=${Object.keys(block).join(",")}]`)
    )
  } catch (err: any) {
    log.error({ err }, "[ingest-tool-output] Failed to ingest image")
    blocks.push(textBlock(`[Image: ingest failed - ${err.message}]`))
  }
}

async function ingestAudio(
  block: Record<string, unknown>,
  workspaceId: string,
  origin: FileOriginInput,
  storage: ReturnType<typeof getStorage>,
  blocks: CanonicalContentBlock[]
): Promise<void> {
  try {
    if (typeof block.data === "string") {
      const mimeType =
        (block.mimeType as string) || (block.mime_type as string) || "audio/wav"
      const rec = await storage.saveFromBase64(
        block.data,
        `mcp-audio.${extensionForMime(mimeType)}`,
        mimeType,
        workspaceId,
        null,
        origin
      )
      blocks.push(storage.toFileRefBlock(rec))
      return
    }
    blocks.push(textBlock("[Audio: missing data]"))
  } catch (err: any) {
    log.error({ err }, "[ingest-tool-output] Failed to ingest audio")
    blocks.push(textBlock(`[Audio: ingest failed - ${err.message}]`))
  }
}

async function ingestResource(
  block: Record<string, unknown>,
  ctx: IngestContext,
  baseOrigin: FileOriginInput,
  storage: ReturnType<typeof getStorage>,
  blocks: CanonicalContentBlock[]
): Promise<void> {
  const resource = asRecord(block.resource)
  if (!resource) {
    blocks.push(textBlock(JSON.stringify(block)))
    return
  }
  try {
    if (typeof resource.text === "string") {
      blocks.push(textBlock(resource.text))
      return
    }
    if (
      typeof resource.blob === "string" &&
      typeof resource.mimeType === "string"
    ) {
      const mimeType = resource.mimeType
      const originalName =
        typeof resource.name === "string" && resource.name.trim().length > 0
          ? resource.name.trim()
          : `mcp-resource.${extensionForMime(mimeType)}`
      const perFileOrigin = originToFileOrigin(
        ctx.origin,
        mergeBinaryMetadata(ctx.binaryMetadata, asRecord(resource.metadata))
      )
      const rec = await storage.saveFromBase64(
        resource.blob,
        originalName,
        mimeType,
        ctx.workspaceId,
        null,
        perFileOrigin
      )
      blocks.push(storage.toFileRefBlock(rec))
      return
    }
    if (typeof resource.uri === "string") {
      blocks.push(textBlock(String(resource.uri)))
      return
    }
    blocks.push(textBlock(JSON.stringify(block)))
  } catch (err: any) {
    log.error({ err }, "[ingest-tool-output] Failed to ingest resource")
    blocks.push(textBlock(JSON.stringify(block)))
  }
  // Silence unused-warning when no branch above produced a side effect.
  void baseOrigin
}

function extensionForMime(mimeType: string): string {
  const slash = mimeType.indexOf("/")
  if (slash < 0) return "bin"
  const subtype = mimeType
    .slice(slash + 1)
    .split(";")[0]
    .trim()
  return subtype || "bin"
}
