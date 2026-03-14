'use client';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Avatar, AvatarBadge, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { resolveFileUrl } from '@/lib/utils';
import { getTwemojiUrl } from '@/lib/twemoji';
import { cn } from '@/lib/utils';
import type { ActorAvatarStatus, ThinkingPhase } from '@/stores/chat-store';

const STATUS_DOT_CLASS: Record<ActorAvatarStatus, string> = {
  idle: 'bg-muted-foreground/50',
  thinking: 'bg-sky-500',
  tool: 'bg-amber-500',
  responding: 'bg-emerald-500',
  error: 'bg-destructive',
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
  statusState?: ActorAvatarStatus;
  statusPhase?: ThinkingPhase;
  statusLabel?: string;
  statusDetail?: string;
  className?: string;
}

export default function ChatAvatar({
  name,
  avatarUrl,
  emoji,
  entityType = 'actor',
  size = 'default',
  statusState,
  statusPhase,
  statusLabel,
  statusDetail,
  className,
}: ChatAvatarProps) {
  const resolvedAvatarUrl = resolveFileUrl(avatarUrl);
  const emojiUrl = !resolvedAvatarUrl && entityType === 'actor' ? getTwemojiUrl(emoji) : null;
  const badgeState = statusState || statusPhase;
  const avatar = (
    <Avatar size={size} className={cn(className)}>
      {resolvedAvatarUrl ? (
        <AvatarImage src={resolvedAvatarUrl} alt={name || entityType} />
      ) : emojiUrl ? (
        <AvatarImage src={emojiUrl} alt={name || entityType} className="bg-muted p-1" />
      ) : null}
      <AvatarFallback>{getInitial(name)}</AvatarFallback>
      {entityType === 'actor' && badgeState ? (
        <AvatarBadge className={cn('shadow-sm ring-2 ring-background', STATUS_DOT_CLASS[badgeState])} />
      ) : null}
    </Avatar>
  );

  if (entityType !== 'actor' || !badgeState || (!statusLabel && !statusDetail && !name)) {
    return avatar;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>{avatar}</TooltipTrigger>
      <TooltipContent side="top" className="flex max-w-60 flex-col items-start gap-0.5">
        <span className="font-medium">{name || 'Actor'}</span>
        {statusLabel ? <span>{statusLabel}</span> : null}
        {statusDetail ? <span className="text-background/80">{statusDetail}</span> : null}
      </TooltipContent>
    </Tooltip>
  );
}
