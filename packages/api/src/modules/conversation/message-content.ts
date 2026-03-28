import {
  extractText,
  fileRefBlock,
  isCanonicalContentBlock,
  mentionBlock,
  normalizeCanonicalContentBlocks,
  textBlock,
  type CanonicalContentBlockInput,
  type CanonicalContentBlock,
} from "@synapse/shared";
import { getFileUrlById } from "../files/service.js";
import {
  parseInlineReferenceSegments,
  resolveInlineReferenceSegments,
  type InlineReferenceResolveOptions,
} from "../ai/inline-ref-resolver.js";

export type DraftConversationPart = {
  type: "text" | "file_ref" | "json";
  text?: string;
  fileId?: string;
  json?: unknown;
  mimeType?: string;
  name?: string;
  metadata?: Record<string, unknown>;
};

function getCategoryFromMimeType(
  mimeType: string,
): "image" | "audio" | "video" | "document" {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("video/")) return "video";
  return "document";
}

function parseJson(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return {};
    }
  }
  return (value || {}) as Record<string, unknown>;
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  return value;
}

function parseSizeBytes(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return 0;
}

function blocksToDraftParts(
  blocks: CanonicalContentBlock[],
): DraftConversationPart[] {
  const parts: DraftConversationPart[] = [];

  for (const block of blocks) {
    if (block.type === "text") {
      if (block.text) {
        parts.push({ type: "text", text: block.text });
      }
      continue;
    }

    if (block.type === "file_ref") {
      parts.push({
        type: "file_ref",
        fileId: block.fileId,
        mimeType: block.mimeType,
        name: block.originalName,
        metadata: {
          id: block.fileId,
          originalName: block.originalName,
          storedName: block.storedName,
          mimeType: block.mimeType,
          sizeBytes: block.sizeBytes,
          url: block.url,
          category: block.category,
        },
      });
      continue;
    }

    parts.push({
      type: "json",
      json: {
        id: block.id,
        type: "mention",
        mention: block.mention,
      },
      mimeType: "application/vnd.synapse.mention+json",
      name: "mention",
      metadata: {
        mention: block.mention,
      },
    });
  }

  return parts;
}

export function draftPartsToCanonicalContentBlocks(
  parts: DraftConversationPart[],
): CanonicalContentBlock[] {
  const blocks: CanonicalContentBlock[] = [];

  for (const part of parts) {
    if (part.type === "text") {
      if (part.text) {
        blocks.push(textBlock(part.text));
      }
      continue;
    }

    if (part.type === "file_ref" && part.fileId) {
      const metadata = part.metadata || {};
      const mimeType =
        typeof metadata.mimeType === "string"
          ? metadata.mimeType
          : part.mimeType || "application/octet-stream";
      blocks.push(
        fileRefBlock({
          fileId: part.fileId,
          storedName:
            typeof metadata.storedName === "string" ? metadata.storedName : "",
          url:
            typeof metadata.url === "string"
              ? metadata.url
              : getFileUrlById(part.fileId),
          mimeType,
          originalName:
            typeof metadata.originalName === "string"
              ? metadata.originalName
              : part.name || "file",
          sizeBytes: parseSizeBytes(metadata.sizeBytes),
          category:
            (metadata.category as
              | "image"
              | "audio"
              | "video"
              | "document"
              | undefined) || getCategoryFromMimeType(mimeType),
        }),
      );
      continue;
    }

    if (part.type === "json") {
      const payload =
        part.json ??
        parseJsonValue(
          (part.metadata as Record<string, unknown> | undefined)?.jsonValue,
        );
      if (!payload || typeof payload !== "object") continue;
      const normalized = normalizeCanonicalContentBlocks([
        payload as CanonicalContentBlockInput,
      ]);
      if (normalized[0]?.type === "mention") {
        blocks.push(normalized[0]);
      }
    }
  }

  return blocks;
}

export function itemPartsToCanonicalContentBlocks(
  parts: any[],
): CanonicalContentBlock[] {
  const blocks: CanonicalContentBlock[] = [];

  for (const part of parts || []) {
    if (part.part_type === "text") {
      if (part.text_value) {
        blocks.push(textBlock(part.text_value));
      }
      continue;
    }

    if (part.part_type === "file_ref" && part.file_id) {
      const metadata = parseJson(part.metadata);
      const mimeType =
        part.file_mime_type || part.mime_type || "application/octet-stream";
      blocks.push(
        fileRefBlock({
          fileId: part.file_id,
          storedName: part.stored_name || String(metadata.storedName || ""),
          url:
            typeof metadata.url === "string"
              ? metadata.url
              : getFileUrlById(part.file_id),
          mimeType,
          originalName: part.original_name || part.name || "file",
          sizeBytes: parseSizeBytes(part.size_bytes ?? metadata.sizeBytes),
          category:
            (metadata.category as
              | "image"
              | "audio"
              | "video"
              | "document"
              | undefined) || getCategoryFromMimeType(mimeType),
        }),
      );
      continue;
    }

    if (part.part_type === "json") {
      const payload = parseJsonValue(part.json_value);
      if (!payload || typeof payload !== "object") continue;
      const normalized = normalizeCanonicalContentBlocks([
        payload as CanonicalContentBlockInput,
      ]);
      if (normalized[0]?.type === "mention") {
        blocks.push(
          mentionBlock({
            id: normalized[0].id,
            mention: normalized[0].mention,
          }),
        );
      }
    }
  }

  return blocks;
}

function buildTextContentFromDraftParts(parts: DraftConversationPart[]) {
  return extractText(draftPartsToCanonicalContentBlocks(parts));
}

async function buildBlocksFromContent(
  content: string,
  inlineReferences?: InlineReferenceResolveOptions,
): Promise<{ blocks: CanonicalContentBlock[]; warnings: string[] }> {
  if (!content) return { blocks: [], warnings: [] };

  const segments = parseInlineReferenceSegments(content);
  if (segments.some((segment) => segment.type !== "text")) {
    return resolveInlineReferenceSegments(segments, inlineReferences);
  }

  return { blocks: [textBlock(content)], warnings: [] };
}

export async function buildNormalizedMessageContent(params: {
  content: string;
  contentBlocks?: CanonicalContentBlockInput[];
  metadata?: Record<string, unknown>;
  inlineReferences?: InlineReferenceResolveOptions;
}): Promise<{
  parts: DraftConversationPart[];
  contentBlocks: CanonicalContentBlock[];
  normalizedContent: string;
  normalizedMetadata: Record<string, unknown>;
  referenceWarnings: string[];
}> {
  const { content, contentBlocks, metadata = {}, inlineReferences } = params;
  const {
    attachments: _attachments,
    parsedContent: _parsedContent,
    ...normalizedMetadata
  } = metadata as Record<string, unknown> & {
    attachments?: unknown;
    parsedContent?: unknown;
  };

  const explicitBlocks = Array.isArray(contentBlocks)
    ? normalizeCanonicalContentBlocks(
        contentBlocks.filter(isCanonicalContentBlock),
      )
    : [];
  const built =
    explicitBlocks.length > 0
      ? { blocks: explicitBlocks, warnings: [] as string[] }
      : await buildBlocksFromContent(content, inlineReferences);
  const baseBlocks = built.blocks;

  const parts = blocksToDraftParts(baseBlocks);

  if (parts.length === 0) {
    parts.push({ type: "text", text: "" });
  }

  return {
    parts,
    contentBlocks: draftPartsToCanonicalContentBlocks(parts),
    normalizedContent: buildTextContentFromDraftParts(parts),
    normalizedMetadata,
    referenceWarnings: built.warnings,
  };
}
