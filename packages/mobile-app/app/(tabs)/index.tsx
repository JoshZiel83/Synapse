import { useLocalSearchParams, useRouter } from "expo-router";
import { startTransition, useEffect, useMemo, useState } from "react";
import { Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";

import { ConversationItem } from "@/components/conversation-item";
import { HomeQuickComposer } from "@/components/home-quick-composer";
import { MobileHeaderActions } from "@/components/mobile-header-actions";
import { WorkspaceSwitcher } from "@/components/workspace-switcher";
import {
  EmptyState,
  LoadingBlock,
  MobilePageHeader,
  ScreenScroll,
  SectionBlock,
  SectionTitleRow,
} from "@/components/ui";
import { api } from "@/lib/api";
import { listPendingConversationReads } from "@/lib/chat-sync";
import { useWorkspace } from "@/providers/workspace-provider";
import { theme } from "@/theme/tokens";
import type { ConversationSummaryView } from "@/types/api";
import type { Actor } from "@shared";

function sortConversations<
  T extends { createdAt: string; lastMessage?: { createdAt?: string } },
>(items: T[]) {
  return [...items].sort((left, right) => {
    const leftAt = left.lastMessage?.createdAt || left.createdAt;
    const rightAt = right.lastMessage?.createdAt || right.createdAt;
    return new Date(rightAt).getTime() - new Date(leftAt).getTime();
  });
}

async function applyLocalReadState(
  conversations: ConversationSummaryView[],
) {
  const pendingReads = await listPendingConversationReads();
  const pendingConversationIds = new Set(
    pendingReads.map((entry) => entry.conversationId),
  );

  return conversations.map((conversation) =>
    pendingConversationIds.has(conversation.id)
      ? { ...conversation, unreadCount: 0 }
      : conversation,
  );
}

export default function HomeTab() {
  const router = useRouter();
  const params = useLocalSearchParams<{ actorId?: string }>();
  const {
    workspaceId,
    workspaceName,
    workspaces,
    needsOnboarding,
    setWorkspaceId,
  } = useWorkspace();
  const [actors, setActors] = useState<Actor[]>([]);
  const [conversations, setConversations] = useState<ConversationSummaryView[]>(
    [],
  );
  const [selectedActorId, setSelectedActorId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedActor = useMemo(
    () =>
      actors.find((actor) => actor.id === selectedActorId) ?? actors[0] ?? null,
    [actors, selectedActorId],
  );

  async function loadData(isRefreshing = false) {
    if (!workspaceId) {
      setActors([]);
      setConversations([]);
      setSelectedActorId(null);
      setLoading(false);
      setRefreshing(false);
      return;
    }

    if (isRefreshing) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }

    try {
      const [actorsResponse, conversationsResponse, preferenceResponse] =
        await Promise.all([
          api.getActors(workspaceId),
          api.getThreads(workspaceId),
          api.getWorkspaceChiefActorPreference(workspaceId).catch(() => null),
        ]);

      const activeActors = actorsResponse.actors.filter(
        (actor) => actor.isActive,
      );

      setActors(activeActors);
      setConversations(
        sortConversations(
          await applyLocalReadState(conversationsResponse.conversations),
        ),
      );
      setSelectedActorId(
        params.actorId ||
          preferenceResponse?.chiefActorId ||
          activeActors[0]?.id ||
          null,
      );
      setError(null);
    } catch (nextError) {
      setError(
        nextError instanceof Error ? nextError.message : "加载首页失败。",
      );
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    void loadData();
  }, [params.actorId, workspaceId]);

  useEffect(() => {
    if (!params.actorId) return;
    if (!actors.some((actor) => actor.id === params.actorId)) return;
    setSelectedActorId(params.actorId);
  }, [actors, params.actorId]);

  async function handleStartConversation(content: string) {
    const trimmed = content.trim();
    if (!workspaceId || !selectedActor || !trimmed) return;

    setSubmitting(true);
    setError(null);

    try {
      const response = await api.createThread(workspaceId, {
        kind: "group",
        actorIds: [selectedActor.id],
        title: selectedActor.definition.name,
        content: trimmed,
        targetActorIds: [selectedActor.id],
      });
      const conversationId = response.conversationId;

      if (conversationId) {
        startTransition(() => {
          router.push(`/chat/${conversationId}`);
        });
      }
    } catch (nextError) {
      setError(
        nextError instanceof Error ? nextError.message : "创建会话失败。",
      );
    } finally {
      setSubmitting(false);
    }
  }

  if (!workspaceId && needsOnboarding) {
    return (
      <ScreenScroll bottomPadding={56}>
        <LoadingBlock label="正在进入工作区创建流程..." />
      </ScreenScroll>
    );
  }

  return (
    <ScreenScroll
      topPadding={0}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => void loadData(true)}
        />
      }
    >
      <MobilePageHeader
        titleNode={
          <WorkspaceSwitcher
            workspaceName={workspaceName}
            activeWorkspaceId={workspaceId}
            workspaces={workspaces}
            onSelectWorkspace={setWorkspaceId}
            onCreateWorkspace={() => router.push("/workspace/create")}
          />
        }
        action={
          <MobileHeaderActions
            onSearch={() => router.push("/search")}
            onStartGroup={() => router.push("/contacts/group/new")}
            onAddFriend={() => router.push("/contacts/add")}
            onScan={() => router.push("/scan?intent=relationship")}
          />
        }
      />

      {loading ? (
        <SectionBlock>
          <LoadingBlock label="正在加载首页..." />
        </SectionBlock>
      ) : (
        <>
          <SectionBlock style={styles.quickComposerBlock}>
            <SectionTitleRow title="快捷发起" />
            <HomeQuickComposer
              actor={selectedActor}
              sending={submitting}
              disabled={actors.length === 0}
              onPressSelectActor={() => router.push("/actors/select")}
              onSend={handleStartConversation}
            />
            {actors.length === 0 ? (
              <Text style={styles.emptyHint}>当前工作区还没有可用角色。</Text>
            ) : null}
            {error ? <Text style={styles.error}>{error}</Text> : null}
          </SectionBlock>

          <SectionBlock>
            <SectionTitleRow
              title="最近会话"
              action={
                <Pressable onPress={() => router.push("/chats")}>
                  <Text style={styles.linkText}>查看全部</Text>
                </Pressable>
              }
            />
            {conversations.length > 0 ? (
              <View style={styles.listShell}>
                {conversations.slice(0, 3).map((conversation) => (
                  <ConversationItem
                    key={conversation.id}
                    conversation={conversation}
                    onPress={() => router.push(`/chat/${conversation.id}`)}
                  />
                ))}
              </View>
            ) : (
              <EmptyState
                icon="message-square"
                title="还没有会话"
                description="先通过上面的输入框发起第一条消息。"
              />
            )}
          </SectionBlock>
        </>
      )}
    </ScreenScroll>
  );
}

const styles = StyleSheet.create({
  quickComposerBlock: {
    borderTopWidth: 0,
  },
  emptyHint: {
    fontSize: 13,
    color: theme.colors.textSoft,
  },
  error: {
    fontSize: 13,
    color: theme.colors.danger,
  },
  linkText: {
    fontSize: 13,
    fontWeight: "700",
    color: theme.colors.primary,
  },
  listShell: {
    marginTop: 2,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
});
