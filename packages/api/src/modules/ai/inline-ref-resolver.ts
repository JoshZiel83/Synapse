import {
  mentionBlock,
  textBlock,
  type CanonicalContentBlock,
  type ConversationEntityRef,
  type ConversationParticipantEntry,
} from "@synapse/shared"
import { getFileRecord, toCanonicalFileRefBlock } from "../files/service.js"

type InlineReferenceSegment =
  | { type: "text"; text: string }
  | { type: "file_ref"; fileId: string; raw: string }
  | { type: "mention"; attrs: Record<string, string>; raw: string }

const TAG_REGEX = /<(FileRef|Mention|file-ref|mention)\b([^>]*)\/>/g
const ATTR_REGEX = /([A-Za-z][A-Za-z0-9_]*)="([^"]*)"/g
const GENERIC_USER_KEYS = new Set([
  "user",
  "@user",
  "me",
  "@me",
  "current user",
])

export interface InlineReferenceResolveOptions {
  mentionCandidates?: ConversationEntityRef[]
  defaultUser?: ConversationEntityRef
}

export interface InlineReferenceResolution {
  blocks: CanonicalContentBlock[]
  warnings: string[]
}

type MentionReferenceResolution = {
  mention: ConversationEntityRef | null
  warning?: string
}

function parseTagAttributes(attrsText: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  let match: RegExpExecArray | null
  while ((match = ATTR_REGEX.exec(attrsText)) !== null) {
    attrs[match[1]] = match[2]
  }
  ATTR_REGEX.lastIndex = 0
  return attrs
}

export function parseInlineReferenceSegments(
  text: string
): InlineReferenceSegment[] {
  const segments: InlineReferenceSegment[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = TAG_REGEX.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: "text", text: text.slice(lastIndex, match.index) })
    }

    const raw = match[0]
    if (match[1] === "FileRef" || match[1] === "file-ref") {
      const attrs = parseTagAttributes(match[2] || "")
      const fileId = attrs.id
      if (fileId) {
        segments.push({ type: "file_ref", fileId, raw })
      } else {
        segments.push({ type: "text", text: raw })
      }
    } else {
      segments.push({
        type: "mention",
        attrs: parseTagAttributes(match[2] || ""),
        raw,
      })
    }

    lastIndex = TAG_REGEX.lastIndex
  }

  if (lastIndex < text.length) {
    segments.push({ type: "text", text: text.slice(lastIndex) })
  }

  TAG_REGEX.lastIndex = 0
  return segments
}

function normalizeName(value: string): string {
  return value.trim().replace(/^@+/, "").replace(/\s+/g, " ").toLowerCase()
}

function levenshtein(left: string, right: string): number {
  if (left === right) return 0
  if (left.length === 0) return right.length
  if (right.length === 0) return left.length

  const previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  const current = new Array<number>(right.length + 1).fill(0)

  for (let i = 1; i <= left.length; i += 1) {
    current[0] = i
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + cost
      )
    }
    for (let j = 0; j <= right.length; j += 1) {
      previous[j] = current[j]!
    }
  }

  return previous[right.length]!
}

function uniqueMatch(
  matches: ConversationEntityRef[]
): ConversationEntityRef | null {
  return matches.length === 1 ? matches[0] : null
}

function normalizeMentionType(
  value: string
): "actor" | "workspace_member" | "external" | null {
  const normalized = value.trim().toLowerCase()
  if (normalized === "actor") return "actor"
  if (normalized === "user" || normalized === "workspace_member") {
    return "workspace_member"
  }
  if (normalized === "external") return "external"
  return null
}

function matchesMentionTypeAndId(
  candidate: ConversationEntityRef,
  participantType: "actor" | "workspace_member" | "external",
  id: string
): boolean {
  if (candidate.participantType !== participantType) return false

  if (participantType === "actor") {
    return candidate.actorId === id || candidate.participantId === id
  }
  if (participantType === "workspace_member") {
    return candidate.workspaceMemberId === id || candidate.participantId === id
  }
  return (
    candidate.participantId === id ||
    candidate.externalUserKey === id ||
    candidate.workspaceMemberId === id
  )
}

function preferredMentionId(candidate: ConversationEntityRef): string | null {
  if (candidate.participantType === "actor") {
    return candidate.actorId || candidate.participantId || null
  }
  if (candidate.participantType === "workspace_member") {
    return candidate.workspaceMemberId || candidate.participantId || null
  }
  return (
    candidate.participantId ||
    candidate.externalUserKey ||
    candidate.workspaceMemberId ||
    null
  )
}

function describeMentionCandidate(candidate: ConversationEntityRef): string {
  const participantType = candidate.participantType
  const name = candidate.name?.trim() || "Unknown"
  const title = candidate.title?.trim() || candidate.role?.trim() || ""
  const preferredId = preferredMentionId(candidate)
  const titleSuffix = title ? ` (${title})` : ""
  const idSuffix = preferredId
    ? ` via type="${participantType}" id="${preferredId}"`
    : ""
  return `${participantType} "${name}"${titleSuffix}${idSuffix}`
}

function findClosestMentionCandidate(
  rawValue: string,
  candidates: ConversationEntityRef[],
  selector: (candidate: ConversationEntityRef) => string | null
) {
  let bestMatch: { candidate: ConversationEntityRef; distance: number } | null =
    null
  for (const candidate of candidates) {
    const selected = selector(candidate)
    if (!selected) continue
    const distance = levenshtein(rawValue, selected)
    if (distance > 2) continue
    if (!bestMatch || distance < bestMatch.distance) {
      bestMatch = { candidate, distance }
    }
  }
  return bestMatch
}

function resolveMentionFromName(
  rawName: string,
  options: InlineReferenceResolveOptions
): MentionReferenceResolution {
  const normalized = normalizeName(rawName)
  const candidates = options.mentionCandidates || []
  const exactMatches = candidates.filter(
    (candidate) => normalizeName(candidate.name || "") === normalized
  )
  if (exactMatches.length === 1) {
    return { mention: exactMatches[0] }
  }
  if (exactMatches.length > 1) {
    const described = exactMatches
      .slice(0, 5)
      .map(describeMentionCandidate)
      .join("; ")
    const moreSuffix =
      exactMatches.length > 5 ? `; and ${exactMatches.length - 5} more` : ""
    return {
      mention: null,
      warning:
        `Ambiguous mention name "${rawName}". Matches: ${described}${moreSuffix}. ` +
        `Use <mention participantId="..."/> or <mention name="..."/>.`,
    }
  }

  if (GENERIC_USER_KEYS.has(normalized)) {
    if (options.defaultUser) return { mention: options.defaultUser }
    const userMatches = candidates.filter(
      (candidate) => candidate.participantType === "workspace_member"
    )
    const match = uniqueMatch(userMatches)
    if (match) {
      return { mention: match }
    }
    if (userMatches.length > 1) {
      const described = userMatches
        .slice(0, 5)
        .map(describeMentionCandidate)
        .join("; ")
      const moreSuffix =
        userMatches.length > 5 ? `; and ${userMatches.length - 5} more` : ""
      return {
        mention: null,
        warning:
          `Ambiguous generic user mention "${rawName}". Matches: ${described}${moreSuffix}. ` +
          `Use <mention participantId="..."/> or an explicit workspaceMemberId.`,
      }
    }
    return {
      mention: null,
      warning: `Unresolved generic user mention "${rawName}". Use a visible user from the roster or an explicit user id.`,
    }
  }

  return {
    mention: null,
    warning: (() => {
      const closest = findClosestMentionCandidate(
        normalized,
        candidates,
        (candidate) => normalizeName(candidate.name || "")
      )
      if (!closest) {
        return `Unknown mention name "${rawName}". Use the exact roster display name or <mention participantId="..."/>.`
      }
      return (
        `Unknown mention name "${rawName}". ` +
        `Did you mean ${describeMentionCandidate(closest.candidate)}? ` +
        `Use <mention participantId="${closest.candidate.participantId || preferredMentionId(closest.candidate) || ""}"/> or the exact roster name.`
      )
    })(),
  }
}

function resolveMentionReference(
  attrs: Record<string, string>,
  options: InlineReferenceResolveOptions,
  rawTag: string
): MentionReferenceResolution {
  const candidates = options.mentionCandidates || []

  if (attrs.participantId) {
    const match = uniqueMatch(
      candidates.filter(
        (candidate) => candidate.participantId === attrs.participantId
      )
    )
    if (match) return { mention: match }
    const closest = findClosestMentionCandidate(
      attrs.participantId,
      candidates,
      (candidate) => candidate.participantId || null
    )
    if (closest) {
      return {
        mention: null,
        warning:
          `Unknown mention participantId "${attrs.participantId}" in ${rawTag}. ` +
          `Did you mean <mention participantId="${closest.candidate.participantId}"/> for ${describeMentionCandidate(closest.candidate)}?`,
      }
    }
  }
  if (attrs.actorId) {
    const match = uniqueMatch(
      candidates.filter((candidate) => candidate.actorId === attrs.actorId)
    )
    if (match) return { mention: match }
  }
  if (attrs.workspaceMemberId) {
    const match = uniqueMatch(
      candidates.filter(
        (candidate) => candidate.workspaceMemberId === attrs.workspaceMemberId
      )
    )
    if (match) return { mention: match }
  }
  if (attrs.externalUserKey) {
    const match = uniqueMatch(
      candidates.filter(
        (candidate) => candidate.externalUserKey === attrs.externalUserKey
      )
    )
    if (match) return { mention: match }
  }

  const typeLike = attrs.type || attrs.participantType
  const genericId = attrs.id
  if (typeLike || genericId) {
    if (!typeLike || !genericId) {
      return {
        mention: null,
        warning: `Incomplete mention reference: ${rawTag}. Prefer <mention participantId="..."/> or <mention name="..."/>.`,
      }
    }

    const participantType = normalizeMentionType(typeLike)
    if (!participantType) {
      return {
        mention: null,
        warning: `Unsupported mention type "${typeLike}" in ${rawTag}. Prefer <mention participantId="..."/> or <mention name="..."/>.`,
      }
    }

    const typedMatches = candidates.filter((candidate) =>
      matchesMentionTypeAndId(candidate, participantType, genericId)
    )
    const typedMatch = uniqueMatch(typedMatches)
    if (typedMatch) {
      return { mention: typedMatch }
    }
    if (typedMatches.length > 1) {
      const described = typedMatches
        .slice(0, 5)
        .map(describeMentionCandidate)
        .join("; ")
      const moreSuffix =
        typedMatches.length > 5 ? `; and ${typedMatches.length - 5} more` : ""
      return {
        mention: null,
        warning:
          `Ambiguous mention reference ${rawTag}. Matches: ${described}${moreSuffix}. ` +
          `Use <mention participantId="..."/> with the exact participant id.`,
      }
    }

    const closest = findClosestMentionCandidate(
      genericId,
      typedMatches.length > 0
        ? typedMatches
        : candidates.filter(
            (candidate) => candidate.participantType === participantType
          ),
      (candidate) => preferredMentionId(candidate)
    )
    return {
      mention: null,
      warning: closest
        ? `Unknown mention target ${rawTag}. Did you mean ${describeMentionCandidate(closest.candidate)}? Use <mention participantId="${closest.candidate.participantId || preferredMentionId(closest.candidate) || ""}"/>.`
        : `Unknown mention target ${rawTag}. No ${participantType} participant matched id "${genericId}". Use a valid participant id from the roster.`,
    }
  }

  const nameLike = attrs.name || attrs.recipient || attrs.member || attrs.to
  if (nameLike) {
    return resolveMentionFromName(nameLike, options)
  }

  if (options.defaultUser) {
    return { mention: options.defaultUser }
  }

  return {
    mention: null,
    warning: `Unresolved mention reference: ${rawTag}. Provide <mention participantId="..."/> or <mention name="..."/>.`,
  }
}

export async function resolveInlineReferenceSegments(
  segments: InlineReferenceSegment[],
  options: InlineReferenceResolveOptions = {}
): Promise<InlineReferenceResolution> {
  const blocks: CanonicalContentBlock[] = []
  const warnings: string[] = []

  for (const segment of segments) {
    if (segment.type === "text") {
      if (segment.text) blocks.push(textBlock(segment.text))
      continue
    }

    if (segment.type === "file_ref") {
      const file = await getFileRecord(segment.fileId)
      if (file) {
        blocks.push(toCanonicalFileRefBlock(file))
      } else {
        warnings.push(`Unknown FileRef "${segment.fileId}"`)
        blocks.push(textBlock(`[File not found: ${segment.fileId}]`))
      }
      continue
    }

    const resolution = resolveMentionReference(
      segment.attrs,
      options,
      segment.raw
    )
    if (!resolution.mention) {
      warnings.push(
        resolution.warning || `Unresolved mention reference: ${segment.raw}`
      )
      blocks.push(textBlock(segment.raw))
      continue
    }

    blocks.push(mentionBlock({ mention: resolution.mention }))
  }

  return { blocks, warnings }
}

export function conversationParticipantEntryToEntityRef(
  participant: ConversationParticipantEntry
): ConversationEntityRef {
  if (participant.type === "actor") {
    return {
      participantType: "actor",
      actorId: participant.id,
      participantId: participant.participantId,
      name: participant.name,
      title: participant.title,
      role: participant.title,
    }
  }

  if (participant.type === "workspace_member") {
    return {
      participantType: "workspace_member",
      workspaceMemberId: participant.id,
      participantId: participant.participantId,
      name: participant.name,
      title: participant.title,
      role: participant.title,
    }
  }

  return {
    participantType: "external",
    workspaceMemberId: participant.linkedWorkspaceMemberId,
    participantId: participant.participantId,
    externalUserKey: participant.externalUserKey,
    name: participant.name,
    title: participant.title,
    role: participant.title,
  }
}

export function buildDefaultUserMention(params: {
  workspaceMemberId?: string
  userName?: string
}): ConversationEntityRef | undefined {
  if (!params.workspaceMemberId) return undefined
  return {
    participantType: "workspace_member",
    workspaceMemberId: params.workspaceMemberId,
    name: params.userName || "User",
  }
}
