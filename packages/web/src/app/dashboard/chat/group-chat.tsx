'use client';

import { useEffect, useRef, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Send, ArrowDown, Bot, Paperclip, X } from 'lucide-react';
import MessageBubble from './message-bubble';
import type { Group, GroupMessage, Attachment } from '@/stores/chat-store';
import { api } from '@/lib/api';

interface GroupChatProps {
  group: Group;
  messages: GroupMessage[];
  loading: boolean;
  thinking?: { actorId: string; actorName: string; status?: string };
  onSend: (content: string, attachments?: Attachment[]) => Promise<void> | void;
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
  const fileInputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [showJumpButton, setShowJumpButton] = useState(false);
  const prevMsgCount = useRef(messages.length);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    if (messages.length > prevMsgCount.current) {
      // Only auto-scroll if near bottom
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

    const content = input.trim() || '(attached files)';
    const filesToUpload = [...pendingFiles];
    setInput('');
    setPendingFiles([]);
    setSending(true);

    try {
      // Upload files first if any
      let attachments: Attachment[] | undefined;
      if (filesToUpload.length > 0 && workspaceId) {
        attachments = [];
        for (const file of filesToUpload) {
          const record = await api.uploadFile(workspaceId, file);
          attachments.push({
            id: record.id,
            url: record.url,
            fullUrl: record.fullUrl,
            storedName: record.storedName,
            originalName: record.originalName || file.name,
            mimeType: record.mimeType || file.type,
            sizeBytes: record.sizeBytes || file.size,
          });
        }
      }
      await onSend(content, attachments);
    } catch {
      // error handled upstream
    } finally {
      setSending(false);
      // Scroll to bottom after sending
      setTimeout(() => {
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
      }, 50);
    }
  }

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files) return;
    setPendingFiles((prev) => [...prev, ...Array.from(files)]);
    // Reset input so selecting the same file again triggers change
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

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 lg:px-6 py-3 border-b border-blue-500/10">
        {onBack && (
          <Button variant="ghost" size="icon" className="lg:hidden h-8 w-8" onClick={onBack}>
            <ArrowDown className="w-4 h-4 rotate-90" />
          </Button>
        )}

        {/* Participant avatars */}
        <div className="flex -space-x-2">
          {group.participants.slice(0, 4).map((p) => (
            <div
              key={p.id}
              className="w-8 h-8 rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center text-sm border-2 border-background"
              title={p.name}
            >
              {p.emoji || <Bot className="w-4 h-4 text-white" />}
            </div>
          ))}
          {group.participants.length > 4 && (
            <div className="w-8 h-8 rounded-lg bg-white/10 flex items-center justify-center text-[10px] text-muted-foreground border-2 border-background">
              +{group.participants.length - 4}
            </div>
          )}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-foreground truncate">
              {group.participants.map((p) => p.name).join(', ')}
            </span>
            <Badge variant="outline" className={`text-[10px] px-1.5 py-0 shrink-0 ${status.cls}`}>
              {status.text}
            </Badge>
          </div>
        </div>
      </div>

      {/* Messages */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto p-4 lg:p-6 space-y-4"
        onScroll={handleScroll}
      >
        {loading ? (
          <div className="flex items-center justify-center h-full">
            <div className="h-8 w-8 rounded-full border-2 border-blue-500 border-t-transparent animate-spin" />
          </div>
        ) : messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center space-y-4">
            <div className="w-20 h-20 rounded-3xl bg-gradient-to-br from-blue-500/20 to-violet-500/20 flex items-center justify-center">
              {group.participants[0]?.emoji ? (
                <span className="text-3xl">{group.participants[0].emoji}</span>
              ) : (
                <Bot className="w-10 h-10 text-blue-400" />
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
              content={msg.content}
              actorName={msg.actorName}
              actorEmoji={msg.actorEmoji}
              actorRole={msg.actorRole}
              timestamp={msg.createdAt}
              isUser={msg.role === 'user'}
              status={msg.status}
              toolsUsed={msg.toolsUsed}
              serverToolCalls={msg.serverToolCalls}
              citationSources={msg.citationSources}
              attachments={msg.attachments}
            />
          ))
        )}

        {/* Thinking indicator */}
        {thinking && (
          <div className="flex gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center shrink-0">
              <Bot className="w-4 h-4 text-white" />
            </div>
            <div className="glass-card rounded-2xl rounded-tl-sm px-4 py-3">
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
            className="absolute -top-12 left-1/2 -translate-x-1/2 flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-blue-500/90 text-white text-xs shadow-lg hover:bg-blue-500 transition-all"
          >
            <ArrowDown className="w-3 h-3" />
            New messages
          </button>
        </div>
      )}

      {/* Input */}
      <div className="p-4 border-t border-blue-500/5">
        {/* Responding hint */}
        {thinking && (
          <div className="flex items-center gap-2 mb-2 px-1">
            <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            <span className="text-xs text-muted-foreground">
              {thinking.actorName} is responding — you can still send messages
            </span>
          </div>
        )}
        {/* Pending file previews */}
        {pendingFiles.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-3">
            {pendingFiles.map((file, i) => (
              <div
                key={`${file.name}-${i}`}
                className="flex items-center gap-2 bg-white/5 border border-blue-500/10 rounded-lg px-3 py-1.5 text-xs text-muted-foreground"
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
        <form onSubmit={handleSend} className="flex gap-3">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/*,audio/*,video/*,.pdf,.doc,.docx,.txt,.csv,.xls,.xlsx"
            onChange={handleFileSelect}
            className="hidden"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => fileInputRef.current?.click()}
            disabled={sending}
            className="shrink-0 h-12 w-12 text-muted-foreground hover:text-blue-400"
          >
            <Paperclip className="w-5 h-5" />
          </Button>
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Type a message..."
            className="flex-1 bg-background/50 border-border/50 focus:border-blue-500/50 rounded-xl h-12 text-sm"
            disabled={sending}
          />
          <Button
            type="submit"
            disabled={(!input.trim() && pendingFiles.length === 0) || sending}
            className="bg-gradient-to-r from-blue-600 to-violet-600 hover:from-blue-500 hover:to-violet-500 text-white rounded-xl h-12 w-12 p-0 shadow-lg shadow-blue-500/20 transition-all duration-300"
          >
            <Send className="w-5 h-5" />
          </Button>
        </form>
      </div>
    </div>
  );
}
