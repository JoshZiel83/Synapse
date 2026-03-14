'use client';

import { useState } from 'react';
import type { ActorRuntimeState } from '@synapse/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Plus, Search } from 'lucide-react';
import ChatAvatar from './chat-avatar';
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

export default function GroupList({ groups, selectedId, runtimeMap, onSelect, onNewConversation }: GroupListProps) {
  const [search, setSearch] = useState('');

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
    <div className="flex h-full min-h-0 flex-col border-r border-border bg-muted/20">
      {/* Header */}
      <div className="border-b border-border px-4 py-4">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold tracking-tight text-foreground">Messages</h2>
          <Button
            variant="ghost"
            size="icon"
            className="size-8 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            onClick={onNewConversation}
            title="New Conversation"
          >
            <Plus className="w-5 h-5" />
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
      <div className="min-h-0 flex-1 overflow-y-auto">
        {filtered.map((group) => {
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

        {filtered.length === 0 && (
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
