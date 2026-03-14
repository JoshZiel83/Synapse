'use client';

import { AvatarGroup, AvatarGroupCount } from '@/components/ui/avatar';
import { cn } from '@/lib/utils';
import { PlusIcon } from 'lucide-react';
import type { GroupMember, ThinkingPhase } from '@/stores/chat-store';
import ChatAvatar from './chat-avatar';

function moveActiveActorToFront(members: GroupMember[], activeActorId?: string) {
  if (!activeActorId) return members;
  const index = members.findIndex((member) => member.type === 'actor' && member.id === activeActorId);
  if (index <= 0) return members;

  const activeMember = members[index]!;
  return [
    activeMember,
    ...members.slice(0, index),
    ...members.slice(index + 1),
  ];
}

interface ChatMemberStripProps {
  members: GroupMember[];
  activeActorId?: string;
  activePhase?: ThinkingPhase;
  max?: number;
  size?: 'sm' | 'default' | 'lg';
  className?: string;
  onAdd?: () => void;
}

export default function ChatMemberStrip({
  members,
  activeActorId,
  activePhase,
  max = 5,
  size = 'default',
  className,
  onAdd,
}: ChatMemberStripProps) {
  const orderedMembers = moveActiveActorToFront(members, activeActorId);
  const visibleMembers = orderedMembers.slice(0, max);
  const overflowCount = Math.max(orderedMembers.length - visibleMembers.length, 0);

  return (
    <AvatarGroup className={cn('items-center', className)}>
      {visibleMembers.map((member) => (
        <ChatAvatar
          key={`${member.type}-${member.id}`}
          name={member.name}
          avatarUrl={member.avatarUrl}
          emoji={member.emoji}
          entityType={member.type}
          size={size}
          statusPhase={member.type === 'actor' && member.id === activeActorId ? activePhase : undefined}
        />
      ))}
      {onAdd ? (
        <AvatarGroupCount
          role="button"
          tabIndex={0}
          onClick={onAdd}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              onAdd();
            }
          }}
          className="cursor-pointer"
          aria-label="Add members"
        >
          <PlusIcon />
        </AvatarGroupCount>
      ) : overflowCount > 0 ? (
        <AvatarGroupCount>+{overflowCount}</AvatarGroupCount>
      ) : null}
    </AvatarGroup>
  );
}
