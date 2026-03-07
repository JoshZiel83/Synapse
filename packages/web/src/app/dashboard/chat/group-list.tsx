'use client';

import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
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

function statusDotColor(status: string) {
  switch (status) {
    case 'active': return 'bg-emerald-400';
    case 'completed': return 'bg-blue-400';
    case 'failed': return 'bg-red-400';
    default: return 'bg-muted-foreground';
  }
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
    <div className="flex flex-col h-full border-r border-blue-500/10">
      {/* Header */}
      <div className="p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-foreground">Conversations</h2>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-muted-foreground hover:text-blue-400"
            onClick={onNewConversation}
            title="New Conversation"
          >
            <Plus className="w-4 h-4" />
          </Button>
        </div>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground/50" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search..."
            className="pl-9 h-9 text-xs bg-background/50 border-border/30 rounded-lg"
          />
        </div>
      </div>

      {/* Group List */}
      <ScrollArea className="flex-1">
        <div className="px-2 pb-2 space-y-0.5">
          {filtered.map((group) => {
            const isSelected = group.id === selectedId;
            const isThinking = !!thinkingMap[group.id];
            const avatarEmojis = group.participants
              .map((p) => p.emoji || p.name.charAt(0).toUpperCase())
              .slice(0, 3);

            // Truncate title/last message for preview
            const title = group.title
              ? group.title.length > 50 ? group.title.substring(0, 50) + '...' : group.title
              : group.participants.map((p) => p.name).join(', ');

            const preview = group.lastMessage
              ? `${group.lastMessage.role === 'user' ? 'You' : group.lastMessage.actorName || 'Actor'}: ${group.lastMessage.content}`
              : '';
            const previewTrunc = preview.length > 60 ? preview.substring(0, 60) + '...' : preview;

            const timeStr = group.lastMessage?.createdAt || group.createdAt;

            return (
              <button
                key={group.id}
                onClick={() => onSelect(group.id)}
                className={`
                  w-full text-left px-3 py-3 rounded-xl transition-all duration-200 group/item
                  ${isSelected
                    ? 'bg-gradient-to-r from-blue-500/20 to-violet-500/20 border border-blue-500/20'
                    : 'hover:bg-white/5'
                  }
                `}
              >
                <div className="flex items-start gap-3">
                  {/* Stacked avatars */}
                  <div className="relative shrink-0 w-10 h-10">
                    {avatarEmojis.map((emoji, i) => (
                      <div
                        key={i}
                        className={`
                          absolute flex items-center justify-center rounded-lg bg-gradient-to-br from-emerald-500/80 to-teal-600/80 text-white text-xs font-medium border-2 border-background
                          ${i === 0 ? 'w-8 h-8 top-0 left-0 z-20' : ''}
                          ${i === 1 ? 'w-6 h-6 bottom-0 right-0 z-10' : ''}
                          ${i === 2 ? 'w-5 h-5 bottom-0 left-0 z-0 opacity-60' : ''}
                        `}
                      >
                        {emoji.length <= 2 ? emoji : emoji.charAt(0)}
                      </div>
                    ))}
                    {/* Status dot */}
                    <div className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-background z-30 ${statusDotColor(group.status)}`} />
                  </div>

                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium text-foreground truncate">{title}</span>
                      <span className="text-[10px] text-muted-foreground/60 shrink-0">
                        {formatRelativeTime(timeStr)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-2 mt-0.5">
                      <span className="text-xs text-muted-foreground truncate">
                        {isThinking
                          ? (thinkingMap[group.id].status
                              ? `${thinkingMap[group.id].actorName} · ${thinkingMap[group.id].status}`
                              : `${thinkingMap[group.id].actorName} is thinking...`)
                          : previewTrunc || 'No messages yet'
                        }
                      </span>
                      {group.unreadCount > 0 && (
                        <span className="shrink-0 flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-[10px] font-bold">
                          {group.unreadCount > 99 ? '99+' : group.unreadCount}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              </button>
            );
          })}

          {filtered.length === 0 && (
            <div className="text-center py-8">
              <p className="text-xs text-muted-foreground/50">
                {search ? 'No conversations match your search' : 'No conversations yet'}
              </p>
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
