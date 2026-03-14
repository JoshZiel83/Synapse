'use client';

import type { ActorRuntimeState } from '@synapse/shared';
import { AvatarGroup, AvatarGroupCount } from '@/components/ui/avatar';
import { cn } from '@/lib/utils';
import { PlusIcon } from 'lucide-react';
import { runtimeToAvatarStatus } from '@/stores/chat-store';
import type { GroupMember } from '@/stores/chat-store';
import ChatAvatar from './chat-avatar';

function getRuntimePriority(runtime?: ActorRuntimeState) {
  if (!runtime) return 3;
  if (runtime.health === 'error' || runtime.laneState === 'blocked') return 0;
  if (runtime.laneState === 'running') return 1;
  if (runtime.laneState === 'queued') return 2;
  return 3;
}

function orderMembers(members: GroupMember[], runtimeByActor?: Record<string, ActorRuntimeState>) {
  return [...members].sort((left, right) => {
    if (left.type !== 'actor' || right.type !== 'actor') {
      if (left.type === right.type) return 0;
      return left.type === 'actor' ? -1 : 1;
    }

    return getRuntimePriority(runtimeByActor?.[left.id]) - getRuntimePriority(runtimeByActor?.[right.id]);
  });
}

function getRuntimeLabel(runtime?: ActorRuntimeState) {
  if (!runtime) return undefined;
  if (runtime.health === 'error' || runtime.laneState === 'blocked') return 'Error';
  if (runtime.laneState === 'running') return 'Working';
  if (runtime.laneState === 'queued') return 'Queued';
  return 'Idle';
}

function getRuntimeDetail(runtime?: ActorRuntimeState) {
  if (!runtime) return undefined;
  if (runtime.lastError?.message) return runtime.lastError.message;
  if (runtime.laneState === 'running' && runtime.activeWakeups.some((wakeup) => wakeup.status === 'attached')) {
    return runtime.activeWakeups
      .filter((wakeup) => wakeup.status === 'attached')
      .slice(0, 2)
      .map((wakeup) => wakeup.sourceName || wakeup.sourceType.replace(/_/g, ' '))
      .join(', ');
  }
  if (runtime.statusText) return runtime.statusText;
  if (runtime.pendingWakeupCount > 0) {
    return `${runtime.pendingWakeupCount} queued wakeup${runtime.pendingWakeupCount === 1 ? '' : 's'}`;
  }
  return undefined;
}

interface ChatMemberStripProps {
  members: GroupMember[];
  runtimeByActor?: Record<string, ActorRuntimeState>;
  max?: number;
  size?: 'sm' | 'default' | 'lg';
  className?: string;
  onAdd?: () => void;
}

export default function ChatMemberStrip({
  members,
  runtimeByActor,
  max = 5,
  size = 'default',
  className,
  onAdd,
}: ChatMemberStripProps) {
  const orderedMembers = orderMembers(members, runtimeByActor);
  const visibleMembers = orderedMembers.slice(0, max);
  const overflowCount = Math.max(orderedMembers.length - visibleMembers.length, 0);

  return (
    <AvatarGroup className={cn('items-center', className)}>
      {visibleMembers.map((member) => {
        const runtime = member.type === 'actor' ? runtimeByActor?.[member.id] : undefined;
        return (
          <ChatAvatar
            key={`${member.type}-${member.id}`}
            name={member.name}
            avatarUrl={member.avatarUrl}
            emoji={member.emoji}
            entityType={member.type}
            size={size}
            statusState={runtimeToAvatarStatus(runtime)}
            statusLabel={getRuntimeLabel(runtime)}
            statusDetail={getRuntimeDetail(runtime)}
          />
        );
      })}
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
