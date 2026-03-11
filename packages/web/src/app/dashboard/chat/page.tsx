'use client';

import { useEffect, useState, useCallback } from 'react';
import { extractText, type CanonicalContentBlock } from '@synapse/shared';
import { useSearchParams } from 'next/navigation';
import { useWorkspace } from '../workspace-provider';
import { useWebSocket } from '@/hooks/use-websocket';
import { useNotifications } from '@/hooks/use-notifications';
import { useChatStore } from '@/stores/chat-store';
import GroupList from './group-list';
import GroupChat from './group-chat';
import NewGroupDialog from './new-group-dialog';
import { MessageSquare } from 'lucide-react';

export default function ChatPage() {
  const { workspaceId } = useWorkspace();
  const searchParams = useSearchParams();
  const actorParam = searchParams.get('actor');

  const {
    groups,
    selectedGroupId,
    messages,
    loadingGroups,
    loadingMessages,
    thinkingMap,
    loadGroups,
    selectGroup,
    loadMessages,
    sendMessage,
    createGroup,
    markRead,
    handleNewMessage,
    handleStatusChanged,
    handleThinking,
    handleGroupUpdated,
    handleMemberJoined,
    handleMemberKicked,
    handleActorVersionChanged,
  } = useChatStore();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [preselectedActorId, setPreselectedActorId] = useState<string | undefined>();
  const [mobileView, setMobileView] = useState<'list' | 'chat'>('list');
  const { notify } = useNotifications();

  // WS event handler
  const onEvent = useCallback((event: any) => {
    switch (event.type) {
      case 'session.message.new':
        handleNewMessage(event.payload);
        // Notify on assistant messages when page is hidden
        if (event.payload.role === 'assistant') {
          const name = event.payload.actorName || 'Synapse';
          const content = extractText(event.payload.contentBlocks || []);
          notify(name, content, event.payload.groupId);
        }
        break;
      case 'session.status.changed':
        handleStatusChanged(event.payload);
        break;
      case 'session.thinking':
        handleThinking(event.payload);
        break;
      case 'group.updated':
        handleGroupUpdated(event.payload);
        break;
      case 'group.member_joined':
        handleMemberJoined(event.payload);
        break;
      case 'group.member_kicked':
        handleMemberKicked(event.payload);
        break;
      case 'actor.version_changed':
        handleActorVersionChanged(event.payload);
        break;
      // Also handle legacy events to refresh groups
      case 'actor.action':
      case 'secretary.response':
        if (workspaceId) loadGroups(workspaceId);
        break;
    }
  }, [handleNewMessage, handleStatusChanged, handleThinking, handleGroupUpdated,
      handleMemberJoined, handleMemberKicked, handleActorVersionChanged,
      loadGroups, workspaceId, notify]);

  const { connected } = useWebSocket({ workspaceId, onEvent });

  // Load groups on mount
  useEffect(() => {
    if (workspaceId) {
      loadGroups(workspaceId);
    }
  }, [workspaceId, loadGroups]);

  // Handle ?actor= query param (from org tree)
  useEffect(() => {
    if (actorParam && workspaceId) {
      setPreselectedActorId(actorParam);
      setDialogOpen(true);
    }
  }, [actorParam, workspaceId]);

  // Load messages when selecting a group
  useEffect(() => {
    if (workspaceId && selectedGroupId) {
      loadMessages(workspaceId, selectedGroupId);
      markRead(workspaceId, selectedGroupId);
    }
  }, [workspaceId, selectedGroupId, loadMessages, markRead]);

  const selectedGroup = groups.find((g) => g.id === selectedGroupId);

  function handleSelectGroup(id: string) {
    selectGroup(id);
    setMobileView('chat');
  }

  async function handleSend(contentBlocks: CanonicalContentBlock[], targetActorIds?: string[]) {
    if (!workspaceId || !selectedGroupId) return;
    try {
      await sendMessage(workspaceId, selectedGroupId, contentBlocks, targetActorIds);
    } catch (err) {
      console.error('Failed to send:', err);
    }
  }

  async function handleCreateGroup(actorIds: string[]) {
    if (!workspaceId) return;
    try {
      const groupId = await createGroup(workspaceId, actorIds);
      selectGroup(groupId);
      setMobileView('chat');
    } catch (err) {
      console.error('Failed to create group:', err);
    }
  }

  function handleNewConversation() {
    setPreselectedActorId(undefined);
    setDialogOpen(true);
  }

  if (!workspaceId) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <p className="text-muted-foreground">No workspace selected.</p>
      </div>
    );
  }

  return (
    <div className="flex-1 -m-4 lg:-m-8 flex overflow-hidden min-h-0">
      {/* Desktop: side-by-side. Mobile: toggle */}

      {/* Group List */}
      <div className={`
        w-80 shrink-0 ${mobileView === 'list' ? 'flex' : 'hidden'} lg:flex flex-col
      `}>
        <GroupList
          groups={groups}
          selectedId={selectedGroupId}
          thinkingMap={thinkingMap}
          onSelect={handleSelectGroup}
          onNewConversation={handleNewConversation}
        />
      </div>

      {/* Chat Area */}
      <div className={`
        flex-1 ${mobileView === 'chat' ? 'flex' : 'hidden'} lg:flex flex-col
      `}>
        {selectedGroup ? (
          <GroupChat
            group={selectedGroup}
            messages={messages}
            loading={loadingMessages}
            thinking={thinkingMap[selectedGroupId!]}
            onSend={handleSend}
            onBack={() => setMobileView('list')}
            workspaceId={workspaceId}
          />
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-center space-y-4 p-8">
            <div className="w-24 h-24 rounded-3xl bg-gray-100 dark:bg-white/5 flex items-center justify-center">
              <MessageSquare className="w-12 h-12 text-muted-foreground/30" />
            </div>
            <div>
              <h3 className="text-lg font-semibold text-foreground mb-2">Select a Conversation</h3>
              <p className="text-sm text-muted-foreground max-w-sm">
                Choose an existing conversation or start a new one to begin chatting with your digital employees.
              </p>
            </div>
          </div>
        )}
      </div>

      {/* New Group Dialog */}
      <NewGroupDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        workspaceId={workspaceId}
        onCreateGroup={handleCreateGroup}
        preselectedActorId={preselectedActorId}
      />
    </div>
  );
}
