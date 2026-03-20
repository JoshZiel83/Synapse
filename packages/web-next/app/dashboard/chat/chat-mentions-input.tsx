'use client';

import { useMemo } from 'react';
import { Mention, MentionsInput, type MentionItem, type MentionsInputStyle } from 'react-mentions';
import ChatAvatar from './chat-avatar';

export type MentionableActor = {
  id: string;
  name: string;
  role?: string;
  avatarUrl?: string;
  emoji?: string;
};

type ActorSuggestion = {
  id: string;
  display: string;
  role?: string;
  avatarUrl?: string;
  emoji?: string;
};

const mentionInputStyle: MentionsInputStyle = {
  control: {
    fontSize: 14,
    fontWeight: 400,
  },
  '&multiLine': {
    control: {
      minHeight: 88,
      position: 'relative',
    },
    highlighter: {
      minHeight: 88,
      padding: '12px 16px',
      border: 0,
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
    },
    input: {
      minHeight: 88,
      padding: '12px 16px',
      border: 0,
      outline: 0,
      backgroundColor: 'transparent',
      color: 'var(--foreground)',
      caretColor: 'var(--foreground)',
      whiteSpace: 'pre-wrap',
      overflow: 'auto',
      lineHeight: '1.5rem',
    },
  },
  suggestions: {
    zIndex: 80,
    list: {
      width: 288,
      overflow: 'hidden',
      border: '1px solid var(--border)',
      borderRadius: 22,
      backgroundColor: 'var(--background)',
      boxShadow: '0 18px 40px rgba(15, 23, 42, 0.12)',
    },
    item: {
      padding: '8px 12px',
      backgroundColor: 'var(--background)',
      '&focused': {
        backgroundColor: 'rgba(99, 102, 241, 0.08)',
      },
    },
  },
};

function getMentionMatch(value: string, caret: number) {
  const prefix = value.slice(0, caret);
  const match = prefix.match(/(?:^|\s)@([^\s@]*)$/);
  if (!match) return null;
  return {
    start: prefix.lastIndexOf('@'),
    query: match[1] || '',
  };
}

interface ChatMentionsInputProps {
  actors: MentionableActor[];
  value: string;
  plainTextValue: string;
  disabled?: boolean;
  inputRef?: React.Ref<HTMLTextAreaElement>;
  onChange: (nextValue: string, nextPlainTextValue: string, mentionedActorIds: string[]) => void;
  onSubmit: () => void;
}

export default function ChatMentionsInput({
  actors,
  value,
  plainTextValue,
  disabled,
  inputRef,
  onChange,
  onSubmit,
}: ChatMentionsInputProps) {
  const portalHost = typeof document === 'undefined' ? undefined : document.body;

  const suggestions = useMemo<ActorSuggestion[]>(
    () => actors.map((actor) => ({
      id: actor.id,
      display: actor.name,
      role: actor.role,
      avatarUrl: actor.avatarUrl,
      emoji: actor.emoji,
    })),
    [actors],
  );

  return (
    <MentionsInput
        value={value}
        onChange={(_event, nextValue, nextPlainTextValue, mentions) => {
          const mentionedActorIds = Array.from(
            new Set(mentions.map((mention: MentionItem) => String(mention.id))),
          );
          onChange(nextValue, nextPlainTextValue, mentionedActorIds);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key !== 'Enter' || event.shiftKey) return;

          const textarea = event.currentTarget;
          const caret = textarea.selectionStart ?? plainTextValue.length;
          const activeMention = getMentionMatch(plainTextValue, caret);
          if (activeMention) return;

          event.preventDefault();
          onSubmit();
        }}
        allowSuggestionsAboveCursor
        suggestionsPortalHost={portalHost}
        inputRef={inputRef}
        placeholder="Type a message..."
        disabled={disabled}
        a11ySuggestionsListLabel="Actor suggestions"
        style={mentionInputStyle}
        className="text-sm"
      >
        <Mention
          trigger="@"
          data={suggestions}
          markup="@[__display__](__id__)"
          appendSpaceOnAdd
          displayTransform={(_id, display) => `@${display}`}
          renderSuggestion={(entry, _search, _highlightedDisplay, _index, focused) => {
            const actor = entry as ActorSuggestion;
            return (
              <div
                className={`flex items-center gap-2 ${focused ? 'text-primary' : 'text-foreground'}`}
              >
                <ChatAvatar
                  name={actor.display}
                  avatarUrl={actor.avatarUrl}
                  emoji={actor.emoji}
                  entityType="actor"
                  size="sm"
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{actor.display}</div>
                  {actor.role ? (
                    <div className="truncate text-[11px] text-muted-foreground">{actor.role}</div>
                  ) : null}
                </div>
              </div>
            );
          }}
        />
      </MentionsInput>
  );
}
