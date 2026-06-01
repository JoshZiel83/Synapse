"use client"

import {
  extractText,
  SUBJECT_KIND,
  type CanonicalContentBlock,
  type Memory as SharedMemory,
  type MemoryCategory,
  type MemoryItemState,
  type SubjectRef,
} from "@synapse/shared"
import {
  Bot,
  Building2,
  MessagesSquare,
  type LucideIcon,
  UserRound,
} from "lucide-react"
import { createEmptyTextContentBlock } from "@/components/actor-editor-model"

/**
 * D4: web-next UI still organizes memory by the 5 legacy presets. The shared
 * Memory wire type is now subject-driven (owner + scope?). This module keeps
 * the legacy preset model intact by deriving (spaceType, actorId,
 * conversationId, workspaceMemberId) from (owner, scope) on the way IN and
 * translating back on the way OUT.
 */
export type MemorySpaceType =
  | "workspace_shared"
  | "conversation_shared"
  | "actor_private"
  | "participant_private"
  | "user_private"

export type Memory = SharedMemory & {
  // Derived projections for UI grouping. NOT carried by SharedMemory.
  spaceType: MemorySpaceType | "custom"
  actorId?: string
  conversationId?: string
  workspaceMemberId?: string
  actorName?: string
  conversationTitle?: string
  workspaceMemberName?: string
}

function inferPresetFromSubjects(
  owner: SubjectRef,
  scope?: SubjectRef
): MemorySpaceType | "custom" {
  if (owner.kind === SUBJECT_KIND.WORKSPACE && !scope) return "workspace_shared"
  if (owner.kind === SUBJECT_KIND.CONVERSATION && !scope)
    return "conversation_shared"
  if (owner.kind === SUBJECT_KIND.ACTOR && !scope) return "actor_private"
  if (
    owner.kind === SUBJECT_KIND.ACTOR &&
    scope?.kind === SUBJECT_KIND.CONVERSATION
  )
    return "participant_private"
  if (owner.kind === SUBJECT_KIND.WORKSPACE_MEMBER && !scope)
    return "user_private"
  return "custom"
}

/**
 * Wire-projection: cast the shared Memory into the UI-facing Memory by
 * deriving the legacy preset fields. Use this whenever you load a
 * SharedMemory from the API.
 */
export function projectMemory(memory: SharedMemory): Memory {
  const spaceType = inferPresetFromSubjects(memory.owner, memory.scope)
  const actorId =
    memory.owner.kind === SUBJECT_KIND.ACTOR ? memory.owner.actorId : undefined
  const conversationId =
    memory.owner.kind === SUBJECT_KIND.CONVERSATION
      ? memory.owner.conversationId
      : memory.scope?.kind === SUBJECT_KIND.CONVERSATION
        ? memory.scope.conversationId
        : undefined
  const workspaceMemberId =
    memory.owner.kind === SUBJECT_KIND.WORKSPACE_MEMBER
      ? memory.owner.memberId
      : undefined
  return {
    ...memory,
    spaceType,
    actorId,
    conversationId,
    workspaceMemberId,
  }
}

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
    spaceType: MemorySpaceType
    actorId?: string
    conversationId?: string
    workspaceMemberId?: string
  }
}

export type MemoryFolderPreset = NonNullable<MemoryFolderNode["createPreset"]>

export type EditorState = {
  id?: string
  mode: "create" | "edit"
  spaceType: MemorySpaceType
  actorId: string
  conversationId: string
  workspaceMemberId: string
  category: MemoryCategory
  state: MemoryItemState
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
      ? group.participants
          .map((participant: any) => participant.actorId || participant.id)
          .filter(Boolean)
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

  const fileBlock = memory.contentBlocks.find(
    (block) => block.type === "file_ref"
  )
  if (fileBlock?.name) {
    return fileBlock.name
  }

  return "Untitled memory"
}

export function cloneBlocks(blocks: CanonicalContentBlock[]) {
  return structuredClone(blocks)
}

export function hasMeaningfulBlocks(blocks: CanonicalContentBlock[]) {
  return blocks.some((block) => {
    if (block.type === "file_ref") return true
    if (block.type === "mention") return true
    return block.text.trim().length > 0
  })
}

export function createDraftState(
  preset: MemoryFolderPreset,
  currentWorkspaceMemberId: string
): EditorState {
  return {
    mode: "create",
    spaceType: preset.spaceType,
    actorId: preset.actorId || "",
    conversationId: preset.conversationId || "",
    workspaceMemberId:
      preset.spaceType === "user_private"
        ? preset.workspaceMemberId || currentWorkspaceMemberId
        : "",
    category: "fact",
    state: "active",
    importance: 0.7,
    confidence: 0.8,
    tags: "",
    textDigest: "",
    contentBlocks: [createEmptyTextContentBlock("")],
  }
}

export function createEditorStateFromMemory(memory: Memory): EditorState {
  // Editor only supports the 5 legacy presets; coerce custom to actor_private.
  const spaceType: MemorySpaceType =
    memory.spaceType === "custom" ? "actor_private" : memory.spaceType
  return {
    id: memory.id,
    mode: "edit",
    spaceType,
    actorId: memory.actorId || "",
    conversationId: memory.conversationId || "",
    workspaceMemberId: memory.workspaceMemberId || "",
    category: memory.category,
    state: memory.state,
    importance: memory.importance,
    confidence: memory.confidence,
    tags: memory.tags.join(", "),
    textDigest: memory.textDigest,
    contentBlocks: cloneBlocks(
      memory.contentBlocks.length > 0
        ? memory.contentBlocks
        : [createEmptyTextContentBlock("")]
    ),
  }
}

export function serializeEditorState(editor: EditorState | null) {
  if (!editor) return ""

  return JSON.stringify({
    ...editor,
    contentBlocks: editor.contentBlocks,
  })
}

/**
 * Build the wire payload for the memory controller. Uses the legacy preset
 * shim (preset + presetActorId/...) so the controller's preset translator
 * synthesizes the right (owner, scope) tuple server-side.
 */
export function buildMemoryPayload(editor: EditorState) {
  return {
    preset: editor.spaceType,
    presetActorId:
      editor.spaceType === "actor_private" ||
      editor.spaceType === "participant_private"
        ? editor.actorId || undefined
        : undefined,
    presetConversationId:
      editor.spaceType === "conversation_shared" ||
      editor.spaceType === "participant_private"
        ? editor.conversationId || undefined
        : undefined,
    presetWorkspaceMemberId:
      editor.spaceType === "user_private"
        ? editor.workspaceMemberId || undefined
        : undefined,
    category: editor.category,
    state: editor.state,
    importance: editor.importance,
    confidence: editor.confidence,
    tags: editor.tags
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean),
    textDigest: editor.textDigest || undefined,
    contentBlocks: editor.contentBlocks,
  }
}

function sortByName<T extends { label: string }>(items: T[]) {
  return [...items].sort((left, right) =>
    left.label.localeCompare(right.label, undefined, { sensitivity: "base" })
  )
}

export function describeFolderVisibility(
  folder: Pick<MemoryFolderNode, "createPreset" | "description">
) {
  if (!folder.createPreset) {
    return (
      folder.description ||
      "Move a memory into a concrete path to define who can read it."
    )
  }

  switch (folder.createPreset.spaceType) {
    case "workspace_shared":
      return "Visible across the workspace."
    case "conversation_shared":
      return "Visible to participants in the selected conversation."
    case "actor_private":
      return "Visible to the selected actor across conversations."
    case "participant_private":
      return "Visible only to the selected actor inside the selected conversation."
    case "user_private":
      return "Visible only in this PM personal memory path for this workspace, reusable across direct actor chats."
    default:
      return folder.description || "Visibility follows the selected path."
  }
}

export function buildMemoryFolderPathLabel(
  folderId: string,
  folders: Map<string, MemoryFolderNode>
) {
  return getFolderSegments(folderId, folders)
    .filter((segment) => segment.id !== "root")
    .map((segment) => segment.label)
    .join(" / ")
}

export function buildMemoryOwnerStateFromPreset(
  preset: MemoryFolderPreset,
  currentWorkspaceMemberId: string
) {
  return {
    spaceType: preset.spaceType,
    actorId: preset.actorId || "",
    conversationId: preset.conversationId || "",
    workspaceMemberId:
      preset.spaceType === "user_private"
        ? preset.workspaceMemberId || currentWorkspaceMemberId
        : "",
  }
}

export function buildMemoryOwnerPayloadFromPreset(
  preset: MemoryFolderPreset,
  currentWorkspaceMemberId: string
) {
  return {
    preset: preset.spaceType,
    presetActorId: preset.actorId || undefined,
    presetConversationId: preset.conversationId || undefined,
    presetWorkspaceMemberId:
      preset.spaceType === "user_private"
        ? preset.workspaceMemberId || currentWorkspaceMemberId
        : undefined,
  }
}

/**
 * P1 fix (post-D4 review): canonical (owner, scope?, namespaceKey) payload
 * for the atomic move endpoint. Mirrors the preset→subject mapping the
 * backend uses but emits the explicit shape (POST /memories/:id/move
 * doesn't accept preset strings).
 */
export function buildMemoryMovePayloadFromPreset(
  preset: MemoryFolderPreset,
  currentWorkspaceMemberId: string,
  workspaceId: string
): {
  owner: { kind: string; [k: string]: unknown }
  scope?: { kind: string; [k: string]: unknown }
  namespaceKey?: string
} | null {
  switch (preset.spaceType) {
    case "workspace_shared":
      return { owner: { kind: "workspace", workspaceId } }
    case "conversation_shared":
      if (!preset.conversationId) return null
      return {
        owner: { kind: "conversation", conversationId: preset.conversationId },
      }
    case "actor_private":
      if (!preset.actorId) return null
      return { owner: { kind: "actor", actorId: preset.actorId } }
    case "participant_private":
      if (!preset.actorId || !preset.conversationId) return null
      return {
        owner: { kind: "actor", actorId: preset.actorId },
        scope: {
          kind: "conversation",
          conversationId: preset.conversationId,
        },
      }
    case "user_private": {
      const memberId =
        preset.workspaceMemberId || currentWorkspaceMemberId || ""
      if (!memberId) return null
      return { owner: { kind: "workspace_member", memberId } }
    }
    default:
      return null
  }
}

export function getFolderIdForOwner(input: {
  workspaceId: string
  currentWorkspaceMemberId: string
  spaceType: MemorySpaceType | "custom"
  actorId?: string
  conversationId?: string
  workspaceMemberId?: string
}) {
  switch (input.spaceType) {
    case "workspace_shared":
      return `folder:workspace:${input.workspaceId}:workspace_shared`
    case "conversation_shared":
      return input.conversationId
        ? `folder:workspace:${input.workspaceId}:conversation:${input.conversationId}:conversation_shared`
        : `folder:workspace:${input.workspaceId}:workspace_shared`
    case "actor_private":
      return input.actorId
        ? `folder:workspace:${input.workspaceId}:actor:${input.actorId}:actor_private`
        : `folder:workspace:${input.workspaceId}:workspace_shared`
    case "participant_private":
      return input.conversationId && input.actorId
        ? `folder:workspace:${input.workspaceId}:conversation:${input.conversationId}:actor:${input.actorId}:participant_private`
        : `folder:workspace:${input.workspaceId}:workspace_shared`
    case "user_private":
      return `folder:user_private:${input.workspaceMemberId || input.currentWorkspaceMemberId}`
    default:
      return "root"
  }
}

function addUniqueFolder(
  folders: MemoryFolderNode[],
  nextFolder: MemoryFolderNode
) {
  if (folders.some((folder) => folder.id === nextFolder.id)) {
    return
  }
  folders.push(nextFolder)
}

function selectMemoryIds(
  memories: Memory[],
  predicate: (memory: Memory) => boolean
) {
  return memories.filter(predicate).map((memory) => memory.id)
}

export function buildMemoryFolders(params: {
  workspaceId: string
  workspaceName: string
  currentWorkspaceMemberId: string
  currentWorkspaceMemberLabel: string
  memories: Memory[]
  actors: ActorOption[]
  groups: GroupOption[]
}) {
  const {
    workspaceId,
    workspaceName,
    currentWorkspaceMemberId,
    currentWorkspaceMemberLabel,
    memories,
    actors,
    groups,
  } = params

  const folders: MemoryFolderNode[] = [
    {
      id: "root",
      label: "Memories",
      description: "Choose a path to define visibility.",
      icon: Building2,
      directMemoryIds: [],
    },
    {
      id: `folder:user_private:${currentWorkspaceMemberId}`,
      parentId: "root",
      label: currentWorkspaceMemberLabel,
      description:
        "PM personal memory for this workspace, reusable across direct actor chats.",
      icon: UserRound,
      directMemoryIds: selectMemoryIds(
        memories,
        (memory) =>
          memory.spaceType === "user_private" &&
          memory.workspaceMemberId === currentWorkspaceMemberId
      ),
      createPreset: {
        spaceType: "user_private",
        workspaceMemberId: currentWorkspaceMemberId,
      },
    },
    {
      id: `folder:workspace:${workspaceId}:workspace_shared`,
      parentId: "root",
      label: workspaceName,
      description: "Visible across the workspace.",
      icon: Building2,
      directMemoryIds: selectMemoryIds(
        memories,
        (memory) => memory.spaceType === "workspace_shared"
      ),
      createPreset: {
        spaceType: "workspace_shared",
      },
    },
  ]

  const actorMap = new Map(actors.map((actor) => [actor.id, actor]))
  const groupMap = new Map(groups.map((group) => [group.id, group]))
  const externalUserPrivateFolderIds = new Set<string>()
  const workspaceFolderId = `folder:workspace:${workspaceId}:workspace_shared`

  for (const memory of memories) {
    if (
      memory.spaceType === "conversation_shared" &&
      memory.conversationId &&
      !groupMap.has(memory.conversationId)
    ) {
      groupMap.set(memory.conversationId, {
        id: memory.conversationId,
        title: memory.conversationTitle || "Unknown conversation",
        actorIds: [],
      })
    }
  }

  for (const group of sortByName(
    Array.from(groupMap.values()).map((item) => ({
      ...item,
      label: item.title,
    }))
  )) {
    const conversationFolderId = `folder:workspace:${workspaceId}:conversation:${group.id}:conversation_shared`
    addUniqueFolder(folders, {
      id: conversationFolderId,
      parentId: workspaceFolderId,
      label: group.title,
      description: "Visible to participants in this conversation.",
      icon: MessagesSquare,
      directMemoryIds: selectMemoryIds(
        memories,
        (memory) =>
          memory.spaceType === "conversation_shared" &&
          memory.conversationId === group.id
      ),
      createPreset: {
        spaceType: "conversation_shared",
        conversationId: group.id,
      },
    })

    const scopedActorIds = new Set(group.actorIds)
    for (const memory of memories) {
      if (
        memory.spaceType === "participant_private" &&
        memory.conversationId === group.id &&
        memory.actorId
      ) {
        scopedActorIds.add(memory.actorId)
      }
    }

    for (const actorId of Array.from(scopedActorIds).sort((left, right) => {
      const leftName = actorMap.get(left)?.name || left
      const rightName = actorMap.get(right)?.name || right
      return leftName.localeCompare(rightName, undefined, {
        sensitivity: "base",
      })
    })) {
      const actor = actorMap.get(actorId)
      addUniqueFolder(folders, {
        id: `folder:workspace:${workspaceId}:conversation:${group.id}:actor:${actorId}:participant_private`,
        parentId: conversationFolderId,
        label: actor?.name || "Unknown actor",
        description: "Visible only to this actor inside this conversation.",
        icon: Bot,
        directMemoryIds: selectMemoryIds(
          memories,
          (memory) =>
            memory.spaceType === "participant_private" &&
            memory.conversationId === group.id &&
            memory.actorId === actorId
        ),
        createPreset: {
          spaceType: "participant_private",
          conversationId: group.id,
          actorId,
        },
      })
    }
  }

  for (const actor of sortByName(
    actors.map((item) => ({ ...item, label: item.name }))
  )) {
    addUniqueFolder(folders, {
      id: `folder:workspace:${workspaceId}:actor:${actor.id}:actor_private`,
      parentId: workspaceFolderId,
      label: actor.name,
      description: "Visible to this actor across conversations.",
      icon: Bot,
      directMemoryIds: selectMemoryIds(
        memories,
        (memory) =>
          memory.spaceType === "actor_private" && memory.actorId === actor.id
      ),
      createPreset: {
        spaceType: "actor_private",
        actorId: actor.id,
      },
    })
  }

  for (const memory of memories) {
    if (
      memory.spaceType === "user_private" &&
      memory.workspaceMemberId &&
      memory.workspaceMemberId !== currentWorkspaceMemberId
    ) {
      const folderId = `folder:user_private:${memory.workspaceMemberId}`
      if (externalUserPrivateFolderIds.has(folderId)) {
        continue
      }
      externalUserPrivateFolderIds.add(folderId)
      addUniqueFolder(folders, {
        id: folderId,
        parentId: "root",
        label: memory.workspaceMemberName || "Unknown member",
        description:
          "PM personal memory for this workspace, reusable across direct actor chats.",
        icon: UserRound,
        directMemoryIds: selectMemoryIds(
          memories,
          (item) =>
            item.spaceType === "user_private" &&
            item.workspaceMemberId === memory.workspaceMemberId
        ),
        createPreset: {
          spaceType: "user_private",
          workspaceMemberId: memory.workspaceMemberId,
        },
      })
    }
  }

  return folders
}

export function getFolderSegments(
  folderId: string,
  folders: Map<string, MemoryFolderNode>
) {
  const segments: MemoryFolderNode[] = []
  let current = folders.get(folderId)

  while (current) {
    segments.unshift(current)
    current = current.parentId ? folders.get(current.parentId) : undefined
  }

  return segments
}
