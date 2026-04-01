import { useRouter } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import {
  Modal,
  PanResponder,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import Feather from "@expo/vector-icons/Feather";

import { MobileHeaderActions } from "@/components/mobile-header-actions";
import {
  Avatar,
  Button,
  EmptyState,
  LoadingBlock,
  Pill,
  ScreenView,
  MobilePageHeader,
  SectionBlock,
} from "@/components/ui";
import { api } from "@/lib/api";
import { useWorkspace } from "@/providers/workspace-provider";
import { theme } from "@/theme/tokens";
import type { ContactHubEntryView, ContactHubResponse } from "@/types/api";

type ContactFilter = "all" | "friend" | "actor" | "workspace-member";

type ContactSection = {
  letter: string;
  items: ContactHubEntryView[];
};

const FILTER_OPTIONS: Array<{ value: ContactFilter; label: string }> = [
  { value: "all", label: "默认" },
  { value: "friend", label: "好友" },
  { value: "actor", label: "Actor" },
  { value: "workspace-member", label: "Workspace Member" },
];

const LETTER_RAIL = [
  ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  "#",
];

const PINYIN_INITIAL_BOUNDARIES: Array<{ letter: string; boundary: string }> = [
  { letter: "A", boundary: "阿" },
  { letter: "B", boundary: "八" },
  { letter: "C", boundary: "嚓" },
  { letter: "D", boundary: "哒" },
  { letter: "E", boundary: "妸" },
  { letter: "F", boundary: "发" },
  { letter: "G", boundary: "旮" },
  { letter: "H", boundary: "哈" },
  { letter: "J", boundary: "击" },
  { letter: "K", boundary: "喀" },
  { letter: "L", boundary: "垃" },
  { letter: "M", boundary: "妈" },
  { letter: "N", boundary: "拿" },
  { letter: "O", boundary: "哦" },
  { letter: "P", boundary: "啪" },
  { letter: "Q", boundary: "期" },
  { letter: "R", boundary: "然" },
  { letter: "S", boundary: "撒" },
  { letter: "T", boundary: "塌" },
  { letter: "W", boundary: "挖" },
  { letter: "X", boundary: "昔" },
  { letter: "Y", boundary: "压" },
  { letter: "Z", boundary: "匝" },
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

function getInitialLetter(value: string) {
  const first = value.trim().charAt(0);
  if (!first) return "#";

  const upper = first.toUpperCase();
  if (/^[A-Z]$/.test(upper)) return upper;

  if (/^[\u4E00-\u9FFF]$/.test(first)) {
    for (let index = PINYIN_INITIAL_BOUNDARIES.length - 1; index >= 0; index -= 1) {
      const current = PINYIN_INITIAL_BOUNDARIES[index];
      if (current && compareText(first, current.boundary) >= 0) {
        return current.letter;
      }
    }
    return "A";
  }

  return "#";
}

function getEntryBucket(entry: ContactHubEntryView) {
  return getInitialLetter(entry.title);
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

function ContactRow({
  entry,
  onPress,
}: {
  entry: ContactHubEntryView;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.rowCard,
        pressed && styles.rowCardPressed,
      ]}
    >
      <View style={styles.avatarShell}>
        <Avatar
          name={entry.title}
          uri={entry.avatarUrl}
          icon={entry.targetType === "actor" ? "cpu" : "user"}
          size={40}
        />
        {entry.targetType === "actor" ? (
          <View style={styles.actorBadge}>
            <MaterialCommunityIcons
              name="robot-outline"
              size={11}
              color={theme.colors.white}
            />
          </View>
        ) : null}
      </View>
      <View style={styles.rowBody}>
        <Text style={styles.rowTitle}>{entry.title}</Text>
        <Text numberOfLines={2} style={styles.rowSubtitle}>
          {entry.subtitle || entry.workspace.name}
        </Text>
      </View>
      {isFriendEntry(entry) ? <Pill label="好友" tone="primary" /> : null}
    </Pressable>
  );
}

export default function ContactsTab() {
  const router = useRouter();
  const { workspaceId } = useWorkspace();
  const scrollRef = useRef<ScrollView | null>(null);
  const letterOffsetsRef = useRef<Record<string, number>>({});
  const [hub, setHub] = useState<ContactHubResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<ContactFilter>("all");
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  const [railHeight, setRailHeight] = useState(0);
  const [activeLetter, setActiveLetter] = useState<string | null>(null);

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

  const sections = useMemo<ContactSection[]>(() => {
    const grouped = new Map<string, ContactHubEntryView[]>();
    for (const entry of filteredEntries) {
      const letter = getEntryBucket(entry);
      if (!grouped.has(letter)) {
        grouped.set(letter, []);
      }
      grouped.get(letter)!.push(entry);
    }

    return LETTER_RAIL.filter((letter) => grouped.has(letter)).map((letter) => ({
      letter,
      items: grouped.get(letter) || [],
    }));
  }, [filteredEntries]);

  const filterLabel =
    FILTER_OPTIONS.find((option) => option.value === filter)?.label || "默认";
  const pendingRequestCount = hub?.requestSummary.totalPendingCount || 0;

  function scrollToLetter(letter: string) {
    const offset = letterOffsetsRef.current[letter];
    if (typeof offset !== "number") return;
    setActiveLetter(letter);
    scrollRef.current?.scrollTo({ y: Math.max(offset - 10, 0), animated: false });
  }

  function activateRailByLocation(locationY: number) {
    if (!railHeight) return;
    const index = Math.min(
      LETTER_RAIL.length - 1,
      Math.max(0, Math.floor((locationY / railHeight) * LETTER_RAIL.length)),
    );
    const letter = LETTER_RAIL[index]!;
    scrollToLetter(letter);
  }

  const railResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (event) => {
          activateRailByLocation(event.nativeEvent.locationY);
        },
        onPanResponderMove: (event) => {
          activateRailByLocation(event.nativeEvent.locationY);
        },
      }),
    [railHeight],
  );

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
                onScan={() => router.push("/scan?intent=relationship")}
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
                    <Feather
                      name="bell"
                      size={20}
                      color={theme.colors.text}
                    />
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

        <ScrollView
          ref={scrollRef}
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => void loadHub(true)}
            />
          }
        >
          {loading ? (
            <SectionBlock>
              <LoadingBlock label="正在加载联系人..." />
            </SectionBlock>
          ) : error ? (
            <SectionBlock>
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
            </SectionBlock>
          ) : (
            <View style={styles.listSection}>
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

              {filteredEntries.length > 0 ? (
                <View style={styles.listCard}>
                  {sections.map((section) => (
                    <View
                      key={section.letter}
                      onLayout={(event) => {
                        letterOffsetsRef.current[section.letter] =
                          event.nativeEvent.layout.y;
                      }}
                    >
                      <View style={styles.letterHeader}>
                        <Text style={styles.letterHeaderText}>{section.letter}</Text>
                      </View>
                      {section.items.map((entry) => (
                        <ContactRow
                          key={`${entry.kind}:${entry.id}`}
                          entry={entry}
                          onPress={() =>
                            router.push({
                              pathname: "/contacts/[contactType]/[contactId]",
                              params: {
                                contactType: entry.kind,
                                contactId: entry.id,
                              },
                            })
                          }
                        />
                      ))}
                    </View>
                  ))}
                </View>
              ) : (
                <EmptyState
                  icon="users"
                  title="当前分类下没有联系人"
                  description="切换分类，或者通过右上角 + 添加好友。"
                />
              )}
            </View>
          )}
        </ScrollView>

        {!loading && !error && sections.length > 0 ? (
          <View
            style={styles.letterRail}
            onLayout={(event) => setRailHeight(event.nativeEvent.layout.height)}
            {...railResponder.panHandlers}
          >
            {LETTER_RAIL.map((letter) => {
              const enabled = sections.some((section) => section.letter === letter);
              return (
                <Pressable
                  key={letter}
                  onPress={() => scrollToLetter(letter)}
                  disabled={!enabled}
                  style={styles.letterRailItem}
                >
                  <Text
                    style={[
                      styles.letterRailText,
                      !enabled && styles.letterRailTextMuted,
                      activeLetter === letter && styles.letterRailTextActive,
                    ]}
                  >
                    {letter}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        ) : null}
      </View>

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
                  <Feather
                    name="check"
                    size={16}
                    color={theme.colors.primary}
                  />
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
    position: "relative",
  },
  headerGutter: {
    paddingHorizontal: 18,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingTop: 16,
    paddingBottom: 120,
    paddingHorizontal: 18,
  },
  retryAction: {
    marginTop: 10,
    width: "100%",
  },
  countText: {
    fontSize: 12,
    fontWeight: "700",
    color: theme.colors.textSoft,
  },
  listSection: {
    paddingBottom: 8,
  },
  headerRequestTrigger: {
    paddingVertical: 2,
    paddingHorizontal: 2,
  },
  headerRequestBadge: {
    position: "absolute",
    top: -4,
    right: -8,
    minWidth: 16,
    height: 16,
    paddingHorizontal: 3,
    borderRadius: 999,
    backgroundColor: theme.colors.danger,
    alignItems: "center",
    justifyContent: "center",
  },
  headerRequestBadgeText: {
    fontSize: 9,
    fontWeight: "800",
    color: theme.colors.white,
  },
  filterRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 10,
  },
  filterTrigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingVertical: 2,
  },
  filterTriggerPressed: {
    opacity: 0.72,
  },
  filterLabel: {
    fontSize: 14,
    fontWeight: "700",
    color: theme.colors.text,
  },
  listCard: {
    backgroundColor: theme.colors.surface,
  },
  letterHeader: {
    marginHorizontal: -18,
    paddingHorizontal: 18,
    paddingVertical: 7,
    backgroundColor: theme.colors.backgroundAlt,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  letterHeaderText: {
    fontSize: 12,
    fontWeight: "800",
    color: theme.colors.textSoft,
    letterSpacing: 1.2,
  },
  rowCard: {
    marginHorizontal: -18,
    paddingHorizontal: 18,
    paddingVertical: 11,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: theme.colors.surface,
  },
  rowCardPressed: {
    backgroundColor: theme.colors.backgroundAlt,
  },
  rowBody: {
    flex: 1,
    gap: 4,
  },
  avatarShell: {
    position: "relative",
    width: 40,
    height: 40,
  },
  actorBadge: {
    position: "absolute",
    right: -3,
    bottom: -3,
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: theme.colors.surface,
    backgroundColor: theme.colors.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  rowTitle: {
    fontSize: 14,
    fontWeight: "700",
    color: theme.colors.text,
  },
  rowSubtitle: {
    fontSize: 12,
    lineHeight: 17,
    color: theme.colors.textMuted,
  },
  letterRail: {
    position: "absolute",
    right: 4,
    top: 150,
    bottom: 30,
    width: 22,
    alignItems: "center",
    justifyContent: "center",
    gap: 1,
  },
  letterRailItem: {
    width: 22,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 1,
  },
  letterRailText: {
    fontSize: 10,
    fontWeight: "700",
    color: theme.colors.primary,
  },
  letterRailTextMuted: {
    color: theme.colors.borderStrong,
  },
  letterRailTextActive: {
    color: theme.colors.accent,
  },
  modalRoot: {
    flex: 1,
    backgroundColor: "rgba(15, 23, 42, 0.12)",
    justifyContent: "flex-start",
    paddingTop: 120,
    paddingHorizontal: 18,
  },
  filterMenu: {
    width: 210,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    overflow: "hidden",
  },
  filterOption: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
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
