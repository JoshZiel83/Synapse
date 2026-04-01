import {
  fileRefBlock,
  mentionBlock,
  textBlock,
  type CanonicalContentBlock,
  type CanonicalFileCategory,
  type ConversationEntityRef,
  type ConversationMemberEntry,
} from "@synapse/shared";
import { getFileRecord } from "../files/service.js";

type InlineReferenceSegment =
  | { type: "text"; text: string }
  | { type: "file_ref"; fileId: string; raw: string }
  | { type: "mention"; attrs: Record<string, string>; raw: string };

const TAG_REGEX = /<(FileRef|Mention)\b([^>]*)\/>/g;
const ATTR_REGEX = /([A-Za-z][A-Za-z0-9_]*)="([^"]*)"/g;
const GENERIC_USER_KEYS = new Set([
  "user",
  "@user",
  "me",
  "@me",
  "current user",
]);

export interface InlineReferenceResolveOptions {
  mentionCandidates?: ConversationEntityRef[];
  defaultUser?: ConversationEntityRef;
}

export interface InlineReferenceResolution {
  blocks: CanonicalContentBlock[];
  warnings: string[];
}

type MentionReferenceResolution = {
  mention: ConversationEntityRef | null;
  warning?: string;
};

function parseTagAttributes(attrsText: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  let match: RegExpExecArray | null;
  while ((match = ATTR_REGEX.exec(attrsText)) !== null) {
    attrs[match[1]] = match[2];
  }
  ATTR_REGEX.lastIndex = 0;
  return attrs;
}

export function parseInlineReferenceSegments(
  text: string,
): InlineReferenceSegment[] {
  const segments: InlineReferenceSegment[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = TAG_REGEX.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: "text", text: text.slice(lastIndex, match.index) });
    }

    const raw = match[0];
    if (match[1] === "FileRef") {
      const attrs = parseTagAttributes(match[2] || "");
      const fileId = attrs.id;
      if (fileId) {
        segments.push({ type: "file_ref", fileId, raw });
      } else {
        segments.push({ type: "text", text: raw });
      }
    } else {
      segments.push({
        type: "mention",
        attrs: parseTagAttributes(match[2] || ""),
        raw,
      });
    }

    lastIndex = TAG_REGEX.lastIndex;
  }

  if (lastIndex < text.length) {
    segments.push({ type: "text", text: text.slice(lastIndex) });
  }

  TAG_REGEX.lastIndex = 0;
  return segments;
}

function normalizeName(value: string): string {
  return value
    .trim()
    .replace(/^@+/, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function uniqueMatch(
  matches: ConversationEntityRef[],
): ConversationEntityRef | null {
  return matches.length === 1 ? matches[0] : null;
}

function normalizeMentionType(
  value: string,
): "actor" | "workspace_member" | "external" | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === "actor") return "actor";
  if (normalized === "user" || normalized === "workspace_member") {
    return "workspace_member";
  }
  if (normalized === "external") return "external";
  return null;
}

function matchesMentionTypeAndId(
  candidate: ConversationEntityRef,
  memberType: "actor" | "workspace_member" | "external",
  id: string,
): boolean {
  if (candidate.memberType !== memberType) return false;

  if (memberType === "actor") {
    return (
      candidate.actorId === id ||
      candidate.memberId === id ||
      candidate.participantId === id
    );
  }
  if (memberType === "workspace_member") {
    return (
      candidate.workspaceMemberId === id ||
      candidate.memberId === id ||
      candidate.participantId === id
    );
  }
  return (
    candidate.participantId === id ||
    candidate.externalUserKey === id ||
    candidate.workspaceMemberId === id ||
    candidate.memberId === id
  );
}

function preferredMentionId(candidate: ConversationEntityRef): string | null {
  if (candidate.memberType === "actor") {
    return candidate.actorId || candidate.memberId || candidate.participantId || null;
  }
  if (candidate.memberType === "workspace_member") {
    return candidate.workspaceMemberId || candidate.memberId || candidate.participantId || null;
  }
  return (
    candidate.participantId ||
    candidate.externalUserKey ||
    candidate.workspaceMemberId ||
    candidate.memberId ||
    null
  );
}

function describeMentionCandidate(candidate: ConversationEntityRef): string {
  const memberType = candidate.memberType;
  const name = candidate.name?.trim() || "Unknown";
  const title = candidate.title?.trim() || candidate.role?.trim() || "";
  const preferredId = preferredMentionId(candidate);
  const titleSuffix = title ? ` (${title})` : "";
  const idSuffix = preferredId
    ? ` via type="${memberType}" id="${preferredId}"`
    : "";
  return `${memberType} "${name}"${titleSuffix}${idSuffix}`;
}

function resolveMentionFromName(
  rawName: string,
  options: InlineReferenceResolveOptions,
): MentionReferenceResolution {
  const normalized = normalizeName(rawName);
  const candidates = options.mentionCandidates || [];
  const exactMatches = candidates.filter(
    (candidate) => normalizeName(candidate.name || "") === normalized,
  );
  if (exactMatches.length === 1) {
    return { mention: exactMatches[0] };
  }
  if (exactMatches.length > 1) {
    const described = exactMatches
      .slice(0, 5)
      .map(describeMentionCandidate)
      .join("; ");
    const moreSuffix =
      exactMatches.length > 5 ? `; and ${exactMatches.length - 5} more` : "";
    return {
      mention: null,
      warning:
        `Ambiguous mention name "${rawName}". Matches: ${described}${moreSuffix}. ` +
        `Use <Mention type="..." id="..."/> or an explicit id attribute such as actorId, userId, participantId, memberId, or externalUserKey.`,
    };
  }

  if (GENERIC_USER_KEYS.has(normalized)) {
    if (options.defaultUser) return { mention: options.defaultUser };
    const userMatches = candidates.filter(
      (candidate) => candidate.memberType === "workspace_member",
    );
    const match = uniqueMatch(userMatches);
    if (match) {
      return { mention: match };
    }
    if (userMatches.length > 1) {
      const described = userMatches
        .slice(0, 5)
        .map(describeMentionCandidate)
        .join("; ");
      const moreSuffix =
        userMatches.length > 5 ? `; and ${userMatches.length - 5} more` : "";
      return {
        mention: null,
        warning:
          `Ambiguous generic user mention "${rawName}". Matches: ${described}${moreSuffix}. ` +
          `Use <Mention type="workspace_member" id="..."/> or workspaceMemberId="...".`,
      };
    }
    return {
      mention: null,
      warning:
        `Unresolved generic user mention "${rawName}". Use a visible user from the roster or an explicit user id.`,
    };
  }

  return {
    mention: null,
    warning:
      `Unknown mention name "${rawName}". Use the exact roster display name or disambiguate with type="..." id="..." or an explicit id attribute.`,
  };
}

function resolveMentionReference(
  attrs: Record<string, string>,
  options: InlineReferenceResolveOptions,
  rawTag: string,
): MentionReferenceResolution {
  const candidates = options.mentionCandidates || [];

  if (attrs.participantId) {
    const match = uniqueMatch(
      candidates.filter(
        (candidate) => candidate.participantId === attrs.participantId,
      ),
    );
    if (match) return { mention: match };
  }
  if (attrs.memberId) {
    const match = uniqueMatch(
      candidates.filter((candidate) => candidate.memberId === attrs.memberId),
    );
    if (match) return { mention: match };
  }
  if (attrs.actorId) {
    const match = uniqueMatch(
      candidates.filter((candidate) => candidate.actorId === attrs.actorId),
    );
    if (match) return { mention: match };
  }
  if (attrs.workspaceMemberId) {
    const match = uniqueMatch(
      candidates.filter((candidate) => candidate.workspaceMemberId === attrs.workspaceMemberId),
    );
    if (match) return { mention: match };
  }
  if (attrs.externalUserKey) {
    const match = uniqueMatch(
      candidates.filter(
        (candidate) => candidate.externalUserKey === attrs.externalUserKey,
      ),
    );
    if (match) return { mention: match };
  }

  const typeLike = attrs.type || attrs.memberType;
  const genericId = attrs.id;
  if (typeLike || genericId) {
    if (!typeLike || !genericId) {
      return {
        mention: null,
        warning: `Incomplete mention reference: ${rawTag}. When using generic id matching, provide both type="actor|user|external" and id="...".`,
      };
    }

    const memberType = normalizeMentionType(typeLike);
    if (!memberType) {
      return {
        mention: null,
        warning: `Unsupported mention type "${typeLike}" in ${rawTag}. Use type="actor", type="workspace_member", or type="external".`,
      };
    }

    const typedMatches = candidates.filter((candidate) =>
      matchesMentionTypeAndId(candidate, memberType, genericId),
    );
    const typedMatch = uniqueMatch(typedMatches);
    if (typedMatch) {
      return { mention: typedMatch };
    }
    if (typedMatches.length > 1) {
      const described = typedMatches
        .slice(0, 5)
        .map(describeMentionCandidate)
        .join("; ");
      const moreSuffix =
        typedMatches.length > 5 ? `; and ${typedMatches.length - 5} more` : "";
      return {
        mention: null,
        warning:
          `Ambiguous mention reference ${rawTag}. Matches: ${described}${moreSuffix}. ` +
          `Use a more specific explicit id attribute such as actorId, userId, participantId, memberId, or externalUserKey.`,
      };
    }

    return {
      mention: null,
      warning:
        `Unknown mention target ${rawTag}. No ${memberType} member matched id "${genericId}". ` +
        `Use a valid id from the roster or an explicit id attribute.`,
    };
  }

  const nameLike = attrs.name || attrs.recipient || attrs.member || attrs.to;
  if (nameLike) {
    return resolveMentionFromName(nameLike, options);
  }

  if (options.defaultUser) {
    return { mention: options.defaultUser };
  }

  return {
    mention: null,
    warning:
      `Unresolved mention reference: ${rawTag}. Provide name="..." or an explicit id reference such as type="..." id="...", actorId, userId, participantId, memberId, or externalUserKey.`,
  };
}

function mimeToCategory(
  mimeType: string,
): CanonicalFileCategory {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("video/")) return "video";
  return "document";
}

export async function resolveInlineReferenceSegments(
  segments: InlineReferenceSegment[],
  options: InlineReferenceResolveOptions = {},
): Promise<InlineReferenceResolution> {
  const blocks: CanonicalContentBlock[] = [];
  const warnings: string[] = [];

  for (const segment of segments) {
    if (segment.type === "text") {
      if (segment.text) blocks.push(textBlock(segment.text));
      continue;
    }

    if (segment.type === "file_ref") {
      const file = await getFileRecord(segment.fileId);
      if (file) {
        blocks.push(
          fileRefBlock({
            fileId: file.id,
            storedName: file.storedName,
            url: file.url,
            mimeType: file.mimeType,
            originalName: file.originalName,
            sizeBytes: file.sizeBytes,
            category: mimeToCategory(file.mimeType),
          }),
        );
      } else {
        warnings.push(`Unknown FileRef "${segment.fileId}"`);
        blocks.push(textBlock(`[File not found: ${segment.fileId}]`));
      }
      continue;
    }

    const resolution = resolveMentionReference(segment.attrs, options, segment.raw);
    if (!resolution.mention) {
      warnings.push(
        resolution.warning || `Unresolved mention reference: ${segment.raw}`,
      );
      blocks.push(textBlock(segment.raw));
      continue;
    }

    blocks.push(mentionBlock({ mention: resolution.mention }));
  }

  return { blocks, warnings };
}

export function conversationMemberEntryToEntityRef(
  member: ConversationMemberEntry,
): ConversationEntityRef {
  if (member.type === "actor") {
    return {
      memberType: "actor",
      actorId: member.id,
      participantId: member.participantId,
      name: member.name,
      title: member.title,
      role: member.title,
    };
  }

  if (member.type === "workspace_member") {
    return {
      memberType: "workspace_member",
      workspaceMemberId: member.id,
      participantId: member.participantId,
      name: member.name,
      title: member.title,
      role: member.title,
    };
  }

  return {
    memberType: "external",
    workspaceMemberId: member.linkedWorkspaceMemberId,
    participantId: member.participantId,
    externalUserKey: member.externalUserKey,
    name: member.name,
    title: member.title,
    role: member.title,
  };
}

export function buildDefaultUserMention(params: {
  workspaceMemberId?: string;
  userName?: string;
}): ConversationEntityRef | undefined {
  if (!params.workspaceMemberId) return undefined;
  return {
    memberType: "workspace_member",
    workspaceMemberId: params.workspaceMemberId,
    name: params.userName || "User",
  };
}
