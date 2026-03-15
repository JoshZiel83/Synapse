'use client';

import type { ActorRuntimeState } from '@synapse/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { fileRefBlock, textBlock, type CanonicalContentBlock } from '@synapse/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Send, ArrowDown, Paperclip, X, Pencil, Check } from 'lucide-react';
import MessageBubble from './message-bubble';
import type { Group, GroupMessage } from '@/stores/chat-store';
import { useAuthStore } from '@/stores/auth-store';
import { api } from '@/lib/api';
import ChatAvatar from './chat-avatar';
import ChatMemberStrip from './chat-member-strip';
import GroupMemberPickerDialog from './group-member-picker-dialog';
import ChatMentionsInput, { type MentionableActor } from './chat-mentions-input';

interface GroupChatProps {
  group: Group;
  messages: GroupMessage[];
  loading: boolean;
  actorRuntimes?: Record<string, ActorRuntimeState>;
  onSend: (contentBlocks: CanonicalContentBlock[], targetActorIds?: string[]) => Promise<void> | void;
  onBack?: () => void;
  workspaceId?: string;
  onRefreshGroup?: () => Promise<void> | void;
}

function summarizeMemberCounts(group: Group) {
  const userCount = group.members.filter((member) => member.type === 'user').length;
  const actorCount = group.members.filter((member) => member.type === 'actor').length;
  const userLabel = `${userCount} user${userCount === 1 ? '' : 's'}`;
  const actorLabel = `${actorCount} actor${actorCount === 1 ? '' : 's'}`;
  return `${userLabel} · ${actorLabel}`;
}

function getRuntimePriority(runtime: ActorRuntimeState) {
  if (runtime.health === 'error' || runtime.laneState === 'blocked') return 0;
  if (runtime.laneState === 'running') return 1;
  if (runtime.laneState === 'queued') return 2;
  return 3;
}

function summarizeCurrentUserProcessingActors(runtimes: ActorRuntimeState[]) {
  const names = runtimes.map((runtime) => runtime.actorName);
  if (names.length === 0) return null;
  if (names.length === 1) return `${names[0]} is processing your message`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are processing your messages`;
  return `${names[0]}, ${names[1]} +${names.length - 2} are processing your messages`;
}

export default function GroupChat({
  group,
  messages,
  loading,
  actorRuntimes,
  onSend,
  onBack,
  workspaceId,
  onRefreshGroup,
}: GroupChatProps) {
  const { user } = useAuthStore();
  const currentUserId = user?.id || '';
  const [inputValue, setInputValue] = useState('');
  const [inputPlainTextValue, setInputPlainTextValue] = useState('');
  const [mentionedActorIds, setMentionedActorIds] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [titleDraft, setTitleDraft] = useState(group.title || '');
  const [editingTitle, setEditingTitle] = useState(false);
  const [savingTitle, setSavingTitle] = useState(false);
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [memberDialogOpen, setMemberDialogOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const groupAvatarInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [showJumpButton, setShowJumpButton] = useState(false);
  const prevMsgCount = useRef(messages.length);
  const mentionableActors = useMemo<MentionableActor[]>(
    () => group.participants.map((participant) => ({
      id: participant.id,
      name: participant.name,
      role: participant.role,
      avatarUrl: participant.avatarUrl,
      emoji: participant.emoji,
    })),
    [group.participants],
  );
  const mentionedActors = useMemo(
    () => mentionedActorIds
      .map((actorId) => mentionableActors.find((actor) => actor.id === actorId))
      .filter((actor): actor is MentionableActor => Boolean(actor)),
    [mentionedActorIds, mentionableActors],
  );
  const actorMemberMap = useMemo(
    () => Object.fromEntries(
      group.members
        .filter((member) => member.type === 'actor')
        .map((member) => [member.id, member]),
    ),
    [group.members],
  );
  const activeRuntimes = useMemo(
    () => Object.values(actorRuntimes || {})
      .filter((runtime) => runtime.laneState !== 'idle' && runtime.laneState !== 'closed')
      .sort((left, right) => getRuntimePriority(left) - getRuntimePriority(right)),
    [actorRuntimes],
  );
  const myProcessingRuntimes = useMemo(
    () => activeRuntimes.filter((runtime) => (
      runtime.laneState === 'running'
      && runtime.activeWakeups.some((wakeup) => (
        wakeup.status === 'attached'
        && wakeup.sourceMemberType === 'user'
        && wakeup.sourceMemberId === currentUserId
      ))
    )),
    [activeRuntimes, currentUserId],
  );
  const workingHint = useMemo(
    () => summarizeCurrentUserProcessingActors(myProcessingRuntimes),
    [myProcessingRuntimes],
  );

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

  useEffect(() => {
    setTitleDraft(group.title || '');
    setEditingTitle(false);
  }, [group.id, group.title]);

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

  async function submitMessage() {
    if ((!inputPlainTextValue.trim() && pendingFiles.length === 0) || sending) return;

    const textContent = inputPlainTextValue.trim();
    const filesToUpload = [...pendingFiles];
    setInputValue('');
    setInputPlainTextValue('');
    setMentionedActorIds([]);
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
      const targetIds = mentionedActorIds.length > 0 ? mentionedActorIds : undefined;
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

  const title = group.title || group.participants.map((p) => p.name).join(', ');
  const memberSummary = summarizeMemberCounts(group);

  async function handleSaveTitle() {
    if (!workspaceId || !group.permissions?.canManage) {
      setEditingTitle(false);
      setTitleDraft(group.title || '');
      return;
    }

    const nextTitle = titleDraft.trim();
    if (!nextTitle || nextTitle === (group.title || '').trim()) {
      setEditingTitle(false);
      setTitleDraft(group.title || '');
      return;
    }

    setSavingTitle(true);
    try {
      await api.updateGroup(workspaceId, group.id, { title: nextTitle });
      await onRefreshGroup?.();
      setEditingTitle(false);
    } catch (error) {
      console.error('Failed to update group title:', error);
      setTitleDraft(group.title || '');
    } finally {
      setSavingTitle(false);
    }
  }

  async function handleGroupAvatarFile(file: File | null) {
    if (!file || !workspaceId || !group.permissions?.canManage) return;
    setAvatarUploading(true);
    try {
      const uploaded = await api.uploadFile(workspaceId, file);
      await api.updateGroup(workspaceId, group.id, { avatarFileId: uploaded.id });
      await onRefreshGroup?.();
    } catch (error) {
      console.error('Failed to update group avatar:', error);
    } finally {
      setAvatarUploading(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between border-b border-border bg-background px-6 py-4">
        <div className="flex min-w-0 items-center gap-3">
          {onBack && (
            <Button variant="ghost" size="icon" className="lg:hidden h-8 w-8" onClick={onBack}>
              <ArrowDown className="w-4 h-4 rotate-90" />
            </Button>
          )}
          <div className="group relative">
            <button
              type="button"
              className="rounded-full transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-70"
              onClick={() => groupAvatarInputRef.current?.click()}
              disabled={!group.permissions?.canManage || avatarUploading}
              title={group.permissions?.canManage ? 'Change group avatar' : undefined}
            >
              <ChatAvatar
                name={title}
                avatarUrl={group.avatarUrl}
                entityType="group"
                size="lg"
                className="size-12"
              />
            </button>
            {group.permissions?.canManage ? (
              <div className="pointer-events-none absolute -bottom-1 -right-1 flex size-5 items-center justify-center rounded-full border border-border bg-background text-muted-foreground opacity-0 shadow-sm transition-opacity group-hover:opacity-100">
                <Pencil className="size-3" />
              </div>
            ) : null}
            <input
              ref={groupAvatarInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0] || null;
                void handleGroupAvatarFile(file);
                event.target.value = '';
              }}
            />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              {editingTitle ? (
                <div className="flex items-center gap-2">
                  <Input
                    value={titleDraft}
                    onChange={(event) => setTitleDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        void handleSaveTitle();
                      }
                      if (event.key === 'Escape') {
                        setEditingTitle(false);
                        setTitleDraft(group.title || '');
                      }
                    }}
                    className="h-8 w-[220px]"
                    autoFocus
                  />
                  <Button size="icon" variant="ghost" className="size-8" onClick={() => void handleSaveTitle()} disabled={savingTitle}>
                    <Check className="size-4" />
                  </Button>
                </div>
              ) : (
                <>
                  <h2 className="truncate text-sm font-semibold tracking-tight text-foreground">
                    {title}
                  </h2>
                  {group.permissions?.canManage ? (
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-7 text-muted-foreground"
                      onClick={() => setEditingTitle(true)}
                    >
                      <Pencil className="size-3.5" />
                    </Button>
                  ) : null}
                </>
              )}
            </div>
            <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
              {memberSummary || `${group.members.length} member${group.members.length > 1 ? 's' : ''}`}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <ChatMemberStrip
            members={group.members}
            runtimeByActor={actorRuntimes}
            max={5}
            size="lg"
            onAdd={group.permissions?.canManageMembers ? () => setMemberDialogOpen(true) : undefined}
          />
        </div>
      </div>

      {/* Messages */}
      <div
        ref={scrollRef}
        className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto bg-muted/20 px-4 py-5 lg:px-6"
        onScroll={handleScroll}
      >
        {loading ? (
          <div className="flex h-full items-center justify-center">
            <div className="size-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        ) : messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-4 rounded-[28px] border border-dashed border-border bg-background px-6 py-10 text-center shadow-sm">
            <ChatAvatar
              name={title}
              avatarUrl={group.avatarUrl}
              entityType="group"
              size="lg"
              className="size-20 rounded-3xl"
            />
            <div>
              <h3 className="mb-2 text-lg font-semibold text-foreground">
                Chat in {title}
              </h3>
              <p className="max-w-md text-sm text-muted-foreground">
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
              actorAvatarUrl={msg.fromActorId ? actorMemberMap[msg.fromActorId]?.avatarUrl : undefined}
              actorEmoji={msg.actorEmoji}
              actorRole={msg.actorRole}
              actorRuntime={msg.fromActorId ? actorRuntimes?.[msg.fromActorId] : undefined}
              timestamp={msg.createdAt}
              isUser={msg.role === 'user'}
              status={msg.status}
              toolsUsed={msg.toolsUsed}
              serverToolCalls={msg.serverToolCalls}
              citationSources={msg.citationSources}
              coordination={msg.coordination}
              groupMembers={group.members}
              targetActorIds={msg.targetActorIds}
              targetUserIds={msg.targetUserIds}
            />
          ))
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
        {workingHint && (
          <div className="flex items-center gap-2 mb-2 px-1">
            <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            <span className="text-xs text-muted-foreground">
              {workingHint}
            </span>
          </div>
        )}
        {/* Pending file previews */}
        {pendingFiles.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-3">
            {pendingFiles.map((file, i) => (
              <div
                key={`${file.name}-${i}`}
                className="flex items-center gap-2 rounded-2xl border border-border bg-background px-3 py-1.5 text-xs text-muted-foreground shadow-sm"
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
          onSubmit={(event) => {
            event.preventDefault();
            void submitMessage();
          }}
          className="relative overflow-hidden rounded-3xl border border-border bg-background shadow-sm transition-colors focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/40"
        >
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/*,audio/*,video/*,.pdf,.doc,.docx,.txt,.csv,.xls,.xlsx"
            onChange={handleFileSelect}
            className="hidden"
          />
          {mentionedActors.length > 0 ? (
            <div className="flex flex-wrap gap-2 border-b border-border/70 px-3 pt-3 pb-2">
              {mentionedActors.map((actor) => (
                <div
                  key={actor.id}
                  className="inline-flex items-center gap-2 rounded-full border border-border bg-muted/60 px-2.5 py-1 text-xs text-foreground"
                >
                  <ChatAvatar
                    name={actor.name}
                    avatarUrl={actor.avatarUrl}
                    emoji={actor.emoji}
                    entityType="actor"
                    size="sm"
                  />
                  <span className="font-medium">@{actor.name}</span>
                </div>
              ))}
            </div>
          ) : null}
          <div className="relative">
            <ChatMentionsInput
              actors={mentionableActors}
              value={inputValue}
              plainTextValue={inputPlainTextValue}
              inputRef={textareaRef}
              onChange={(nextValue, nextPlainTextValue, nextMentionedActorIds) => {
                setInputValue(nextValue);
                setInputPlainTextValue(nextPlainTextValue);
                setMentionedActorIds(nextMentionedActorIds);
              }}
              onSubmit={() => {
                void submitMessage();
              }}
              disabled={sending}
            />
          </div>
          {/* Spacer for toolbar */}
          <div className="py-1" aria-hidden="true">
            <div className="h-9" />
          </div>
          {/* Toolbar */}
          <div className="absolute inset-x-0 bottom-0 flex justify-between py-2 pl-3 pr-2">
            <div className="flex items-center space-x-1">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => fileInputRef.current?.click()}
                disabled={sending}
                className="rounded-full text-muted-foreground"
              >
                <Paperclip className="w-5 h-5" />
              </Button>
            </div>
            <div className="flex-shrink-0">
              <Button
                type="submit"
                size="sm"
                disabled={(!inputPlainTextValue.trim() && pendingFiles.length === 0) || sending}
                className="min-w-[104px] rounded-full shadow-sm"
              >
                <span>Send</span>
                <Send className="w-4 h-4" />
              </Button>
            </div>
          </div>
        </form>
      </div>
      <GroupMemberPickerDialog
        open={memberDialogOpen}
        onOpenChange={setMemberDialogOpen}
        workspaceId={workspaceId || ''}
        groupId={group.id}
        existingMembers={group.members}
        onAdded={async () => {
          await onRefreshGroup?.();
        }}
      />
    </div>
  );
}
