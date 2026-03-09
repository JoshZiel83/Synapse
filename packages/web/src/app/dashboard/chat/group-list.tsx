'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Plus, Search } from 'lucide-react';
import type { Group } from '@/stores/chat-store';

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
  thinkingMap: Record<string, { actorName: string; status?: string }>;
  onSelect: (id: string) => void;
  onNewConversation: () => void;
}

export default function GroupList({ groups, selectedId, thinkingMap, onSelect, onNewConversation }: GroupListProps) {
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
    <div className="flex flex-col h-full bg-gray-50/50 dark:bg-white/5 border-r border-gray-200 dark:border-white/10">
      {/* Header */}
      <div className="p-4 border-b border-gray-200 dark:border-white/10">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold tracking-tight text-gray-900 dark:text-white">Messages</h2>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-gray-400 hover:text-gray-500 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/10"
            onClick={onNewConversation}
            title="New Conversation"
          >
            <Plus className="w-5 h-5" />
          </Button>
        </div>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 dark:text-gray-500" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search conversations..."
            className="block w-full rounded-md bg-white px-3 py-1.5 pl-9 text-base text-gray-900 outline-1 -outline-offset-1 outline-gray-300 placeholder:text-gray-400 focus:outline-2 focus:-outline-offset-2 focus:outline-indigo-600 sm:text-sm/6 dark:bg-white/5 dark:text-white dark:outline-white/10 dark:placeholder:text-gray-500 dark:focus:outline-indigo-500 transition-all"
          />
        </div>
      </div>

      {/* Group List */}
      <div className="flex-1 overflow-y-auto">
        {filtered.map((group) => {
          const isSelected = group.id === selectedId;
          const isThinking = !!thinkingMap[group.id];
          const avatar = group.participants[0]?.emoji || group.participants[0]?.name?.charAt(0).toUpperCase() || '?';
          const name = group.participants.map((p) => p.name).join(', ');

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
                w-full text-left px-4 py-3 transition-colors relative
                ${isSelected
                  ? 'bg-gray-100 dark:bg-white/10'
                  : 'hover:bg-gray-100 dark:hover:bg-white/5'
                }
              `}
            >
              {isSelected && (
                <div className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-8 bg-indigo-600 rounded-r-full" />
              )}

              <div className="flex items-center gap-3">
                {/* Avatar */}
                <div className="relative shrink-0">
                  <div className="w-10 h-10 rounded-full bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center text-white text-sm font-medium">
                    {avatar.length <= 2 ? avatar : avatar.charAt(0)}
                  </div>
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
                      isSelected ? 'text-indigo-600 dark:text-indigo-400' : 'text-gray-900 dark:text-white'
                    }`}>{name}</span>
                    <span className="text-xs shrink-0 text-gray-400 dark:text-gray-500">
                      {formatRelativeTime(timeStr)}
                    </span>
                  </div>
                  <p className="text-sm text-gray-500 dark:text-gray-400 truncate mt-0.5">
                    {isThinking
                      ? (thinkingMap[group.id].status
                          ? `${thinkingMap[group.id].actorName} · ${thinkingMap[group.id].status}`
                          : `${thinkingMap[group.id].actorName} is thinking...`)
                      : previewTrunc || 'No messages yet'
                    }
                  </p>
                </div>
              </div>
            </button>
          );
        })}

        {filtered.length === 0 && (
          <div className="text-center py-8">
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {search ? 'No conversations match your search' : 'No conversations yet'}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
