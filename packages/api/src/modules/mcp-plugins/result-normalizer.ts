/**
 * MCP protocol-level result unpacker.
 *
 * Recognises the standard MCP `tools/call` response envelope
 * `{content, isError, structuredContent}` and unwraps it into a
 * NormalizedMcpToolResult. Content-array → canonical block conversion is
 * delegated to the unified ingest funnel (files/ingest.ts) so binary
 * download/save and pre-canonical pass-through are handled in one place.
 *
 * Callers should supply `origin` (ToolResultOrigin) so downstream
 * CanonicalToolResult.origin and stored FileRecord.origin can be attributed
 * correctly. The legacy `binaryMetadata` option remains as a fallback for
 * call sites that haven't migrated yet; it lands in FileRecord.origin.details.
 */
import {
  textBlocks,
  type CanonicalContentBlock,
  type ToolResultOrigin,
} from "@synapse/shared"
import type { NormalizedMcpToolResult } from "@synapse/shared/types"
import { ingestToolOutput } from "../files/ingest.js"

export interface McpResultNormalizeOptions {
  // Preferred: where this result came from. Will be persisted to
  // NormalizedMcpToolResult.origin and used when saving any binary content.
  origin?: ToolResultOrigin
  // Legacy: arbitrary metadata merged into FileRecord.origin.details when
  // binaries are stored. Phase 2 keeps it for backward-compat; Phase 4
  // migrates remaining call sites to use `origin` exclusively.
  binaryMetadata?: Record<string, unknown>
}

function resolveOrigin(opts?: McpResultNormalizeOptions): ToolResultOrigin {
  if (opts?.origin) return opts.origin
  // Synthetic fallback for callers that haven't migrated. Records the
  // raw binaryMetadata in serverName so it's still visible in audit.
  return { kind: "mcp_remote", serverKey: "unknown_mcp_caller" }
}

async function ingestContentArray(
  content: unknown[],
  workspaceId: string,
  opts?: McpResultNormalizeOptions
): Promise<CanonicalContentBlock[]> {
  return ingestToolOutput(content, {
    workspaceId,
    origin: resolveOrigin(opts),
    binaryMetadata: opts?.binaryMetadata,
  })
}

export async function normalizeMcpToolResult(
  rawResult: unknown,
  workspaceId: string,
  options?: McpResultNormalizeOptions
): Promise<NormalizedMcpToolResult> {
  const origin = options?.origin
  const wrap = (
    base: Omit<NormalizedMcpToolResult, "origin">
  ): NormalizedMcpToolResult => (origin ? { ...base, origin } : base)

  if (typeof rawResult === "string") {
    return wrap({ content: textBlocks(rawResult), rawResult })
  }

  if (Array.isArray(rawResult)) {
    return wrap({
      content: await ingestContentArray(rawResult, workspaceId, options),
      rawResult,
    })
  }

  if (!rawResult || typeof rawResult !== "object") {
    return wrap({ content: textBlocks(String(rawResult)), rawResult })
  }

  const candidate = rawResult as Record<string, unknown>
  const structuredContent =
    candidate.structuredContent &&
    typeof candidate.structuredContent === "object"
      ? (candidate.structuredContent as Record<string, unknown>)
      : undefined
  // Capture the MCP `_meta` envelope field so the presentation layer can read
  // structured result data (it used to be dropped). Lands in
  // NormalizedMcpToolResult.metadata and is namespaced under
  // tool_results.metadata.toolMeta at the persist site.
  const meta =
    candidate._meta && typeof candidate._meta === "object"
      ? (candidate._meta as Record<string, unknown>)
      : undefined

  if (typeof candidate.content === "string") {
    return wrap({
      content: textBlocks(candidate.content),
      isError: candidate.isError === true,
      structuredContent,
      ...(meta ? { metadata: meta } : {}),
      rawResult,
    })
  }

  if (Array.isArray(candidate.content)) {
    return wrap({
      content: await ingestContentArray(
        candidate.content,
        workspaceId,
        options
      ),
      isError: candidate.isError === true,
      structuredContent,
      ...(meta ? { metadata: meta } : {}),
      rawResult,
    })
  }

  if (structuredContent) {
    return wrap({
      content: textBlocks(JSON.stringify(structuredContent)),
      isError: candidate.isError === true,
      structuredContent,
      ...(meta ? { metadata: meta } : {}),
      rawResult,
    })
  }

  return wrap({
    content: textBlocks(JSON.stringify(rawResult)),
    isError: candidate.isError === true,
    ...(meta ? { metadata: meta } : {}),
    rawResult,
  })
}
