import Feather from "@expo/vector-icons/Feather";
import { useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import {
  Modal,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";

import {
  AlphabetIndexedEntityList,
  type AlphabetIndexedEntityItem,
} from "@/components/alphabet-indexed-entity-list";
import { MobileHeaderActions } from "@/components/mobile-header-actions";
import {
  Button,
  EmptyState,
  LoadingBlock,
  MobilePageHeader,
  Pill,
  ScreenView,
} from "@/components/ui";
import { useScanLauncher } from "@/hooks/use-scan-launcher";
import { api } from "@/lib/api";
import { useWorkspace } from "@/providers/workspace-provider";
import { theme } from "@/theme/tokens";
import type { ContactHubEntryView, ContactHubResponse } from "@/types/api";

type ContactFilter = "all" | "friend" | "actor" | "workspace-member";

const FILTER_OPTIONS: Array<{ value: ContactFilter; label: string }> = [
  { value: "all", label: "默认" },
  { value: "friend", label: "好友" },
  { value: "actor", label: "Actor" },
  { value: "workspace-member", label: "Workspace Member" },
];

function compareText(left: string, right: string) {
  try {
    return left.localeCompare(right, "zh-Hans-u-co-pinyin", {
      sensitivity: "base",
    });
  } catch {
    return left.localeCompare(right, undefined, {
      sensitivity: "base",
    });
  }
}

function compareEntries(left: ContactHubEntryView, right: ContactHubEntryView) {
  const titleCompare = compareText(left.title, right.title);
  if (titleCompare !== 0) return titleCompare;
  return compareText(left.subtitle || "", right.subtitle || "");
}

function isFriendEntry(entry: ContactHubEntryView) {
  return entry.kind.startsWith("friend");
}

function formatPendingCount(count: number) {
  return count > 99 ? "99+" : String(count);
}

export default function ContactsTabScreen() {
  const router = useRouter();
  const { openScan, permissionSheet } = useScanLauncher("relationship");
  const { workspaceId } = useWorkspace();
  const [hub, setHub] = useState<ContactHubResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<ContactFilter>("all");
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);

  async function loadHub(isRefreshing = false) {
    if (!workspaceId) {
      setHub(null);
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
      setHub(await api.getContactHub(workspaceId));
      setError(null);
    } catch (nextError) {
      setError(
        nextError instanceof Error ? nextError.message : "联系人加载失败。",
      );
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    void loadHub();
  }, [workspaceId]);

  const filteredEntries = useMemo(() => {
    const all = [
      ...(hub?.workspaceActors || []),
      ...(hub?.workspaceMembers || []),
      ...(hub?.friends || []),
    ];

    if (filter === "friend") {
      return [...(hub?.friends || [])].sort(compareEntries);
    }
    if (filter === "actor") {
      return [...(hub?.workspaceActors || [])].sort(compareEntries);
    }
    if (filter === "workspace-member") {
      return [...(hub?.workspaceMembers || [])].sort(compareEntries);
    }
    return [...all].sort(compareEntries);
  }, [filter, hub?.friends, hub?.workspaceActors, hub?.workspaceMembers]);

  const items = useMemo<AlphabetIndexedEntityItem[]>(
    () =>
      filteredEntries.map((entry) => ({
        key: `${entry.kind}:${entry.id}`,
        title: entry.title,
        subtitle: entry.subtitle || entry.workspace.name,
        avatarUrl: entry.avatarUrl || null,
        targetType: entry.targetType === "actor" ? "actor" : "user",
        trailingAccessory: isFriendEntry(entry) ? (
          <Pill label="好友" tone="primary" />
        ) : undefined,
        onPress: () =>
          router.push({
            pathname: "/contacts/[contactType]/[contactId]",
            params: {
              contactType: entry.kind,
              contactId: entry.id,
            },
          }),
      })),
    [filteredEntries, router],
  );

  const filterLabel =
    FILTER_OPTIONS.find((option) => option.value === filter)?.label || "默认";
  const pendingRequestCount = hub?.requestSummary.totalPendingCount || 0;

  return (
    <ScreenView>
      <View style={styles.pageShell}>
        <View style={styles.headerGutter}>
          <MobilePageHeader
            title="联系人"
            action={
              <MobileHeaderActions
                onSearch={() => router.push("/search")}
                onStartGroup={() => router.push("/contacts/group/new")}
                onAddFriend={() => router.push("/contacts/add")}
                onScan={() => void openScan()}
                extraAction={
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="好友申请"
                    onPress={() => router.push("/contacts/requests")}
                    style={({ pressed }) => [
                      styles.headerRequestTrigger,
                      pressed && styles.filterTriggerPressed,
                    ]}
                  >
                    <Feather name="bell" size={20} color={theme.colors.text} />
                    {pendingRequestCount > 0 ? (
                      <View style={styles.headerRequestBadge}>
                        <Text style={styles.headerRequestBadgeText}>
                          {formatPendingCount(pendingRequestCount)}
                        </Text>
                      </View>
                    ) : null}
                  </Pressable>
                }
              />
            }
          />
        </View>

        {loading ? (
          <View style={styles.stateWrap}>
            <LoadingBlock label="正在加载联系人..." />
          </View>
        ) : error ? (
          <View style={styles.stateWrap}>
            <EmptyState
              icon="alert-circle"
              title="联系人加载失败"
              description={error}
              action={
                <View style={styles.retryAction}>
                  <Button
                    label="重试"
                    icon="refresh-cw"
                    onPress={() => void loadHub()}
                  />
                </View>
              }
            />
          </View>
        ) : (
          <AlphabetIndexedEntityList
            items={items}
            refreshControl={
              <RefreshControl
                refreshing={refreshing}
                onRefresh={() => void loadHub(true)}
              />
            }
            headerContent={
              <View style={styles.filterRow}>
                <Pressable
                  onPress={() => setFilterMenuOpen(true)}
                  style={({ pressed }) => [
                    styles.filterTrigger,
                    pressed && styles.filterTriggerPressed,
                  ]}
                >
                  <Text style={styles.filterLabel}>{filterLabel}</Text>
                  <Feather
                    name="chevron-down"
                    size={16}
                    color={theme.colors.textSoft}
                  />
                </Pressable>
                <Text style={styles.countText}>{filteredEntries.length} 人</Text>
              </View>
            }
            emptyState={
              <View style={styles.emptyWrap}>
                <EmptyState
                  icon="users"
                  title="当前分类下没有联系人"
                  description="切换分类，或者通过右上角 + 添加好友。"
                />
              </View>
            }
          />
        )}
      </View>
      {permissionSheet}

      <Modal
        visible={filterMenuOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setFilterMenuOpen(false)}
      >
        <View style={styles.modalRoot}>
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={() => setFilterMenuOpen(false)}
          />
          <View style={styles.filterMenu}>
            {FILTER_OPTIONS.map((option) => (
              <Pressable
                key={option.value}
                onPress={() => {
                  setFilter(option.value);
                  setFilterMenuOpen(false);
                }}
                style={({ pressed }) => [
                  styles.filterOption,
                  pressed && styles.filterOptionPressed,
                ]}
              >
                <Text
                  style={[
                    styles.filterOptionText,
                    filter === option.value && styles.filterOptionTextActive,
                  ]}
                >
                  {option.label}
                </Text>
                {filter === option.value ? (
                  <Feather name="check" size={16} color={theme.colors.primary} />
                ) : null}
              </Pressable>
            ))}
          </View>
        </View>
      </Modal>
    </ScreenView>
  );
}

const styles = StyleSheet.create({
  pageShell: {
    flex: 1,
  },
  headerGutter: {
    paddingHorizontal: 18,
  },
  stateWrap: {
    flex: 1,
    justifyContent: "center",
    paddingHorizontal: 18,
  },
  retryAction: {
    marginTop: 10,
    width: "100%",
  },
  filterRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingBottom: 12,
  },
  filterTrigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 2,
  },
  filterTriggerPressed: {
    opacity: 0.75,
  },
  filterLabel: {
    fontSize: 14,
    fontWeight: "700",
    color: theme.colors.text,
  },
  countText: {
    fontSize: 13,
    color: theme.colors.textSoft,
  },
  emptyWrap: {
    paddingTop: 24,
  },
  headerRequestTrigger: {
    width: 24,
    height: 24,
    alignItems: "center",
    justifyContent: "center",
  },
  headerRequestBadge: {
    position: "absolute",
    top: 4,
    right: 4,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    paddingHorizontal: 3,
    backgroundColor: theme.colors.danger,
    alignItems: "center",
    justifyContent: "center",
  },
  headerRequestBadgeText: {
    fontSize: 10,
    fontWeight: "800",
    color: theme.colors.white,
  },
  modalRoot: {
    flex: 1,
    backgroundColor: "rgba(15, 23, 42, 0.08)",
    justifyContent: "flex-start",
  },
  filterMenu: {
    marginTop: 96,
    marginHorizontal: 18,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: "rgba(255,255,255,0.98)",
    paddingVertical: 8,
    boxShadow: "0 20px 40px rgba(15, 23, 42, 0.12)",
  },
  filterOption: {
    minHeight: 44,
    paddingHorizontal: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  filterOptionPressed: {
    backgroundColor: theme.colors.backgroundAlt,
  },
  filterOptionText: {
    fontSize: 15,
    color: theme.colors.text,
  },
  filterOptionTextActive: {
    fontWeight: "700",
    color: theme.colors.primary,
  },
});
