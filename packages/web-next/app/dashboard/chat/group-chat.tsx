'use client';

import { useEffect, useRef, useState } from 'react';
import { fileRefBlock, textBlock, type CanonicalContentBlock } from '@synapse/shared';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Send, ArrowDown, Bot, Paperclip, X, AtSign, Users } from 'lucide-react';
import MessageBubble from './message-bubble';
import type { Group, GroupMessage } from '@/stores/chat-store';
import { api } from '@/lib/api';

interface GroupChatProps {
  group: Group;
  messages: GroupMessage[];
  loading: boolean;
  thinking?: { actorId: string; actorName: string; status?: string };
  onSend: (contentBlocks: CanonicalContentBlock[], targetActorIds?: string[]) => Promise<void> | void;
  onBack?: () => void;
  workspaceId?: string;
}

function statusLabel(status: string) {
  switch (status) {
    case 'active': return { text: 'Active', cls: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' };
    case 'completed': return { text: 'Completed', cls: 'bg-blue-500/10 text-blue-400 border-blue-500/20' };
    case 'failed': return { text: 'Failed', cls: 'bg-red-500/10 text-red-400 border-red-500/20' };
    default: return { text: status, cls: 'bg-muted text-muted-foreground' };
  }
}

export default function GroupChat({ group, messages, loading, thinking, onSend, onBack, workspaceId }: GroupChatProps) {
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [mentionTarget, setMentionTarget] = useState<string | null>(null); // actorId or null (all)
  const [showMentionPicker, setShowMentionPicker] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [showJumpButton, setShowJumpButton] = useState(false);
  const prevMsgCount = useRef(messages.length);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    if (messages.length > prevMsgCount.current) {
      const el = scrollRef.current;
      if (el) {
        const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 150;
        if (isNearBottom) {
          bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
        } else {
          setShowJumpButton(true);
        }
      }
    }
    prevMsgCount.current = messages.length;
  }, [messages.length]);

  // Initial scroll to bottom
  useEffect(() => {
    setTimeout(() => {
      bottomRef.current?.scrollIntoView();
    }, 100);
  }, [group.id]);

  // Track scroll position
  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 150;
    if (isNearBottom) setShowJumpButton(false);
  };

  const scrollToBottom = () => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    setShowJumpButton(false);
  };

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    if ((!input.trim() && pendingFiles.length === 0) || sending) return;

    const textContent = input.trim();
    const filesToUpload = [...pendingFiles];
    setInput('');
    setPendingFiles([]);
    setSending(true);

    try {
      const contentBlocks: CanonicalContentBlock[] = [];
      if (textContent) {
        contentBlocks.push(textBlock(textContent));
      }
      if (filesToUpload.length > 0 && workspaceId) {
        for (const file of filesToUpload) {
          const record = await api.uploadFile(workspaceId, file);
          contentBlocks.push(fileRefBlock({
            fileId: record.id,
            storedName: record.storedName || '',
            url: record.url,
            mimeType: record.mimeType || file.type,
            originalName: record.originalName || file.name,
            sizeBytes: record.sizeBytes || file.size,
            category: (record.mimeType || file.type || '').startsWith('image/')
              ? 'image'
              : (record.mimeType || file.type || '').startsWith('audio/')
                ? 'audio'
                : (record.mimeType || file.type || '').startsWith('video/')
                  ? 'video'
                  : 'document',
          }));
        }
      }
      const targetIds = mentionTarget ? [mentionTarget] : undefined;
      await onSend(contentBlocks, targetIds);
    } catch {
      // error handled upstream
    } finally {
      setSending(false);
      setTimeout(() => {
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
      }, 50);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend(e as any);
    }
  }

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files) return;
    setPendingFiles((prev) => [...prev, ...Array.from(files)]);
    e.target.value = '';
  }

  function removeFile(index: number) {
    setPendingFiles((prev) => prev.filter((_, i) => i !== index));
  }

  function formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  const status = statusLabel(group.status);
  const title = group.title || group.participants.map((p) => p.name).join(', ');

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {/* Header */}
      <div className="flex h-[65px] shrink-0 items-center justify-between border-b border-border px-6">
        <div className="flex min-w-0 items-center gap-3">
          {onBack && (
            <Button variant="ghost" size="icon" className="lg:hidden h-8 w-8" onClick={onBack}>
              <ArrowDown className="w-4 h-4 rotate-90" />
            </Button>
          )}
          {/* Participant avatars */}
          <div className="flex -space-x-2">
            {group.participants.slice(0, 3).map((p) => (
              <div key={p.id} className="w-9 h-9 bg-indigo-100 dark:bg-indigo-500/20 rounded-full flex items-center justify-center ring-2 ring-white dark:ring-gray-900">
                {p.emoji ? (
                  <span className="text-sm">{p.emoji}</span>
                ) : (
                  <span className="text-xs font-medium text-indigo-600 dark:text-indigo-400">{p.name.charAt(0)}</span>
                )}
              </div>
            ))}
            {group.participants.length > 3 && (
              <div className="w-9 h-9 bg-gray-100 dark:bg-white/10 rounded-full flex items-center justify-center ring-2 ring-white dark:ring-gray-900">
                <span className="text-xs font-medium text-gray-500">+{group.participants.length - 3}</span>
              </div>
            )}
          </div>
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold tracking-tight text-foreground">
              {title}
            </h2>
            <div className="flex items-center gap-1.5 mt-0.5">
              <Users className="w-3 h-3 text-muted-foreground/50" />
              <span className="text-[11px] text-muted-foreground">
                {group.participants.length} member{group.participants.length > 1 ? 's' : ''}
              </span>
              <Badge variant="outline" className={`text-[10px] px-1.5 py-0 shrink-0 ${status.cls}`}>
                {status.text}
              </Badge>
            </div>
          </div>
        </div>
      </div>

      {/* Messages */}
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 space-y-4 overflow-y-auto bg-background p-4 lg:p-6"
        onScroll={handleScroll}
      >
        {loading ? (
          <div className="flex items-center justify-center h-full">
            <div className="h-8 w-8 rounded-full border-2 border-indigo-600 border-t-transparent animate-spin" />
          </div>
        ) : messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center space-y-4">
            <div className="w-20 h-20 rounded-3xl bg-gray-100 dark:bg-white/5 flex items-center justify-center">
              {group.participants[0]?.emoji ? (
                <span className="text-3xl">{group.participants[0].emoji}</span>
              ) : (
                <Bot className="w-10 h-10 text-indigo-500" />
              )}
            </div>
            <div>
              <h3 className="text-lg font-semibold text-foreground mb-2">
                Chat with {group.participants.map((p) => p.name).join(', ')}
              </h3>
              <p className="text-sm text-muted-foreground max-w-md">
                Messages from all participants will appear here.
              </p>
            </div>
          </div>
        ) : (
          messages.map((msg) => (
            <MessageBubble
              key={msg.id}
              role={msg.role}
              contentBlocks={msg.contentBlocks}
              actorName={msg.actorName}
              actorEmoji={msg.actorEmoji}
              actorRole={msg.actorRole}
              timestamp={msg.createdAt}
              isUser={msg.role === 'user'}
              status={msg.status}
              toolsUsed={msg.toolsUsed}
              serverToolCalls={msg.serverToolCalls}
              citationSources={msg.citationSources}
              coordination={msg.coordination}
              targetActorNames={msg.targetActorNames}
            />
          ))
        )}

        {/* Thinking indicator */}
        {thinking && (
          <div className="flex gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center shrink-0">
              <Bot className="w-4 h-4 text-white" />
            </div>
            <div className="bg-gray-50 dark:bg-white/5 ring-1 ring-gray-200 dark:ring-white/10 rounded-2xl rounded-tl-sm px-4 py-3">
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-1.5">
                  <div className="w-2 h-2 rounded-full bg-emerald-400 animate-bounce" style={{ animationDelay: '0ms' }} />
                  <div className="w-2 h-2 rounded-full bg-emerald-400 animate-bounce" style={{ animationDelay: '150ms' }} />
                  <div className="w-2 h-2 rounded-full bg-emerald-400 animate-bounce" style={{ animationDelay: '300ms' }} />
                </div>
                <span className="text-xs text-muted-foreground ml-2">
                  {thinking.status
                    ? `${thinking.actorName} · ${thinking.status}`
                    : `${thinking.actorName} is thinking...`
                  }
                </span>
              </div>
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Jump to bottom button */}
      {showJumpButton && (
        <div className="relative">
          <button
            onClick={scrollToBottom}
            className="absolute -top-12 left-1/2 -translate-x-1/2 flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-indigo-600 text-white text-xs shadow-lg hover:bg-indigo-500 transition-all"
          >
            <ArrowDown className="w-3 h-3" />
            New messages
          </button>
        </div>
      )}

      {/* Input area — textarea with toolbar */}
      <div className="shrink-0 border-t border-border bg-muted/20 p-4">
        {/* Responding hint */}
        {thinking && (
          <div className="flex items-center gap-2 mb-2 px-1">
            <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            <span className="text-xs text-muted-foreground">
              {thinking.actorName} is responding — you can still send messages
            </span>
          </div>
        )}
        {/* @mention target indicator */}
        {mentionTarget && (
          <div className="flex items-center gap-2 mb-2 px-1">
            <AtSign className="w-3 h-3 text-indigo-500" />
            <span className="text-xs text-indigo-600 dark:text-indigo-400 font-medium">
              {group.participants.find(p => p.id === mentionTarget)?.name || 'Unknown'}
            </span>
            <button onClick={() => setMentionTarget(null)} className="text-muted-foreground/50 hover:text-muted-foreground">
              <X className="w-3 h-3" />
            </button>
          </div>
        )}
        {/* @mention picker dropdown */}
        {showMentionPicker && (
          <div className="mb-2 bg-white dark:bg-gray-900 border border-gray-200 dark:border-white/10 rounded-lg shadow-lg overflow-hidden">
            <div className="px-3 py-1.5 text-[11px] text-muted-foreground border-b border-gray-200 dark:border-white/10 font-medium">
              Send to... {mentionTarget && <span className="text-indigo-500 ml-1">(click again to deselect)</span>}
            </div>
            {group.participants.map((p) => (
              <button
                key={p.id}
                onClick={() => {
                  if (mentionTarget === p.id) {
                    setMentionTarget(null);
                  } else {
                    setMentionTarget(p.id);
                  }
                  setShowMentionPicker(false);
                }}
                className={`w-full text-left px-3 py-2 text-sm hover:bg-gray-50 dark:hover:bg-white/5 flex items-center gap-2 transition-colors ${mentionTarget === p.id ? 'bg-indigo-50 dark:bg-indigo-500/10 text-indigo-600 dark:text-indigo-400' : 'text-foreground'}`}
              >
                <div className="w-5 h-5 rounded-full bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center shrink-0">
                  {p.emoji ? (
                    <span className="text-[10px]">{p.emoji}</span>
                  ) : (
                    <span className="text-[10px] text-white font-medium">{p.name.charAt(0)}</span>
                  )}
                </div>
                <span>{p.name}</span>
                <span className="text-[10px] text-muted-foreground ml-auto">{p.role}</span>
              </button>
            ))}
            <div className="px-3 py-1.5 text-[10px] text-muted-foreground/60 border-t border-gray-200 dark:border-white/10">
              No @mention → sends to all members
            </div>
          </div>
        )}
        {/* Pending file previews */}
        {pendingFiles.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-3">
            {pendingFiles.map((file, i) => (
              <div
                key={`${file.name}-${i}`}
                className="flex items-center gap-2 bg-white dark:bg-gray-900 border border-gray-200 dark:border-white/10 rounded-lg px-3 py-1.5 text-xs text-muted-foreground"
              >
                <span className="truncate max-w-[150px]">{file.name}</span>
                <span className="text-muted-foreground/50">{formatFileSize(file.size)}</span>
                <button
                  onClick={() => removeFile(i)}
                  className="text-muted-foreground/50 hover:text-red-400 transition-colors"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        )}
        <form
          onSubmit={handleSend}
          className="relative overflow-hidden rounded-lg border border-input bg-background shadow-sm transition-colors focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50"
        >
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/*,audio/*,video/*,.pdf,.doc,.docx,.txt,.csv,.xls,.xlsx"
            onChange={handleFileSelect}
            className="hidden"
          />
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type a message..."
            rows={2}
            disabled={sending}
            className="block w-full resize-none border-0 bg-transparent px-4 py-3 text-foreground placeholder:text-muted-foreground focus:ring-0 focus:outline-none sm:text-sm/6"
          />
          {/* Spacer for toolbar */}
          <div className="py-1" aria-hidden="true">
            <div className="h-9" />
          </div>
          {/* Toolbar */}
          <div className="absolute inset-x-0 bottom-0 flex justify-between py-2 pl-3 pr-2">
            <div className="flex items-center space-x-1">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={sending}
                className="flex h-8 w-8 items-center justify-center rounded-full text-gray-400 hover:text-gray-500 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/10 transition-colors"
              >
                <Paperclip className="w-5 h-5" />
              </button>
              {group.participants.length > 1 && (
                <button
                  type="button"
                  onClick={() => setShowMentionPicker(!showMentionPicker)}
                  disabled={sending}
                  className={`flex h-8 w-8 items-center justify-center rounded-full transition-colors ${
                    mentionTarget || showMentionPicker
                      ? 'text-indigo-500 bg-indigo-50 dark:bg-indigo-500/10'
                      : 'text-gray-400 hover:text-gray-500 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/10'
                  }`}
                >
                  <AtSign className="w-5 h-5" />
                </button>
              )}
            </div>
            <div className="flex-shrink-0">
              <button
                type="submit"
                disabled={(!input.trim() && pendingFiles.length === 0) || sending}
                className="inline-flex items-center rounded-md bg-indigo-600 px-4 py-1.5 text-sm font-semibold text-white shadow-xs hover:bg-indigo-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:bg-gray-200 dark:disabled:bg-gray-800 disabled:text-gray-400 dark:disabled:text-gray-500 disabled:cursor-not-allowed transition-all"
              >
                <span className="mr-1.5">Send</span>
                <Send className="w-4 h-4" />
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
