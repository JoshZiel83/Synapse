'use client';

import { useState } from 'react';
import { APP_NAME, type ActorRuntimeState } from '@synapse/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { Plus, Search } from 'lucide-react';
import ChatAvatar from './chat-avatar';
import TransportKindIcon from './transport-kind-icon';
import type { Group, GroupRuntimeMap } from '@/stores/chat-store';

function formatRelativeTime(dateStr: string) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(dateStr).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

interface GroupListProps {
  groups: Group[];
  selectedId: string | null;
  runtimeMap: GroupRuntimeMap;
  onSelect: (id: string) => void;
  onNewConversation: () => void;
  className?: string;
  headerVariant?: 'default' | 'mobile';
  title?: string;
  loading?: boolean;
}

function getRuntimePriority(runtime: ActorRuntimeState) {
  if (runtime.health === 'error' || runtime.laneState === 'blocked') return 0;
  if (runtime.laneState === 'running') return 1;
  if (runtime.laneState === 'queued') return 2;
  return 3;
}

function summarizeRuntimePreview(runtimeByActor?: Record<string, ActorRuntimeState>) {
  const activeRuntimes = Object.values(runtimeByActor || {})
    .filter((runtime) => runtime.laneState !== 'idle' && runtime.laneState !== 'closed')
    .sort((left, right) => getRuntimePriority(left) - getRuntimePriority(right));

  if (activeRuntimes.length === 0) return null;

  const names = activeRuntimes.map((runtime) => runtime.actorName);
  const lead = names.slice(0, 2).join(', ');
  const suffix = names.length > 2 ? ` +${names.length - 2}` : '';
  const blocked = activeRuntimes.find((runtime) => runtime.health === 'error' || runtime.laneState === 'blocked');
  if (blocked) {
    return `${lead}${suffix} · ${blocked.lastError?.message || 'Needs attention'}`;
  }

  const wakeupCount = activeRuntimes.reduce(
    (sum, runtime) => sum + Math.max(runtime.activeWakeups.length, runtime.pendingWakeupCount),
    0,
  );
  const statusText = activeRuntimes[0]?.statusText;
  if (statusText) {
    return `${lead}${suffix} · ${statusText}`;
  }
  if (wakeupCount > 0) {
    return `${lead}${suffix} · handling ${wakeupCount} wakeup${wakeupCount === 1 ? '' : 's'}`;
  }
  return `${lead}${suffix} · working`;
}

function GroupListSkeletonRows({ isMobileHeader }: { isMobileHeader: boolean }) {
  return (
    <div className="divide-y divide-border/70">
      {Array.from({ length: isMobileHeader ? 6 : 8 }, (_, index) => (
        <div key={index} className="flex items-center gap-3 px-4 py-3">
          <Skeleton className="size-11 shrink-0 rounded-2xl" />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <div className="flex items-center justify-between gap-3">
              <Skeleton
                className={cn(
                  'h-4 rounded-full',
                  index % 3 === 0 ? 'w-28' : index % 3 === 1 ? 'w-36' : 'w-24',
                )}
              />
              <Skeleton className="h-3 w-10 shrink-0 rounded-full" />
            </div>
            <Skeleton
              className={cn(
                'h-3.5 rounded-full',
                index % 2 === 0 ? 'w-full max-w-[15rem]' : 'w-[72%]',
              )}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

export default function GroupList({
  groups,
  selectedId,
  runtimeMap,
  onSelect,
  onNewConversation,
  className,
  headerVariant = 'default',
  title,
  loading = false,
}: GroupListProps) {
  const [search, setSearch] = useState('');
  const headerTitle = title || (headerVariant === 'mobile' ? APP_NAME : 'Messages');
  const isMobileHeader = headerVariant === 'mobile';

  const filtered = search
    ? groups.filter((g) => {
        const s = search.toLowerCase();
        return (
          g.title?.toLowerCase().includes(s) ||
          g.participants.some((p) => p.name.toLowerCase().includes(s)) ||
          g.lastMessage?.content.toLowerCase().includes(s)
        );
      })
    : groups;

  return (
    <div className={cn("flex h-full min-h-0 flex-col border-r border-border bg-muted/20", className)}>
      {/* Header */}
      <div
        className={cn(
          'border-b border-border px-4',
          isMobileHeader
            ? 'pb-4 pt-[calc(env(safe-area-inset-top)+1rem)]'
            : 'py-4',
        )}
      >
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2
            className={cn(
              'tracking-tight text-foreground',
              isMobileHeader ? 'text-2xl font-semibold' : 'text-lg font-semibold',
            )}
          >
            {headerTitle}
          </h2>
          <Button
            variant="ghost"
            size="icon"
            className={cn(
              'shrink-0 rounded-full text-muted-foreground hover:bg-accent hover:text-accent-foreground',
              isMobileHeader ? 'size-8' : 'size-8',
            )}
            onClick={onNewConversation}
            title="New Conversation"
          >
            <Plus className={cn(isMobileHeader ? 'size-6' : 'size-5')} />
          </Button>
        </div>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 dark:text-gray-500" />
          <Input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search conversations..."
            className="pl-9"
          />
        </div>
      </div>

      {/* Group List */}
      <div
        className={cn(
          'min-h-0 flex-1 overflow-y-auto',
          isMobileHeader && 'pb-[calc(var(--mobile-tab-bar-clearance,0px)+1rem)]',
        )}
      >
        {loading ? (
          <GroupListSkeletonRows isMobileHeader={isMobileHeader} />
        ) : filtered.map((group) => {
          const isSelected = group.id === selectedId;
          const runtimePreview = summarizeRuntimePreview(runtimeMap[group.id]);
          const name = group.title || group.participants.map((p) => p.name).join(', ');

          const preview = group.lastMessage
            ? `${group.lastMessage.role === 'user' ? 'You' : group.lastMessage.actorName || 'Actor'}: ${group.lastMessage.content}`
            : '';
          const previewTrunc = preview.length > 50 ? preview.substring(0, 50) + '...' : preview;

          const timeStr = group.lastMessage?.createdAt || group.createdAt;

          return (
            <button
              key={group.id}
              onClick={() => onSelect(group.id)}
              className={`
                relative w-full px-4 py-3 text-left transition-colors
                ${isSelected
                  ? 'bg-accent'
                  : 'hover:bg-accent/70'
                }
              `}
            >
              {isSelected && (
                <div className="absolute left-0 top-1/2 h-8 w-1 -translate-y-1/2 rounded-r-full bg-primary" />
              )}

              <div className="flex items-center gap-3">
                {/* Avatar */}
                <div className="relative shrink-0">
                  <ChatAvatar
                    name={name}
                    avatarUrl={group.avatarUrl}
                    entityType="group"
                    size="lg"
                  />
                  <TransportKindIcon
                    kind={group.transportKind}
                    size={14}
                    className="absolute -bottom-1 -right-1 size-5 p-0.5"
                  />
                  {group.unreadCount > 0 && (
                    <span className="absolute -top-1 -right-1 flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-[10px] font-bold">
                      {group.unreadCount > 99 ? '99+' : group.unreadCount}
                    </span>
                  )}
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <span className={`text-sm font-semibold truncate ${
                      isSelected ? 'text-primary' : 'text-foreground'
                    }`}>{name}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {formatRelativeTime(timeStr)}
                    </span>
                  </div>
                  <p className="mt-0.5 truncate text-sm text-muted-foreground">
                    {runtimePreview || previewTrunc || 'No messages yet'}
                  </p>
                </div>
              </div>
            </button>
          );
        })}

        {!loading && filtered.length === 0 && (
          <div className="py-8 text-center">
            <p className="text-xs text-muted-foreground">
              {search ? 'No conversations match your search' : 'No conversations yet'}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
