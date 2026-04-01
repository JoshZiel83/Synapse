import Feather from "@expo/vector-icons/Feather";
import { useRouter } from "expo-router";
import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import {
  Avatar,
  Button,
  EmptyState,
  LoadingBlock,
  ScreenScroll,
  SectionBlock,
} from "@/components/ui";
import { api } from "@/lib/api";
import { useWorkspace } from "@/providers/workspace-provider";
import { theme } from "@/theme/tokens";
import type { IdentitySearchMatchView } from "@/types/api";

function buildSearchDetailParams(match: IdentitySearchMatchView) {
  return {
    pathname: "/contacts/search/[profileId]" as const,
    params: {
      profileId: match.profileId,
      title: match.title,
      subtitle: match.subtitle || "",
      avatarUrl: match.avatarUrl || "",
      workspaceName: match.workspace.name,
      workspaceSlug: match.workspace.slug,
      state: match.state,
    },
  };
}

function resultStateLabel(match: IdentitySearchMatchView) {
  switch (match.state) {
    case "same_workspace_member":
      return "同 workspace 用户";
    case "friend":
      return "已是好友";
    case "pending_request":
      return "好友申请待处理";
    default:
      return "可查看并发起好友申请";
  }
}

export default function AddFriendScreen() {
  const router = useRouter();
  const { workspaceId } = useWorkspace();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<IdentitySearchMatchView[]>([]);
  const [searching, setSearching] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function handleSearch() {
    if (!workspaceId) return;

    setSearching(true);
    setMessage(null);
    try {
      const result = await api.searchIdentity(workspaceId, query);

      if (result.outcome === "empty") {
        setResults([]);
        setMessage("请输入好友 ID。");
        return;
      }
      if (result.outcome === "invalid") {
        setResults([]);
        setMessage("好友 ID 需为 4-32 位，只能包含字母、数字、点、下划线或短横线。");
        return;
      }
      if (result.outcome === "self") {
        setResults([]);
        setMessage("这是你自己的好友 ID。");
        return;
      }
      if (result.outcome === "not_found" || result.matches.length === 0) {
        setResults([]);
        setMessage("没有找到结果。对方可能关闭了 ID 搜索。");
        return;
      }

      setResults(result.matches);
      if (result.matches.length === 1) {
        const match = result.matches[0]!;
        if (match.contact) {
          router.push({
            pathname: "/contacts/[contactType]/[contactId]",
            params: {
              contactType: match.contact.kind,
              contactId: match.contact.id,
            },
          });
          return;
        }

        router.push(buildSearchDetailParams(match));
        return;
      }

      setMessage("同一个账号在多个 workspace 中可被添加，请选择具体身份。");
    } catch (error) {
      setResults([]);
      setMessage(error instanceof Error ? error.message : "搜索好友失败。");
    } finally {
      setSearching(false);
    }
  }

  function handleSelectMatch(match: IdentitySearchMatchView) {
    if (match.contact) {
      router.push({
        pathname: "/contacts/[contactType]/[contactId]",
        params: {
          contactType: match.contact.kind,
          contactId: match.contact.id,
        },
      });
      return;
    }

    router.push(buildSearchDetailParams(match));
  }

  return (
    <ScreenScroll topPadding={0} bottomPadding={56}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.headerButton}>
          <Feather name="chevron-left" size={20} color={theme.colors.text} />
        </Pressable>
        <Text numberOfLines={1} style={styles.headerTitle}>
          添加好友
        </Text>
        <View style={styles.headerSpacer} />
      </View>

      <SectionBlock>
        <Text style={styles.tipText}>
          输入对方的好友 ID。查到后会进入联系人详情；如果没有结果，会直接在这里提示。
        </Text>
        <View style={styles.searchShell}>
          <Feather name="search" size={16} color={theme.colors.textSoft} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="输入好友 ID"
            placeholderTextColor={theme.colors.textSoft}
            style={styles.searchInput}
            onSubmitEditing={() => void handleSearch()}
          />
        </View>
        <Button
          label={searching ? "搜索中..." : "搜索好友 ID"}
          icon="search"
          onPress={() => void handleSearch()}
          disabled={searching}
        />
      </SectionBlock>

      {searching ? (
        <SectionBlock>
          <LoadingBlock label="正在搜索好友..." />
        </SectionBlock>
      ) : message && results.length === 0 ? (
        <SectionBlock>
          <EmptyState
            icon="search"
            title="搜索结果"
            description={message}
          />
        </SectionBlock>
      ) : results.length > 1 ? (
        <SectionBlock>
          <View style={styles.listShell}>
            {results.map((match) => (
              <Pressable
                key={match.profileId}
                onPress={() => handleSelectMatch(match)}
                style={({ pressed }) => [
                  styles.resultRow,
                  pressed && styles.resultRowPressed,
                ]}
              >
                <Avatar
                  name={match.title}
                  uri={match.avatarUrl}
                  size={46}
                  icon="user"
                />
                <View style={styles.resultBody}>
                  <Text style={styles.resultTitle}>{match.title}</Text>
                  <Text numberOfLines={2} style={styles.resultSubtitle}>
                    {match.subtitle}
                  </Text>
                  <Text style={styles.resultMeta}>{resultStateLabel(match)}</Text>
                </View>
                <Feather
                  name="chevron-right"
                  size={18}
                  color={theme.colors.textSoft}
                />
              </Pressable>
            ))}
          </View>
        </SectionBlock>
      ) : null}
    </ScreenScroll>
  );
}

const styles = StyleSheet.create({
  header: {
    marginHorizontal: -18,
    paddingHorizontal: 18,
    paddingBottom: 10,
    minHeight: 62,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 12,
  },
  headerButton: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
  },
  headerTitle: {
    flex: 1,
    fontSize: 22,
    fontWeight: "800",
    color: theme.colors.text,
  },
  headerSpacer: {
    width: 32,
  },
  tipText: {
    fontSize: 14,
    lineHeight: 21,
    color: theme.colors.textMuted,
  },
  searchShell: {
    marginTop: 12,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    paddingHorizontal: 14,
    paddingVertical: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    color: theme.colors.text,
  },
  listShell: {
    marginTop: 2,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  resultRow: {
    marginHorizontal: -18,
    paddingHorizontal: 18,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  resultRowPressed: {
    backgroundColor: theme.colors.backgroundAlt,
  },
  resultBody: {
    flex: 1,
    gap: 4,
  },
  resultTitle: {
    fontSize: 15,
    fontWeight: "700",
    color: theme.colors.text,
  },
  resultSubtitle: {
    fontSize: 13,
    lineHeight: 18,
    color: theme.colors.textMuted,
  },
  resultMeta: {
    fontSize: 12,
    color: theme.colors.textSoft,
  },
});
