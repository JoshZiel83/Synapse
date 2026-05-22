/**
 * Model response media ingest: when an LLM provider returns binary
 * content blocks (e.g., Anthropic image blocks), persist them to the file
 * store as canonical file_ref blocks. Other block kinds (text/tool_use)
 * are handled upstream by the provider adapter — we only care about
 * media that needs to land in our storage layer.
 *
 * The unified ingest funnel (files/ingest.ts) handles the actual binary
 * download/save; we just filter to the relevant block kinds and supply
 * the right ToolResultOrigin.
 */
import { type CanonicalContentBlock, type ProviderType } from "@synapse/shared"
import { ingestToolOutput } from "../files/ingest.js"

export async function ingestResponseMedia(
  rawBlocks: unknown[],
  providerType: ProviderType,
  workspaceId: string
): Promise<CanonicalContentBlock[]> {
  if (!Array.isArray(rawBlocks) || rawBlocks.length === 0) return []

  if (providerType === "anthropic") {
    const imageBlocks = rawBlocks.filter(
      (block) =>
        block && typeof block === "object" && (block as any).type === "image"
    )
    if (imageBlocks.length === 0) return []
    return ingestToolOutput(imageBlocks, {
      workspaceId,
      origin: { kind: "model_response", providerType },
    })
  }

  // OpenAI: future-proof — when their API returns inline media blocks,
  // they should follow the same shape and route through the same ingest.

  return []
}
