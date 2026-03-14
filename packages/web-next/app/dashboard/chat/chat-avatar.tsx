'use client';

import { Avatar, AvatarBadge, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { resolveFileUrl } from '@/lib/utils';
import { getTwemojiUrl } from '@/lib/twemoji';
import { cn } from '@/lib/utils';
import type { ThinkingPhase } from '@/stores/chat-store';

const STATUS_EMOJI: Record<ThinkingPhase, string> = {
  thinking: '🤔',
  tool: '🛠️',
  error: '⚠️',
};

function getInitial(name: string | undefined) {
  const value = name?.trim();
  return value ? value.charAt(0).toUpperCase() : '?';
}

interface ChatAvatarProps {
  name?: string;
  avatarUrl?: string;
  emoji?: string;
  entityType?: 'group' | 'user' | 'actor';
  size?: 'sm' | 'default' | 'lg';
  statusPhase?: ThinkingPhase;
  className?: string;
}

export default function ChatAvatar({
  name,
  avatarUrl,
  emoji,
  entityType = 'actor',
  size = 'default',
  statusPhase,
  className,
}: ChatAvatarProps) {
  const resolvedAvatarUrl = resolveFileUrl(avatarUrl);
  const emojiUrl = !resolvedAvatarUrl && entityType === 'actor' ? getTwemojiUrl(emoji) : null;
  const badgeEmojiUrl = statusPhase ? getTwemojiUrl(STATUS_EMOJI[statusPhase]) : null;

  return (
    <Avatar size={size} className={cn(className)}>
      {resolvedAvatarUrl ? (
        <AvatarImage src={resolvedAvatarUrl} alt={name || entityType} />
      ) : emojiUrl ? (
        <AvatarImage src={emojiUrl} alt={name || entityType} className="bg-muted p-1" />
      ) : null}
      <AvatarFallback>{getInitial(name)}</AvatarFallback>
      {entityType === 'actor' && statusPhase ? (
        <AvatarBadge
          className={cn(
            'bg-background p-0.5 shadow-sm ring-1 ring-border',
            size === 'sm' && 'size-4',
            size === 'default' && 'size-5',
            size === 'lg' && 'size-6',
          )}
        >
          {badgeEmojiUrl ? (
            <img src={badgeEmojiUrl} alt={statusPhase} className="size-full" />
          ) : null}
        </AvatarBadge>
      ) : null}
    </Avatar>
  );
}
