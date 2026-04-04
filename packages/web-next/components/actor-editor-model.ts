"use client"

import {
  ACTOR_DOC_TEMPLATES,
  extractText,
  normalizeCanonicalContentBlocks,
  textBlock,
  fileRefBlock,
  type Actor,
  type ActorDoc,
  type ActorDocKey,
  type ActorDocVisibility,
  type ActorRole,
  type CanonicalContentBlock,
  type CoreActorDocKey,
} from "@synapse/shared"
import { resolveFileUrl } from "@/lib/utils"

export type {
  ActorDocKey,
  ActorDocVisibility,
  ActorRole,
  CoreActorDocKey,
} from "@synapse/shared"

export const ACTOR_ROLE_OPTIONS: ActorRole[] = [
  "secretary",
  "manager",
  "specialist",
  "reviewer",
  "archivist",
  "receptionist",
  "assistant",
]

export const ACTOR_DOC_GROUPS = [
  {
    value: "identity",
    label: "Identity",
    keys: [
      "identity_card",
      "public_persona",
      "soul",
      "self_narrative",
      "origin_story",
    ] satisfies CoreActorDocKey[],
  },
  {
    value: "social",
    label: "Social",
    keys: [
      "relationship_with_user",
      "relationship_with_team",
      "social_protocol",
      "representation_guidelines",
    ] satisfies CoreActorDocKey[],
  },
  {
    value: "work",
    label: "Work",
    keys: [
      "role_charter",
      "mission",
      "work_doctrine",
      "limitations_and_escalation",
      "routines",
    ] satisfies CoreActorDocKey[],
  },
  {
    value: "voice",
    label: "Voice",
    keys: [
      "quirks_and_signatures",
      "conversation_examples",
    ] satisfies CoreActorDocKey[],
  },
] as const

export const VISIBILITY_OPTIONS: Array<{
  value: ActorDocVisibility
  label: string
}> = [
  { value: "always", label: "Always" },
  { value: "direct_only", label: "Direct only" },
  { value: "multi_member_only", label: "Multi-member only" },
  { value: "internal_only", label: "Internal only" },
]

export type FileRefBlock = Extract<CanonicalContentBlock, { type: "file_ref" }>

export type EditableDoc = {
  id: string
  key: ActorDocKey
  title: string
  description: string
  visibility: ActorDocVisibility
  priority: number
  content: CanonicalContentBlock[]
}

export type ActorFormState = {
  name: string
  role: ActorRole
  title: string
  parentId: string | null
  avatarFileId?: string
  avatarUrl?: string
  canRepresentUser: boolean
  specialties: string
  docs: EditableDoc[]
}

export type UploadedFile = {
  id: string
  url?: string
  fullUrl?: string
  originalName: string
  mimeType: string
  sizeBytes: number
}

function createLocalTextBlock(text = "") {
  return textBlock(text)
}

function getDocTemplate(key: ActorDocKey) {
  return key === "custom"
    ? undefined
    : ACTOR_DOC_TEMPLATES.find((item) => item.key === key)
}

function hasMeaningfulContent(blocks: CanonicalContentBlock[]) {
  return blocks.some((block) => {
    if (block.type === "file_ref") return true
    if (block.type === "mention") return true
    return block.text.trim().length > 0
  })
}

export function formatDate(dateString?: string) {
  if (!dateString) return "Unknown"
  try {
    return new Date(dateString).toLocaleDateString([], {
      year: "numeric",
      month: "short",
      day: "numeric",
    })
  } catch {
    return "Unknown"
  }
}

export function titleCase(input: string) {
  return input
    .split("_")
    .join(" ")
    .replace(/\b\w/g, (char) => char.toUpperCase())
}

export function isCustomDocKey(key: ActorDocKey) {
  return key === "custom"
}

export function summarizeBlocks(
  blocks: CanonicalContentBlock[],
  maxLength = 200
) {
  const text = extractText(blocks).replace(/\s+/g, " ").trim()
  if (text) {
    return text.length > maxLength ? `${text.slice(0, maxLength - 1)}...` : text
  }
  const file = blocks.find(
    (block): block is FileRefBlock => block.type === "file_ref"
  )
  return file ? `Attached file: ${file.originalName}` : ""
}

export function summarizeDoc(doc: Pick<ActorDoc, "content">, maxLength = 200) {
  return summarizeBlocks(doc.content, maxLength)
}

export function actorSummary(actor: Actor) {
  const docs = [...(actor.definition.docs || [])].sort(
    (left, right) => right.priority - left.priority
  )
  const summary = docs.map((doc) => summarizeDoc(doc, 140)).find(Boolean)
  return summary || actor.definition.title || titleCase(actor.definition.role)
}

export function mimeToCategory(mimeType: string): FileRefBlock["category"] {
  if (mimeType.startsWith("image/")) return "image"
  if (mimeType.startsWith("audio/")) return "audio"
  if (mimeType.startsWith("video/")) return "video"
  return "document"
}

export function splitList(value: string) {
  return value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean)
}

export function docToEditableDoc(doc: ActorDoc): EditableDoc {
  const template = getDocTemplate(doc.key)

  return {
    id: doc.id,
    key: doc.key,
    title: doc.title,
    description: template?.description || "Custom narrative section.",
    visibility: doc.visibility,
    priority: doc.priority,
    content: normalizeCanonicalContentBlocks(doc.content),
  }
}

export function buildEditableDocFromTemplate(
  templateKey: CoreActorDocKey
): EditableDoc {
  const template = ACTOR_DOC_TEMPLATES.find((item) => item.key === templateKey)
  if (!template) {
    throw new Error(`Unknown actor doc template: ${templateKey}`)
  }

  return {
    id: crypto.randomUUID(),
    key: template.key,
    title: template.title,
    description: template.description,
    visibility: template.defaultVisibility,
    priority: template.defaultPriority,
    content: [createLocalTextBlock("")],
  }
}

export function buildEditableCustomDoc(): EditableDoc {
  return {
    id: crypto.randomUUID(),
    key: "custom",
    title: "Custom section",
    description:
      "Additional profile context that does not fit the common sections.",
    visibility: "always",
    priority: 40,
    content: [createLocalTextBlock("")],
  }
}

export function buildInitialDocs(actor?: Actor | null): EditableDoc[] {
  return [...(actor?.definition.docs || [])]
    .map((doc) => docToEditableDoc(doc))
    .sort((left, right) => {
      if (right.priority !== left.priority)
        return right.priority - left.priority
      return left.title.localeCompare(right.title)
    })
}

export function getAvailableActorDocTemplates(
  docs: Array<Pick<EditableDoc, "key">>
) {
  const existingStandardKeys = new Set(
    docs
      .filter((doc) => !isCustomDocKey(doc.key))
      .map((doc) => doc.key as CoreActorDocKey)
  )
  return ACTOR_DOC_TEMPLATES.filter(
    (template) => !existingStandardKeys.has(template.key)
  )
}

export function buildInitialState(actor?: Actor | null): ActorFormState {
  const definition = actor?.definition
  return {
    name: definition?.name || "",
    role: definition?.role || "specialist",
    title: definition?.title || "",
    parentId: definition?.parentId || null,
    avatarFileId: definition?.avatarFileId,
    avatarUrl: actor?.avatarUrl,
    canRepresentUser: definition?.canRepresentUser || false,
    specialties: (definition?.specialties || []).join(", "),
    docs: buildInitialDocs(actor),
  }
}

export function editableDocToActorDoc(doc: EditableDoc): ActorDoc | null {
  const content = normalizeCanonicalContentBlocks(doc.content)

  if (!hasMeaningfulContent(content)) return null

  return {
    id: doc.id,
    key: doc.key,
    title: doc.title.trim() || "Untitled section",
    content,
    visibility: doc.visibility,
    priority: doc.priority,
  }
}

export function fileRecordToBlock(file: UploadedFile): FileRefBlock {
  return fileRefBlock({
    fileId: file.id,
    url: file.url || resolveFileUrl(file.fullUrl) || "",
    mimeType: file.mimeType,
    originalName: file.originalName,
    sizeBytes: file.sizeBytes,
    category: mimeToCategory(file.mimeType),
  })
}

export function createEmptyTextContentBlock(text = "") {
  return createLocalTextBlock(text)
}
