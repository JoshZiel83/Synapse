'use client';

import { Avatar, AvatarBadge, AvatarFallback, AvatarGroup, AvatarGroupCount, AvatarImage } from '@/components/ui/avatar';
import { getTwemojiUrl } from '@/lib/twemoji';
import { cn } from '@/lib/utils';
import type { ConversationParticipant, ThinkingPhase } from '@/stores/chat-store';

const STATUS_EMOJI: Record<ThinkingPhase | 'idle', string> = {
  thinking: '🤔',
  tool: '🛠️',
  responding: '💬',
  error: '⚠️',
  idle: '😴',
};

function getInitials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0] || ''}${parts[1]![0] || ''}`.toUpperCase();
}

function moveActiveActorToFront(participants: ConversationParticipant[], activeActorId?: string) {
  if (!activeActorId) return participants;

  const activeIndex = participants.findIndex((participant) => participant.id === activeActorId);
  if (activeIndex <= 0) return participants;

  const activeParticipant = participants[activeIndex]!;
  return [
    activeParticipant,
    ...participants.slice(0, activeIndex),
    ...participants.slice(activeIndex + 1),
  ];
}

interface ConversationAvatarGroupProps {
  participants: ConversationParticipant[];
  activeActorId?: string;
  activePhase?: ThinkingPhase;
  className?: string;
  max?: number;
  size?: 'sm' | 'default' | 'lg';
}

export default function ConversationAvatarGroup({
  participants,
  activeActorId,
  activePhase,
  className,
  max = 3,
  size = 'default',
}: ConversationAvatarGroupProps) {
  const orderedParticipants = moveActiveActorToFront(participants, activeActorId);
  const visibleParticipants = orderedParticipants.slice(0, max);
  const overflowCount = Math.max(orderedParticipants.length - visibleParticipants.length, 0);

  if (orderedParticipants.length === 0) {
    return (
      <AvatarGroup className={className}>
        <Avatar size={size}>
          <AvatarFallback>?</AvatarFallback>
          <AvatarBadge className="size-4 bg-background p-0.5 shadow-sm ring-1 ring-border">
            <img src={getTwemojiUrl(STATUS_EMOJI.idle) || undefined} alt="Idle" className="size-full" />
          </AvatarBadge>
        </Avatar>
      </AvatarGroup>
    );
  }

  return (
    <AvatarGroup className={cn('items-center', className)}>
      {visibleParticipants.map((participant) => {
        const avatarSrc = getTwemojiUrl(participant.emoji);
        const phase = participant.id === activeActorId ? activePhase || 'thinking' : 'idle';
        const badgeEmoji = STATUS_EMOJI[phase];
        const badgeSrc = getTwemojiUrl(badgeEmoji);

        return (
          <Avatar key={participant.id} size={size}>
            {avatarSrc ? (
              <AvatarImage src={avatarSrc} alt={participant.name} className="bg-muted/30 p-1" />
            ) : null}
            <AvatarFallback className="bg-gradient-to-br from-emerald-500/15 via-teal-500/10 to-cyan-500/15 font-medium text-foreground">
              {getInitials(participant.name)}
            </AvatarFallback>
            <AvatarBadge
              className={cn(
                'size-4 bg-background p-0.5 shadow-sm ring-1 ring-border',
                size === 'sm' && 'size-3.5',
                size === 'lg' && 'size-4.5',
              )}
            >
              {badgeSrc ? (
                <img src={badgeSrc} alt={phase} className="size-full" />
              ) : (
                <span className="text-[10px] leading-none">{badgeEmoji}</span>
              )}
            </AvatarBadge>
          </Avatar>
        );
      })}
      {overflowCount > 0 ? <AvatarGroupCount>+{overflowCount}</AvatarGroupCount> : null}
    </AvatarGroup>
  );
}
