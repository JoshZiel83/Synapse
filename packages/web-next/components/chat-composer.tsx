"use client"

import {
  forwardRef,
  startTransition,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { Extension } from "@tiptap/core"
import {
  fileRefBlock,
  mentionBlock,
  textBlock,
  type CanonicalContentBlock,
  type ConversationEntityRef,
} from "@synapse/shared"
import Mention from "@tiptap/extension-mention"
import Placeholder from "@tiptap/extension-placeholder"
import StarterKit from "@tiptap/starter-kit"
import type { Node as ProseMirrorNode } from "@tiptap/pm/model"
import { EditorContent, ReactRenderer, useEditor } from "@tiptap/react"
import Suggestion from "@tiptap/suggestion"
import type {
  SuggestionKeyDownProps,
  SuggestionProps,
} from "@tiptap/suggestion"
import { PluginKey } from "@tiptap/pm/state"
import {
  AtSign,
  FileText,
  Hash,
  Loader2,
  Paperclip,
  Send,
  SmilePlus,
  X,
} from "lucide-react"
import { toast } from "sonner"

import ChatAvatar from "@/app/dashboard/chat/chat-avatar"
import { Button } from "@/components/ui/button"
import { searchEmojiSuggestions } from "@/lib/emoji"
import { api } from "@/lib/api"
import { cn } from "@/lib/utils"

const CHAT_ATTACHMENT_ACCEPT =
  "image/*,audio/*,video/*,.pdf,.doc,.docx,.txt,.csv,.xls,.xlsx"
const MAX_ATTACHMENT_SIZE_BYTES = 25 * 1024 * 1024
const PARTICIPANT_SUGGESTION_KEY = new PluginKey("chat-composer-participants")
const ATTACHMENT_SUGGESTION_KEY = new PluginKey("chat-composer-attachments")
const EMOJI_SUGGESTION_KEY = new PluginKey("chat-composer-emojis")

type SuggestionTrigger = "@" | "#" | ":"
type MentionTargetType = "participant" | "actor" | "attachment"

type PendingAttachment = {
  id: string
  file: File
}

type ComposerMentionNodeAttrs = {
  id?: string | null
  label?: string | null
  mentionSuggestionChar?: SuggestionTrigger | null
  targetType?: MentionTargetType | null
  memberType?: ConversationEntityRef["memberType"] | null
  memberId?: string | null
  participantId?: string | null
  actorId?: string | null
  workspaceMemberId?: string | null
  externalUserKey?: string | null
  transportAddressId?: string | null
  transportKind?: ConversationEntityRef["transportKind"] | null
  title?: string | null
  role?: string | null
  avatarUrl?: string | null
  avatarEmoji?: string | null
}

type ComposerSuggestionItem = {
  id: string
  label: string
  description?: string
  trigger: SuggestionTrigger
  kind: "participant" | "attachment" | "emoji"
  targetType?: MentionTargetType
  participantType?: "actor" | "workspace_member" | "external"
  avatarUrl?: string
  emoji?: string
  inGroup?: boolean
  native?: string
  memberType?: ConversationEntityRef["memberType"]
  memberId?: string
  participantId?: string
  actorId?: string
  workspaceMemberId?: string
  externalUserKey?: string
  transportAddressId?: string
  transportKind?: ConversationEntityRef["transportKind"]
  title?: string
  role?: string
  avatarEmoji?: string
}

type SuggestionListHandle = {
  onKeyDown: (props: SuggestionKeyDownProps) => boolean
}

export type ChatComposerParticipant = {
  id: string
  name: string
  type: "actor" | "workspace_member" | "external"
  targetType?: "actor" | "participant"
  inGroup?: boolean
  role?: string
  title?: string
  avatarUrl?: string
  emoji?: string
  description?: string
  searchTerms?: string[]
  memberId?: string
  participantId?: string
  actorId?: string
  workspaceMemberId?: string
  externalUserKey?: string
  transportAddressId?: string
  transportKind?: ConversationEntityRef["transportKind"]
}

export type ChatComposerSubmitPayload = {
  plainText: string
  contentBlocks: CanonicalContentBlock[]
  targetParticipantIds?: string[]
  targetActorIds?: string[]
  citedAttachmentIds?: string[]
}

type ChatComposerProps = {
  workspaceId: string | null
  participants?: ChatComposerParticipant[]
  disabled?: boolean
  placeholder?: string
  resetSignal?: number | string
  className?: string
  editorClassName?: string
  header?: ReactNode
  submitLabel?: string
  renderSubmitButton?: (props: {
    disabled: boolean
    submitting: boolean
    label: string
  }) => ReactNode
  onSubmit: (
    payload: ChatComposerSubmitPayload
  ) => Promise<boolean | void> | boolean | void
}

function createAttachmentId() {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID()
  }

  return `attachment-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function filterParticipants(
  participants: ChatComposerParticipant[],
  query: string
): ComposerSuggestionItem[] {
  const normalizedQuery = query.trim().toLowerCase()

  return participants
    .filter((participant) => {
      if (!normalizedQuery) return true

      const haystack = [
        participant.name,
        participant.description || "",
        ...(participant.searchTerms || []),
      ]
        .join(" ")
        .toLowerCase()

      return haystack.includes(normalizedQuery)
    })
    .map((participant) => {
      const targetType =
        participant.targetType ||
        (participant.type === "actor" ? "actor" : "participant")

      return {
        id: participant.id,
        label: participant.name,
        description: participant.description,
        trigger: "@",
        kind: "participant" as const,
        targetType,
        participantType: participant.type,
        avatarUrl: participant.avatarUrl,
        emoji: participant.emoji,
        inGroup: participant.inGroup,
        memberType: participant.type,
        memberId: participant.memberId,
        participantId:
          participant.participantId ||
          (targetType === "participant" ? participant.id : undefined),
        actorId:
          participant.actorId ||
          (participant.type === "actor" ? participant.id : undefined),
        workspaceMemberId: participant.workspaceMemberId,
        externalUserKey: participant.externalUserKey,
        transportAddressId: participant.transportAddressId,
        transportKind: participant.transportKind,
        title: participant.title,
        role: participant.role,
        avatarEmoji: participant.emoji,
      }
    })
}

function filterAttachments(
  attachments: PendingAttachment[],
  query: string
): ComposerSuggestionItem[] {
  const normalizedQuery = query.trim().toLowerCase()

  return attachments
    .filter((attachment) => {
      if (!normalizedQuery) return true
      return attachment.file.name.toLowerCase().includes(normalizedQuery)
    })
    .map((attachment) => ({
      id: attachment.id,
      label: attachment.file.name,
      description: formatFileSize(attachment.file.size),
      trigger: "#",
      kind: "attachment" as const,
      targetType: "attachment" as const,
    }))
}

function collectMentionTargets(
  editor: NonNullable<ReturnType<typeof useEditor>>
) {
  const mentionedParticipantIds = new Set<string>()
  const mentionedActorIds = new Set<string>()
  const citedAttachmentIds = new Set<string>()

  editor.state.doc.descendants((node) => {
    if (node.type.name !== "mention") return true

    const attrs = node.attrs as ComposerMentionNodeAttrs
    if (!attrs.id) return true

    if (attrs.targetType === "actor") {
      mentionedActorIds.add(attrs.id)
      return true
    }

    if (attrs.targetType === "participant") {
      mentionedParticipantIds.add(attrs.id)
      return true
    }

    if (attrs.targetType === "attachment") {
      citedAttachmentIds.add(attrs.id)
    }

    return true
  })

  return {
    mentionedParticipantIds: Array.from(mentionedParticipantIds),
    mentionedActorIds: Array.from(mentionedActorIds),
    citedAttachmentIds: Array.from(citedAttachmentIds),
  }
}

function buildMentionRef(
  attrs: ComposerMentionNodeAttrs
): ConversationEntityRef | null {
  const memberType = attrs.memberType
  if (!memberType) return null

  const mention: ConversationEntityRef = {
    memberType,
    ...(attrs.memberId ? { memberId: attrs.memberId } : {}),
    ...(attrs.participantId ? { participantId: attrs.participantId } : {}),
    ...(attrs.actorId ? { actorId: attrs.actorId } : {}),
    ...(attrs.workspaceMemberId
      ? { workspaceMemberId: attrs.workspaceMemberId }
      : {}),
    ...(attrs.externalUserKey
      ? { externalUserKey: attrs.externalUserKey }
      : {}),
    ...(attrs.transportAddressId
      ? { transportAddressId: attrs.transportAddressId }
      : {}),
    ...(attrs.transportKind ? { transportKind: attrs.transportKind } : {}),
    ...(attrs.label ? { name: attrs.label } : {}),
    ...(attrs.title ? { title: attrs.title } : {}),
    ...(attrs.role ? { role: attrs.role } : {}),
    ...(attrs.avatarUrl ? { avatarUrl: attrs.avatarUrl } : {}),
    ...(attrs.avatarEmoji ? { avatarEmoji: attrs.avatarEmoji } : {}),
  }

  if (!mention.actorId && memberType === "actor" && attrs.id) {
    mention.actorId = attrs.id
  }

  if (
    !mention.participantId &&
    attrs.targetType === "participant" &&
    attrs.id
  ) {
    mention.participantId = attrs.id
  }

  return mention
}

function buildComposerContentBlocks(
  editor: NonNullable<ReturnType<typeof useEditor>>,
  attachmentBlocks: Array<Extract<CanonicalContentBlock, { type: "file_ref" }>>
) {
  const contentBlocks: CanonicalContentBlock[] = []
  let textBuffer = ""

  function flushTextBuffer() {
    if (!textBuffer) return
    contentBlocks.push(textBlock(textBuffer))
    textBuffer = ""
  }

  function appendText(text: string | null | undefined) {
    if (!text) return
    textBuffer += text
  }

  function serializeNode(node: ProseMirrorNode) {
    if (node.isText) {
      appendText(node.text)
      return
    }

    if (node.type.name === "hardBreak") {
      appendText("\n")
      return
    }

    if (node.type.name === "mention") {
      const attrs = node.attrs as ComposerMentionNodeAttrs
      const label = attrs.label?.trim() || attrs.id || "unknown"

      if (attrs.targetType === "attachment") {
        appendText(`#${label}`)
        return
      }

      const mention = buildMentionRef(attrs)
      if (!mention) {
        appendText(`${attrs.mentionSuggestionChar || "@"}${label}`)
        return
      }

      flushTextBuffer()
      contentBlocks.push(mentionBlock({ mention }))
      return
    }

    node.forEach((child) => {
      serializeNode(child)
    })
  }

  editor.state.doc.forEach((node, _offset, index) => {
    serializeNode(node)

    if (index < editor.state.doc.childCount - 1) {
      appendText("\n")
    }
  })

  flushTextBuffer()
  contentBlocks.push(...attachmentBlocks)

  return contentBlocks
}

function removeAttachmentMentions(
  editor: NonNullable<ReturnType<typeof useEditor>>,
  attachmentId: string
) {
  const positions: Array<{ from: number; to: number }> = []

  editor.state.doc.descendants((node, pos) => {
    if (node.type.name !== "mention") return true

    const attrs = node.attrs as ComposerMentionNodeAttrs
    if (attrs.targetType === "attachment" && attrs.id === attachmentId) {
      positions.push({ from: pos, to: pos + node.nodeSize })
    }

    return true
  })

  if (positions.length === 0) return

  editor
    .chain()
    .command(({ tr }) => {
      positions
        .sort((left, right) => right.from - left.from)
        .forEach((position) => {
          tr.delete(position.from, position.to)
        })
      return true
    })
    .run()
}

const ComposerSuggestionList = forwardRef<
  SuggestionListHandle,
  SuggestionProps<ComposerSuggestionItem, ComposerSuggestionItem>
>(function ComposerSuggestionList(props, ref) {
  const { items, command } = props
  const [selectedIndexState, setSelectedIndex] = useState(0)
  const selectedIndex =
    items.length === 0 || selectedIndexState >= items.length
      ? 0
      : selectedIndexState

  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }) => {
      if (items.length === 0) return false

      if (event.key === "ArrowUp") {
        event.preventDefault()
        setSelectedIndex((current) =>
          current <= 0 ? items.length - 1 : current - 1
        )
        return true
      }

      if (event.key === "ArrowDown") {
        event.preventDefault()
        setSelectedIndex((current) =>
          current >= items.length - 1 ? 0 : current + 1
        )
        return true
      }

      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault()
        const selected = items[selectedIndex]
        if (selected) {
          command(selected)
          return true
        }
      }

      return false
    },
  }))

  if (items.length === 0) {
    return (
      <div className="w-80 rounded-3xl border border-border bg-popover p-3 text-sm text-muted-foreground shadow-2xl">
        No matches.
      </div>
    )
  }

  return (
    <div className="w-80 overflow-hidden rounded-3xl border border-border bg-popover p-2 shadow-2xl">
      <div className="max-h-72 overflow-y-auto">
        {items.map((item, index) => {
          const active = index === selectedIndex

          return (
            <button
              key={`${item.trigger}-${item.id}`}
              type="button"
              className={cn(
                "flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left transition-colors",
                active ? "bg-primary/8 text-foreground" : "text-foreground"
              )}
              onMouseDown={(event) => {
                event.preventDefault()
                command(item)
              }}
            >
              {item.kind === "participant" ? (
                <ChatAvatar
                  name={item.label}
                  avatarUrl={item.avatarUrl}
                  emoji={item.emoji}
                  entityType={item.participantType || "workspace_member"}
                  size="sm"
                />
              ) : item.kind === "emoji" ? (
                <div className="flex size-8 shrink-0 items-center justify-center rounded-2xl border border-border bg-muted/50 text-lg">
                  {item.native}
                </div>
              ) : (
                <div className="flex size-8 shrink-0 items-center justify-center rounded-2xl border border-border bg-muted/50 text-muted-foreground">
                  <FileText className="size-4" />
                </div>
              )}
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">
                  {item.kind === "emoji"
                    ? `${item.native} ${item.label}`
                    : `${item.trigger}${item.label}`}
                </div>
                {item.description ? (
                  <div className="truncate text-xs text-muted-foreground">
                    {item.description}
                  </div>
                ) : null}
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
})

function createSuggestionRenderer() {
  return () => {
    let reactRenderer: ReactRenderer<
      SuggestionListHandle,
      SuggestionProps<ComposerSuggestionItem, ComposerSuggestionItem>
    > | null = null
    let popup: HTMLDivElement | null = null

    function updatePopupPosition(
      props: SuggestionProps<ComposerSuggestionItem, ComposerSuggestionItem>
    ) {
      const rect = props.clientRect?.()
      if (!rect || !popup) return

      popup.style.top = `${Math.min(
        rect.bottom + 8,
        window.innerHeight - popup.offsetHeight - 12
      )}px`
      popup.style.left = `${Math.min(
        rect.left,
        window.innerWidth - popup.offsetWidth - 12
      )}px`
    }

    function destroyPopup() {
      popup?.remove()
      popup = null
      reactRenderer?.destroy()
      reactRenderer = null
    }

    return {
      onStart(
        props: SuggestionProps<ComposerSuggestionItem, ComposerSuggestionItem>
      ) {
        reactRenderer = new ReactRenderer(ComposerSuggestionList, {
          editor: props.editor,
          props,
        })

        popup = document.createElement("div")
        popup.className = "fixed z-[120]"
        popup.appendChild(reactRenderer.element)
        document.body.appendChild(popup)

        requestAnimationFrame(() => {
          updatePopupPosition(props)
        })
      },
      onUpdate(
        props: SuggestionProps<ComposerSuggestionItem, ComposerSuggestionItem>
      ) {
        reactRenderer?.updateProps(props)

        requestAnimationFrame(() => {
          updatePopupPosition(props)
        })
      },
      onKeyDown(props: SuggestionKeyDownProps) {
        if (props.event.key === "Escape") {
          destroyPopup()
          return true
        }

        return reactRenderer?.ref?.onKeyDown(props) ?? false
      },
      onExit() {
        destroyPopup()
      },
    }
  }
}

const ComposerMention = Mention.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      targetType: {
        default: "participant",
        parseHTML: (element) => element.getAttribute("data-target-type"),
        renderHTML: (attributes) =>
          attributes.targetType
            ? {
                "data-target-type": attributes.targetType,
              }
            : {},
      },
      memberType: { default: null },
      memberId: { default: null },
      participantId: { default: null },
      actorId: { default: null },
      workspaceMemberId: { default: null },
      externalUserKey: { default: null },
      transportAddressId: { default: null },
      transportKind: { default: null },
      title: { default: null },
      role: { default: null },
      avatarUrl: { default: null },
      avatarEmoji: { default: null },
    }
  },
})

const EmojiSuggestionExtension = Extension.create({
  name: "chat-composer-emoji-suggestion",

  addProseMirrorPlugins() {
    return [
      Suggestion<ComposerSuggestionItem, ComposerSuggestionItem>({
        editor: this.editor,
        pluginKey: EMOJI_SUGGESTION_KEY,
        char: ":",
        allowedPrefixes: null,
        allow: ({ state, range }) => {
          const previousCharacter = state.doc.textBetween(
            Math.max(0, range.from - 1),
            range.from,
            "\n",
            "\0"
          )

          return !/[0-9A-Za-z/]/.test(previousCharacter)
        },
        items: async ({ query }) => {
          const emojis = await searchEmojiSuggestions(query)
          return emojis.map((emoji) => ({
            id: emoji.id,
            label: emoji.label,
            description: emoji.description,
            trigger: ":",
            kind: "emoji" as const,
            native: emoji.native,
            emoji: emoji.native,
          }))
        },
        command: ({ editor, range, props }) => {
          if (!props.native) return

          editor
            .chain()
            .focus()
            .insertContentAt(range, `${props.native} `)
            .run()
        },
        render: createSuggestionRenderer(),
      }),
    ]
  },
})

export default function ChatComposer({
  workspaceId,
  participants = [],
  disabled = false,
  placeholder = "Type a message...",
  resetSignal,
  className,
  editorClassName,
  header,
  submitLabel = "Send",
  renderSubmitButton,
  onSubmit,
}: ChatComposerProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const participantsRef = useRef(participants)
  const attachmentsRef = useRef<PendingAttachment[]>([])
  const submitActionRef = useRef<() => void>(() => {})
  const previousResetSignalRef = useRef<number | string | undefined>(
    resetSignal
  )
  const [attachments, setAttachments] = useState<PendingAttachment[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [dragDepth, setDragDepth] = useState(0)
  const [draftText, setDraftText] = useState("")
  const [mentionedParticipantIds, setMentionedParticipantIds] = useState<
    string[]
  >([])
  const [mentionedActorIds, setMentionedActorIds] = useState<string[]>([])
  const [citedAttachmentIds, setCitedAttachmentIds] = useState<string[]>([])

  useEffect(() => {
    participantsRef.current = participants
  }, [participants])

  useEffect(() => {
    attachmentsRef.current = attachments
  }, [attachments])

  const suggestionRenderer = useMemo(() => createSuggestionRenderer(), [])

  const editor = useEditor(
    {
      extensions: [
        StarterKit.configure({
          heading: false,
          bulletList: false,
          orderedList: false,
          listItem: false,
          blockquote: false,
          codeBlock: false,
          horizontalRule: false,
          dropcursor: false,
          gapcursor: false,
        }),
        Placeholder.configure({
          placeholder,
          emptyEditorClass: "is-editor-empty",
        }),
        ComposerMention.configure({
          deleteTriggerWithBackspace: true,
          HTMLAttributes: {
            class:
              "inline-flex items-center rounded-full border px-2 py-0.5 text-sm font-medium",
          },
          renderText({ node, suggestion }) {
            const trigger =
              (suggestion?.char as SuggestionTrigger | undefined) ||
              (node.attrs.mentionSuggestionChar as
                | SuggestionTrigger
                | undefined) ||
              "@"
            return `${trigger}${node.attrs.label ?? node.attrs.id}`
          },
          renderHTML({ options, node, suggestion }) {
            const trigger =
              (suggestion?.char as SuggestionTrigger | undefined) ||
              (node.attrs.mentionSuggestionChar as
                | SuggestionTrigger
                | undefined) ||
              "@"
            const targetType =
              (node.attrs.targetType as MentionTargetType | undefined) ||
              (trigger === "#" ? "attachment" : "participant")
            const isAttachment = targetType === "attachment"

            return [
              "span",
              {
                ...options.HTMLAttributes,
                class: cn(
                  options.HTMLAttributes.class,
                  isAttachment
                    ? "border-amber-500/25 bg-amber-500/10 text-amber-800"
                    : "border-primary/20 bg-primary/10 text-primary"
                ),
                "data-mention-kind": targetType,
              },
              `${trigger}${node.attrs.label ?? node.attrs.id}`,
            ]
          },
          suggestions: [
            {
              pluginKey: PARTICIPANT_SUGGESTION_KEY,
              char: "@",
              allowedPrefixes: null,
              items: ({ query }) =>
                filterParticipants(participantsRef.current, query),
              render: suggestionRenderer,
            },
            {
              pluginKey: ATTACHMENT_SUGGESTION_KEY,
              char: "#",
              allowedPrefixes: null,
              shouldShow: () => attachmentsRef.current.length > 0,
              items: ({ query }) =>
                filterAttachments(attachmentsRef.current, query),
              render: suggestionRenderer,
            },
          ],
        }),
        EmojiSuggestionExtension,
      ],
      content: "",
      editorProps: {
        handleKeyDown(view, event) {
          if (event.isComposing) return false
          if (event.key !== "Enter" || event.shiftKey) return false

          const participantSuggestionActive = Boolean(
            PARTICIPANT_SUGGESTION_KEY.getState(view.state)?.active
          )
          const attachmentSuggestionActive = Boolean(
            ATTACHMENT_SUGGESTION_KEY.getState(view.state)?.active
          )
          const emojiSuggestionActive = Boolean(
            EMOJI_SUGGESTION_KEY.getState(view.state)?.active
          )

          if (
            participantSuggestionActive ||
            attachmentSuggestionActive ||
            emojiSuggestionActive
          ) {
            return false
          }

          event.preventDefault()
          submitActionRef.current()
          return true
        },
      },
      immediatelyRender: true,
      onUpdate({ editor: currentEditor }) {
        const nextText = currentEditor.getText({ blockSeparator: "\n" })
        const nextTargets = collectMentionTargets(currentEditor)

        startTransition(() => {
          setDraftText(nextText)
          setMentionedParticipantIds(nextTargets.mentionedParticipantIds)
          setMentionedActorIds(nextTargets.mentionedActorIds)
          setCitedAttachmentIds(nextTargets.citedAttachmentIds)
        })
      },
    },
    [placeholder, suggestionRenderer]
  )

  const hasDraftContent = draftText.trim().length > 0 || attachments.length > 0
  const submitDisabled = disabled || submitting || !hasDraftContent
  const isDragActive = dragDepth > 0
  const totalMentionCount =
    mentionedParticipantIds.length + mentionedActorIds.length

  useEffect(() => {
    if (!editor) return

    if (previousResetSignalRef.current === resetSignal) return

    previousResetSignalRef.current = resetSignal
    editor.commands.clearContent()
    setAttachments([])
    setDraftText("")
    setMentionedParticipantIds([])
    setMentionedActorIds([])
    setCitedAttachmentIds([])
  }, [editor, resetSignal])

  async function uploadPendingAttachments() {
    if (!workspaceId || attachments.length === 0) return []

    const uploads = await Promise.all(
      attachments.map(async (attachment) => {
        const uploaded = await api.uploadFile(workspaceId, attachment.file)
        const mimeType = uploaded.mimeType || attachment.file.type

        return fileRefBlock({
          fileId: uploaded.id,
          storedName: uploaded.storedName || "",
          url: uploaded.url,
          mimeType,
          originalName: uploaded.originalName || attachment.file.name,
          sizeBytes: uploaded.sizeBytes || attachment.file.size,
          category: mimeType.startsWith("image/")
            ? "image"
            : mimeType.startsWith("audio/")
              ? "audio"
              : mimeType.startsWith("video/")
                ? "video"
                : "document",
        })
      })
    )

    return uploads
  }

  function insertTrigger(trigger: SuggestionTrigger) {
    if (!editor || disabled || submitting) return

    editor.chain().focus().insertContent(trigger).run()
  }

  function insertAttachmentCitation(attachmentId: string) {
    if (!editor || disabled || submitting) return

    const attachment = attachmentsRef.current.find(
      (currentAttachment) => currentAttachment.id === attachmentId
    )
    if (!attachment) return

    editor
      .chain()
      .focus()
      .insertContent([
        {
          type: "mention",
          attrs: {
            id: attachment.id,
            label: attachment.file.name,
            mentionSuggestionChar: "#",
            targetType: "attachment",
          },
        },
        {
          type: "text",
          text: " ",
        },
      ])
      .run()
  }

  function removeAttachment(attachmentId: string) {
    setAttachments((currentAttachments) =>
      currentAttachments.filter((attachment) => attachment.id !== attachmentId)
    )

    if (editor) {
      removeAttachmentMentions(editor, attachmentId)
    }
  }

  function addFiles(rawFiles: File[]) {
    if (rawFiles.length === 0) return

    const rejectedNames: string[] = []
    const acceptedAttachments = rawFiles.reduce<PendingAttachment[]>(
      (result, file) => {
        if (file.size > MAX_ATTACHMENT_SIZE_BYTES) {
          rejectedNames.push(file.name)
          return result
        }

        result.push({
          id: createAttachmentId(),
          file,
        })
        return result
      },
      []
    )

    if (acceptedAttachments.length > 0) {
      setAttachments((currentAttachments) => [
        ...currentAttachments,
        ...acceptedAttachments,
      ])
    }

    if (rejectedNames.length > 0) {
      toast.error(`${rejectedNames.join(", ")} exceeds the 25MB upload limit.`)
    }
  }

  async function handleSubmit() {
    if (!editor || submitDisabled) return

    const plainText = editor.getText({ blockSeparator: "\n" }).trim()
    const {
      mentionedParticipantIds: targetParticipantIds,
      mentionedActorIds: targetActorIds,
      citedAttachmentIds,
    } = collectMentionTargets(editor)

    setSubmitting(true)

    try {
      const uploadedBlocks = await uploadPendingAttachments()
      const contentBlocks = buildComposerContentBlocks(editor, uploadedBlocks)

      const submissionResult = await onSubmit({
        plainText,
        contentBlocks,
        targetParticipantIds:
          targetParticipantIds.length > 0 ? targetParticipantIds : undefined,
        targetActorIds: targetActorIds.length > 0 ? targetActorIds : undefined,
        citedAttachmentIds:
          citedAttachmentIds.length > 0 ? citedAttachmentIds : undefined,
      })

      if (submissionResult !== false) {
        editor.commands.clearContent()
        setAttachments([])
        setDraftText("")
        setMentionedParticipantIds([])
        setMentionedActorIds([])
        setCitedAttachmentIds([])
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to send the message."
      toast.error(message)
    } finally {
      setSubmitting(false)
    }
  }

  submitActionRef.current = () => {
    void handleSubmit()
  }

  function handleFileInputChange(event: React.ChangeEvent<HTMLInputElement>) {
    addFiles(Array.from(event.target.files || []))
    event.target.value = ""
  }

  function handleDragEnter(event: React.DragEvent<HTMLFormElement>) {
    if (!Array.from(event.dataTransfer.types || []).includes("Files")) return
    event.preventDefault()
    setDragDepth((currentDepth) => currentDepth + 1)
  }

  function handleDragLeave(event: React.DragEvent<HTMLFormElement>) {
    if (!Array.from(event.dataTransfer.types || []).includes("Files")) return
    event.preventDefault()
    setDragDepth((currentDepth) => Math.max(0, currentDepth - 1))
  }

  function handleDragOver(event: React.DragEvent<HTMLFormElement>) {
    if (!Array.from(event.dataTransfer.types || []).includes("Files")) return
    event.preventDefault()
  }

  function handleDrop(event: React.DragEvent<HTMLFormElement>) {
    if (!Array.from(event.dataTransfer.types || []).includes("Files")) return
    event.preventDefault()
    setDragDepth(0)

    if (disabled || submitting) return

    addFiles(Array.from(event.dataTransfer.files || []))
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        void handleSubmit()
      }}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      className={cn(
        "relative overflow-hidden rounded-3xl border border-border bg-background shadow-sm transition-colors focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/40",
        disabled && "cursor-not-allowed opacity-70",
        className
      )}
    >
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={CHAT_ATTACHMENT_ACCEPT}
        className="hidden"
        onChange={handleFileInputChange}
      />

      {header ? <div className="px-5 pt-4">{header}</div> : null}

      {attachments.length > 0 ? (
        <div className="flex flex-wrap gap-2 border-b border-border/70 px-4 py-3">
          {attachments.map((attachment) => {
            const cited = citedAttachmentIds.includes(attachment.id)

            return (
              <button
                key={attachment.id}
                type="button"
                onClick={() => insertAttachmentCitation(attachment.id)}
                className={cn(
                  "inline-flex items-center gap-2 rounded-2xl border px-3 py-1.5 text-left text-xs shadow-sm transition-colors",
                  cited
                    ? "border-amber-500/30 bg-amber-500/10 text-amber-800"
                    : "border-border bg-background text-muted-foreground hover:border-amber-500/30 hover:bg-amber-500/5"
                )}
              >
                <Paperclip className="size-3.5 shrink-0" />
                <span className="max-w-[14rem] truncate font-medium">
                  {attachment.file.name}
                </span>
                <span className="text-muted-foreground/70">
                  {formatFileSize(attachment.file.size)}
                </span>
                <span className="hidden text-[11px] sm:inline">
                  {cited ? "Cited" : "Click to cite"}
                </span>
                <span
                  onClick={(event) => {
                    event.stopPropagation()
                    removeAttachment(attachment.id)
                  }}
                  className="inline-flex cursor-pointer items-center text-muted-foreground/70 transition-colors hover:text-foreground"
                  role="button"
                  aria-label={`Remove ${attachment.file.name}`}
                >
                  <X className="size-3.5" />
                </span>
              </button>
            )
          })}
        </div>
      ) : null}

      <div className="relative">
        <EditorContent
          editor={editor}
          className={cn(
            "chat-composer-editor text-sm",
            "[&_.ProseMirror]:min-h-28 [&_.ProseMirror]:w-full [&_.ProseMirror]:px-4 [&_.ProseMirror]:py-3 [&_.ProseMirror]:text-sm [&_.ProseMirror]:leading-6 [&_.ProseMirror]:[overflow-wrap:anywhere] [&_.ProseMirror]:text-foreground [&_.ProseMirror]:outline-none",
            "[&_.ProseMirror_p+ p]:mt-2 [&_.ProseMirror_p]:my-0",
            editorClassName
          )}
        />

        {isDragActive ? (
          <div className="pointer-events-none absolute inset-3 flex items-center justify-center rounded-[1.5rem] border border-dashed border-primary/45 bg-primary/6 text-sm font-medium text-primary">
            Drop files to attach them
          </div>
        ) : null}
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-border/70 px-3 py-2">
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="rounded-full text-muted-foreground"
            onClick={() => insertTrigger("@")}
            disabled={disabled || submitting || participants.length === 0}
            aria-label="Mention a participant"
          >
            <AtSign className="size-4.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="rounded-full text-muted-foreground"
            onClick={() => {
              if (attachments.length === 1) {
                insertAttachmentCitation(attachments[0].id)
                return
              }

              insertTrigger("#")
            }}
            disabled={disabled || submitting || attachments.length === 0}
            aria-label="Cite an attachment"
          >
            <Hash className="size-4.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="rounded-full text-muted-foreground"
            onClick={() => insertTrigger(":")}
            disabled={disabled || submitting}
            aria-label="Insert an emoji"
          >
            <SmilePlus className="size-4.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="rounded-full text-muted-foreground"
            onClick={() => fileInputRef.current?.click()}
            disabled={disabled || submitting}
            aria-label="Attach files"
          >
            <Paperclip className="size-4.5" />
          </Button>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {totalMentionCount > 0 ? (
            <span className="hidden text-xs text-muted-foreground sm:inline">
              {totalMentionCount} mention
              {totalMentionCount > 1 ? "s" : ""}
            </span>
          ) : null}

          {renderSubmitButton ? (
            renderSubmitButton({
              disabled: submitDisabled,
              submitting,
              label: submitLabel,
            })
          ) : (
            <Button
              type="submit"
              size="sm"
              disabled={submitDisabled}
              className="min-w-[104px] rounded-full shadow-sm"
            >
              {submitting ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  <span>Sending</span>
                </>
              ) : (
                <>
                  <span>{submitLabel}</span>
                  <Send className="size-4" />
                </>
              )}
            </Button>
          )}
        </div>
      </div>
    </form>
  )
}
