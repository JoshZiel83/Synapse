"use client"

import { useMemo } from "react"
import {
  Mention,
  MentionsInput,
  type MentionItem,
  type MentionsInputStyle,
} from "react-mentions"
import ChatAvatar from "./chat-avatar"

export type MentionableParticipant = {
  id: string
  name: string
  type: "actor" | "remote_agent" | "workspace_member" | "external"
  role?: string
  avatarUrl?: string
  emoji?: string
  description?: string
  searchTerms?: string[]
}

type ParticipantSuggestion = {
  id: string
  display: string
  type: "actor" | "remote_agent" | "workspace_member" | "external"
  role?: string
  avatarUrl?: string
  emoji?: string
  description?: string
  searchTerms: string[]
}

const mentionInputStyle: MentionsInputStyle = {
  control: {
    fontSize: 14,
    fontWeight: 400,
  },
  "&multiLine": {
    control: {
      minHeight: 88,
      position: "relative",
    },
    highlighter: {
      minHeight: 88,
      padding: "12px 16px",
      border: 0,
      whiteSpace: "pre-wrap",
      wordBreak: "break-word",
    },
    input: {
      minHeight: 88,
      padding: "12px 16px",
      border: 0,
      outline: 0,
      backgroundColor: "transparent",
      color: "var(--foreground)",
      caretColor: "var(--foreground)",
      whiteSpace: "pre-wrap",
      overflow: "auto",
      lineHeight: "1.5rem",
    },
  },
  suggestions: {
    zIndex: 80,
    list: {
      width: 288,
      overflow: "hidden",
      border: "1px solid var(--border)",
      borderRadius: 22,
      backgroundColor: "var(--background)",
      boxShadow: "0 18px 40px rgba(15, 23, 42, 0.12)",
    },
    item: {
      padding: "8px 12px",
      backgroundColor: "var(--background)",
      "&focused": {
        backgroundColor: "rgba(99, 102, 241, 0.08)",
      },
    },
  },
}

function getMentionMatch(value: string, caret: number) {
  const prefix = value.slice(0, caret)
  const match = prefix.match(/(?:^|\s)@([^\s@]*)$/)
  if (!match) return null
  return {
    start: prefix.lastIndexOf("@"),
    query: match[1] || "",
  }
}

interface ChatMentionsInputProps {
  participants: MentionableParticipant[]
  value: string
  plainTextValue: string
  disabled?: boolean
  inputRef?: React.Ref<HTMLTextAreaElement>
  onChange: (
    nextValue: string,
    nextPlainTextValue: string,
    mentionedParticipantIds: string[]
  ) => void
  onSubmit: () => void
}

export default function ChatMentionsInput({
  participants,
  value,
  plainTextValue,
  disabled,
  inputRef,
  onChange,
  onSubmit,
}: ChatMentionsInputProps) {
  const portalHost = typeof document === "undefined" ? undefined : document.body

  const suggestions = useMemo<ParticipantSuggestion[]>(
    () =>
      participants.map((participant) => ({
        id: participant.id,
        display: participant.name,
        type: participant.type,
        role: participant.role,
        avatarUrl: participant.avatarUrl,
        emoji: participant.emoji,
        description: participant.description,
        searchTerms: participant.searchTerms || [],
      })),
    [participants]
  )

  return (
    <MentionsInput
      value={value}
      onChange={(_event, nextValue, nextPlainTextValue, mentions) => {
        const mentionedParticipantIds = Array.from(
          new Set(mentions.map((mention: MentionItem) => String(mention.id)))
        )
        onChange(nextValue, nextPlainTextValue, mentionedParticipantIds)
      }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return
        if (event.key !== "Enter" || event.shiftKey) return

        const textarea = event.currentTarget
        const caret = textarea.selectionStart ?? plainTextValue.length
        const activeMention = getMentionMatch(plainTextValue, caret)
        if (activeMention) return

        event.preventDefault()
        onSubmit()
      }}
      allowSuggestionsAboveCursor
      suggestionsPortalHost={portalHost}
      inputRef={inputRef}
      placeholder="Type a message..."
      disabled={disabled}
      a11ySuggestionsListLabel="Participant suggestions"
      style={mentionInputStyle}
      className="text-sm"
    >
      <Mention
        trigger="@"
        data={(search, callback) => {
          const normalizedSearch = search.trim().toLowerCase()
          const visibleSuggestions = suggestions.filter((participant) => {
            if (!normalizedSearch) return true
            const haystack = [
              participant.display,
              participant.description || "",
              ...participant.searchTerms,
            ]
              .join(" ")
              .toLowerCase()
            return haystack.includes(normalizedSearch)
          })
          callback(visibleSuggestions)
        }}
        markup="@[__display__](__id__)"
        appendSpaceOnAdd
        displayTransform={(_id, display) => `@${display}`}
        renderSuggestion={(
          entry,
          _search,
          _highlightedDisplay,
          _index,
          focused
        ) => {
          const participant = entry as ParticipantSuggestion
          return (
            <div
              className={`flex items-center gap-2 ${focused ? "text-primary" : "text-foreground"}`}
            >
              <ChatAvatar
                name={participant.display}
                avatarUrl={participant.avatarUrl}
                emoji={participant.emoji}
                entityType={participant.type}
                size="sm"
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">
                  {participant.display}
                </div>
                <div className="truncate text-[11px] text-muted-foreground">
                  {participant.description ||
                    (participant.type === "actor"
                      ? participant.role || "Actor"
                      : participant.type === "remote_agent"
                        ? participant.role || "Remote agent"
                        : participant.type === "external"
                          ? "External participant"
                          : "Workspace user")}
                </div>
              </div>
            </div>
          )
        }}
      />
    </MentionsInput>
  )
}
