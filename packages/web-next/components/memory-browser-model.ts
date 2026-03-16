"use client"

import {
  extractText,
  type CanonicalContentBlock,
  type Memory as SharedMemory,
  type MemoryCategory,
  type MemoryScope,
  type MemoryStability,
  type MemoryStatus,
} from "@synapse/shared"

import { Bot, Building2, MessagesSquare, type LucideIcon, UserRound } from "lucide-react"

import { createEmptyTextContentBlock } from "@/components/actor-editor-model"

export type Memory = SharedMemory & {
  actorName?: string
  conversationTitle?: string
  userName?: string
}

export type { MemoryScope }

export type ActorOption = {
  id: string
  name: string
  title?: string
}

export type GroupOption = {
  id: string
  title: string
  actorIds: string[]
}

export type MemoryFolderNode = {
  id: string
  parentId?: string
  label: string
  description?: string
  icon: LucideIcon
  directMemoryIds: string[]
  createPreset?: {
    ownerScope: MemoryScope
    ownerActorId?: string
    ownerConversationId?: string
    ownerUserId?: string
  }
}

export type MemoryFolderPreset = NonNullable<MemoryFolderNode["createPreset"]>

export type EditorState = {
  id?: string
  mode: "create" | "edit"
  ownerScope: MemoryScope
  ownerActorId: string
  ownerConversationId: string
  ownerUserId: string
  category: MemoryCategory
  status: MemoryStatus
  stability: MemoryStability
  importance: number
  confidence: number
  tags: string
  textDigest: string
  contentBlocks: CanonicalContentBlock[]
}

export function normalizeActorOption(actor: any): ActorOption {
  const definition = actor?.definition || actor
  return {
    id: actor.id,
    name: definition?.name || actor.name || "Untitled actor",
    title: definition?.title || actor.title || undefined,
  }
}

export function normalizeGroupOption(group: any): GroupOption {
  return {
    id: group.id,
    title: group.title || group.name || "Untitled conversation",
    actorIds: Array.isArray(group.participants)
      ? group.participants.map((participant: any) => participant.id).filter(Boolean)
      : [],
  }
}

export function summarizeMemory(memory: Memory) {
  const digest = memory.textDigest.trim()
  if (digest) return digest

  const text = extractText(memory.contentBlocks).replace(/\s+/g, " ").trim()
  if (text) {
    return text.length > 160 ? `${text.slice(0, 157)}...` : text
  }

  const fileBlock = memory.contentBlocks.find((block) => block.type === "file_ref")
  if (fileBlock?.originalName) {
    return fileBlock.originalName
  }

  return "Untitled memory"
}

export function cloneBlocks(blocks: CanonicalContentBlock[]) {
  return structuredClone(blocks)
}

export function hasMeaningfulBlocks(blocks: CanonicalContentBlock[]) {
  return blocks.some((block) => block.type === "file_ref" || block.text.trim().length > 0)
}

export function createDraftState(
  preset: MemoryFolderPreset,
  currentUserId: string,
): EditorState {
  return {
    mode: "create",
    ownerScope: preset.ownerScope,
    ownerActorId: preset.ownerActorId || "",
    ownerConversationId: preset.ownerConversationId || "",
    ownerUserId: preset.ownerUserId || currentUserId,
    category: "fact",
    status: "established",
    stability: "durable",
    importance: 0.7,
    confidence: 0.8,
    tags: "",
    textDigest: "",
    contentBlocks: [createEmptyTextContentBlock("")],
  }
}

export function createEditorStateFromMemory(memory: Memory): EditorState {
  return {
    id: memory.id,
    mode: "edit",
    ownerScope: memory.ownerScope,
    ownerActorId: memory.ownerActorId || "",
    ownerConversationId: memory.ownerConversationId || "",
    ownerUserId: memory.ownerUserId || "",
    category: memory.category,
    status: memory.status,
    stability: memory.stability,
    importance: memory.importance,
    confidence: memory.confidence,
    tags: memory.tags.join(", "),
    textDigest: memory.textDigest,
    contentBlocks: cloneBlocks(memory.contentBlocks.length > 0 ? memory.contentBlocks : [createEmptyTextContentBlock("")]),
  }
}

export function serializeEditorState(editor: EditorState | null) {
  if (!editor) return ""

  return JSON.stringify({
    ...editor,
    contentBlocks: editor.contentBlocks,
  })
}

export function buildMemoryPayload(editor: EditorState) {
  return {
    ownerScope: editor.ownerScope,
    ownerActorId: editor.ownerScope === "actor_global" || editor.ownerScope === "actor_conversation"
      ? editor.ownerActorId || undefined
      : undefined,
    ownerConversationId: editor.ownerScope === "conversation" || editor.ownerScope === "actor_conversation"
      ? editor.ownerConversationId || undefined
      : undefined,
    ownerUserId: editor.ownerScope === "user"
      ? editor.ownerUserId || undefined
      : undefined,
    category: editor.category,
    status: editor.status,
    stability: editor.stability,
    importance: editor.importance,
    confidence: editor.confidence,
    tags: editor.tags.split(",").map((tag) => tag.trim()).filter(Boolean),
    textDigest: editor.textDigest || undefined,
    contentBlocks: editor.contentBlocks,
  }
}

function sortByName<T extends { label: string }>(items: T[]) {
  return [...items].sort((left, right) => left.label.localeCompare(right.label, undefined, { sensitivity: "base" }))
}

export function describeFolderVisibility(folder: Pick<MemoryFolderNode, "createPreset" | "description">) {
  if (!folder.createPreset) {
    return folder.description || "Move a memory into a concrete path to define who can read it."
  }

  switch (folder.createPreset.ownerScope) {
    case "workspace":
      return "Visible across the workspace."
    case "user":
      return "Visible only in your personal memory path."
    case "conversation":
      return "Visible to participants in the selected conversation."
    case "actor_global":
      return "Available to the selected actor across conversations."
    case "actor_conversation":
      return "Available only to the selected actor inside the selected conversation."
    default:
      return folder.description || "Visibility follows the selected path."
  }
}

export function buildMemoryFolderPathLabel(folderId: string, folders: Map<string, MemoryFolderNode>) {
  return getFolderSegments(folderId, folders)
    .filter((segment) => segment.id !== "root")
    .map((segment) => segment.label)
    .join(" / ")
}

export function buildMemoryOwnerStateFromPreset(preset: MemoryFolderPreset, currentUserId: string) {
  return {
    ownerScope: preset.ownerScope,
    ownerActorId: preset.ownerActorId || "",
    ownerConversationId: preset.ownerConversationId || "",
    ownerUserId: preset.ownerScope === "user" ? preset.ownerUserId || currentUserId : "",
  }
}

export function buildMemoryOwnerPayloadFromPreset(preset: MemoryFolderPreset, currentUserId: string) {
  return {
    ownerScope: preset.ownerScope,
    ownerActorId: preset.ownerActorId || undefined,
    ownerConversationId: preset.ownerConversationId || undefined,
    ownerUserId: preset.ownerScope === "user" ? preset.ownerUserId || currentUserId : undefined,
  }
}

export function getFolderIdForOwner(input: {
  workspaceId: string
  currentUserId: string
  ownerScope: MemoryScope
  ownerActorId?: string
  ownerConversationId?: string
  ownerUserId?: string
}) {
  switch (input.ownerScope) {
    case "workspace":
      return `folder:workspace:${input.workspaceId}`
    case "user":
      return `folder:user:${input.ownerUserId || input.currentUserId}`
    case "conversation":
      return input.ownerConversationId
        ? `folder:workspace:${input.workspaceId}:conversation:${input.ownerConversationId}`
        : `folder:workspace:${input.workspaceId}`
    case "actor_global":
      return input.ownerActorId
        ? `folder:workspace:${input.workspaceId}:actor:${input.ownerActorId}`
        : `folder:workspace:${input.workspaceId}`
    case "actor_conversation":
      return input.ownerConversationId && input.ownerActorId
        ? `folder:workspace:${input.workspaceId}:conversation:${input.ownerConversationId}:actor:${input.ownerActorId}`
        : `folder:workspace:${input.workspaceId}`
    default:
      return "root"
  }
}

export function buildMemoryFolders(params: {
  workspaceId: string
  workspaceName: string
  currentUserId: string
  currentUserLabel: string
  memories: Memory[]
  actors: ActorOption[]
  groups: GroupOption[]
}) {
  const { workspaceId, workspaceName, currentUserId, currentUserLabel, memories, actors, groups } = params

  const folders: MemoryFolderNode[] = [
    {
      id: "root",
      label: "Memories",
      description: "Choose a path to define visibility.",
      icon: Building2,
      directMemoryIds: [],
    },
    {
      id: `folder:user:${currentUserId}`,
      parentId: "root",
      label: currentUserLabel,
      description: "Visible only in your personal memory path.",
      icon: UserRound,
      directMemoryIds: memories
        .filter((memory) => memory.ownerScope === "user" && memory.ownerUserId === currentUserId)
        .map((memory) => memory.id),
      createPreset: {
        ownerScope: "user",
        ownerUserId: currentUserId,
      },
    },
    {
      id: `folder:workspace:${workspaceId}`,
      parentId: "root",
      label: workspaceName,
      description: "Visible across the workspace.",
      icon: Building2,
      directMemoryIds: memories
        .filter((memory) => memory.ownerScope === "workspace")
        .map((memory) => memory.id),
      createPreset: {
        ownerScope: "workspace",
      },
    },
  ]

  const actorMap = new Map(actors.map((actor) => [actor.id, actor]))
  const groupMap = new Map(groups.map((group) => [group.id, group]))

  for (const group of sortByName(groups.map((item) => ({ ...item, label: item.title })))) {
    const conversationFolderId = `folder:workspace:${workspaceId}:conversation:${group.id}`
    folders.push({
      id: conversationFolderId,
      parentId: `folder:workspace:${workspaceId}`,
      label: group.title,
      description: "Visible to participants in this conversation.",
      icon: MessagesSquare,
      directMemoryIds: memories
        .filter((memory) => memory.ownerScope === "conversation" && memory.ownerConversationId === group.id)
        .map((memory) => memory.id),
      createPreset: {
        ownerScope: "conversation",
        ownerConversationId: group.id,
      },
    })

    const scopedActorIds = new Set(group.actorIds)
    for (const memory of memories) {
      if (memory.ownerScope === "actor_conversation" && memory.ownerConversationId === group.id && memory.ownerActorId) {
        scopedActorIds.add(memory.ownerActorId)
      }
    }

    for (const actorId of Array.from(scopedActorIds).sort((left, right) => {
      const leftName = actorMap.get(left)?.name || left
      const rightName = actorMap.get(right)?.name || right
      return leftName.localeCompare(rightName, undefined, { sensitivity: "base" })
    })) {
      const actor = actorMap.get(actorId)
      folders.push({
        id: `${conversationFolderId}:actor:${actorId}`,
        parentId: conversationFolderId,
        label: actor?.name || "Unknown actor",
        description: "Available only to this actor inside this conversation.",
        icon: Bot,
        directMemoryIds: memories
          .filter(
            (memory) =>
              memory.ownerScope === "actor_conversation" &&
              memory.ownerConversationId === group.id &&
              memory.ownerActorId === actorId,
          )
          .map((memory) => memory.id),
        createPreset: {
          ownerScope: "actor_conversation",
          ownerConversationId: group.id,
          ownerActorId: actorId,
        },
      })
    }
  }

  for (const actor of sortByName(actors.map((item) => ({ ...item, label: item.name })))) {
    folders.push({
      id: `folder:workspace:${workspaceId}:actor:${actor.id}`,
      parentId: `folder:workspace:${workspaceId}`,
      label: actor.name,
      description: "Available to this actor across conversations.",
      icon: Bot,
      directMemoryIds: memories
        .filter((memory) => memory.ownerScope === "actor_global" && memory.ownerActorId === actor.id)
        .map((memory) => memory.id),
      createPreset: {
        ownerScope: "actor_global",
        ownerActorId: actor.id,
      },
    })
  }

  for (const memory of memories) {
    if (memory.ownerScope === "user" && memory.ownerUserId && memory.ownerUserId !== currentUserId) {
      folders.push({
        id: `folder:user:${memory.ownerUserId}`,
        parentId: "root",
        label: memory.userName || "Unknown user",
        description: "Visible only in this personal memory path.",
        icon: UserRound,
        directMemoryIds: memories
          .filter((item) => item.ownerScope === "user" && item.ownerUserId === memory.ownerUserId)
          .map((item) => item.id),
        createPreset: {
          ownerScope: "user",
          ownerUserId: memory.ownerUserId,
        },
      })
    }

    if (memory.ownerScope === "conversation" && memory.ownerConversationId && !groupMap.has(memory.ownerConversationId)) {
      folders.push({
        id: `folder:workspace:${workspaceId}:conversation:${memory.ownerConversationId}`,
        parentId: `folder:workspace:${workspaceId}`,
        label: memory.conversationTitle || "Unknown conversation",
        description: "Visible to participants in this conversation.",
        icon: MessagesSquare,
        directMemoryIds: memories
          .filter((item) => item.ownerScope === "conversation" && item.ownerConversationId === memory.ownerConversationId)
          .map((item) => item.id),
        createPreset: {
          ownerScope: "conversation",
          ownerConversationId: memory.ownerConversationId,
        },
      })
      groupMap.set(memory.ownerConversationId, {
        id: memory.ownerConversationId,
        title: memory.conversationTitle || "Unknown conversation",
        actorIds: [],
      })
    }
  }

  return folders.filter((folder, index, all) => all.findIndex((candidate) => candidate.id === folder.id) === index)
}

export function getFolderSegments(folderId: string, folders: Map<string, MemoryFolderNode>) {
  const segments: MemoryFolderNode[] = []
  let current = folders.get(folderId)

  while (current) {
    segments.unshift(current)
    current = current.parentId ? folders.get(current.parentId) : undefined
  }

  return segments
}
