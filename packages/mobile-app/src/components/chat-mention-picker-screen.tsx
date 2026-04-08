import Feather from "@expo/vector-icons/Feather";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useMemo, useState } from "react";
import {
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import {
  AlphabetIndexedEntityList,
  type AlphabetIndexedEntityItem,
} from "@/components/alphabet-indexed-entity-list";
import { EmptyState, ScreenView } from "@/components/ui";
import { publishMentionSelection } from "@/lib/chat-mention-selection";
import {
  getConversationViewerParticipant,
  getMentionableConversationParticipants,
  participantToConversationEntityRef,
} from "@/lib/chat-data";
import { useChat } from "@/providers/chat-provider";
import { theme } from "@/theme/tokens";

function buildParticipantSubtitle(participant: {
  participantType:
    | "actor"
    | "remote_agent"
    | "workspace_member"
    | "external"
    | "system";
  title?: string;
  role?: string;
}) {
  const fallback =
    participant.participantType === "actor" ||
    participant.participantType === "remote_agent"
      ? "工作区 Actor"
      : participant.participantType === "external"
        ? "外部联系人"
        : "工作区成员";

  return participant.title?.trim() || participant.role?.trim() || fallback;
}

export function ChatMentionPickerScreen() {
  const router = useRouter();
  const { conversationId } = useLocalSearchParams<{ conversationId: string }>();
  const { getConversation, workspaceMemberId } = useChat();
  const [query, setQuery] = useState("");

  const conversation = conversationId ? getConversation(conversationId) : null;
  const viewerParticipantId = getConversationViewerParticipant(
    conversation,
    workspaceMemberId,
  )?.participantId;

  const participants = useMemo(
    () =>
      getMentionableConversationParticipants(conversation, viewerParticipantId),
    [conversation, viewerParticipantId],
  );

  const filteredParticipants = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) {
      return participants;
    }

    return participants.filter((participant) => {
      const haystack = [
        participant.name,
        participant.title,
        participant.role,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(trimmed);
    });
  }, [participants, query]);

  const items = useMemo<AlphabetIndexedEntityItem[]>(
    () =>
      filteredParticipants.map((participant) => ({
        key: participant.participantId,
        title: participant.name,
        subtitle: buildParticipantSubtitle(participant),
        avatarUrl: participant.avatarUrl || null,
        targetType: participant.participantType === "actor" ? "actor" : "user",
        onPress: () => {
          if (!conversationId) {
            return;
          }

          publishMentionSelection(
            conversationId,
            participantToConversationEntityRef(participant),
          );
          router.back();
        },
      })),
    [conversationId, filteredParticipants, router],
  );

  return (
    <ScreenView>
      <View style={styles.screen}>
        <View style={styles.header}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="返回"
            hitSlop={8}
            onPress={() => router.back()}
            style={({ pressed }) => [
              styles.headerNav,
              pressed && styles.headerNavPressed,
            ]}
          >
            <Feather name="chevron-left" size={22} color={theme.colors.text} />
          </Pressable>

          <Text numberOfLines={1} style={styles.headerTitle}>
            选择提醒对象
          </Text>

          <View style={styles.headerSpacer} />
        </View>

        <View style={styles.searchWrap}>
          <Feather name="search" size={16} color={theme.colors.textSoft} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="搜索名称"
            placeholderTextColor={theme.colors.textSoft}
            style={styles.searchInput}
          />
        </View>

        {!conversation ? (
          <View style={styles.stateWrap}>
            <EmptyState
              icon="at-sign"
              title="当前无法选择提醒对象"
              description="会话还没同步下来，返回后重试一次。"
            />
          </View>
        ) : (
          <AlphabetIndexedEntityList
            items={items}
            bottomPadding={40}
            emptyState={
              <View style={styles.stateWrap}>
                <EmptyState
                  icon="at-sign"
                  title="当前没有可提醒的对象"
                  description={
                    query.trim()
                      ? "换个关键词试试。"
                      : "当前会话里还没有其他可选成员。"
                  }
                />
              </View>
            }
          />
        )}
      </View>
    </ScreenView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 18,
    paddingTop: 10,
    paddingBottom: 8,
  },
  headerNav: {
    width: 56,
    height: 40,
    justifyContent: "center",
    alignItems: "flex-start",
  },
  headerNavPressed: {
    opacity: 0.55,
  },
  headerTitle: {
    flex: 1,
    textAlign: "center",
    fontSize: 17,
    fontWeight: "700",
    color: theme.colors.text,
  },
  headerSpacer: {
    width: 56,
    height: 40,
  },
  searchWrap: {
    marginHorizontal: 18,
    marginBottom: 10,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    paddingHorizontal: 14,
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  searchInput: {
    flex: 1,
    minHeight: 44,
    fontSize: 15,
    color: theme.colors.text,
    paddingVertical: 10,
  },
  stateWrap: {
    paddingHorizontal: 18,
    paddingTop: 20,
  },
});
