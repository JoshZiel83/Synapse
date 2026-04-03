import Feather from "@expo/vector-icons/Feather";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import {
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
import { EmptyState, LoadingBlock, ScreenView } from "@/components/ui";
import { api } from "@/lib/api";
import { useSession } from "@/providers/session-provider";
import { useWorkspace } from "@/providers/workspace-provider";
import { theme } from "@/theme/tokens";
import type { ContactHubEntryView, ContactHubResponse } from "@/types/api";
import type { Actor } from "@shared";

export type WorkspaceEntityPickerMode = "actor" | "group";

function getEntryKey(entry: ContactHubEntryView) {
  return `${entry.kind}:${entry.id}`;
}

function mapEntryTargetType(entry: ContactHubEntryView): "actor" | "user" {
  return entry.targetType === "actor" ? "actor" : "user";
}

function uniqueIds(values: Array<string | undefined>) {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value))));
}

function SelectionCircle({ selected }: { selected: boolean }) {
  return (
    <View style={[styles.selectionCircle, selected && styles.selectionCircleActive]}>
      {selected ? (
        <Feather name="check" size={14} color={theme.colors.white} />
      ) : null}
    </View>
  );
}

function PickerHeader({
  title,
  onBack,
  confirmVisible,
  confirmDisabled,
  confirmLabel,
  onConfirm,
}: {
  title: string;
  onBack: () => void;
  confirmVisible: boolean;
  confirmDisabled: boolean;
  confirmLabel: string;
  onConfirm: () => void;
}) {
  return (
    <View style={styles.header}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="返回"
        hitSlop={8}
        onPress={onBack}
        style={({ pressed }) => [styles.headerNav, pressed && styles.headerNavPressed]}
      >
        <Feather name="chevron-left" size={22} color={theme.colors.text} />
      </Pressable>

      <Text numberOfLines={1} style={styles.headerTitle}>
        {title}
      </Text>

      {confirmVisible ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={confirmLabel}
          hitSlop={8}
          onPress={onConfirm}
          disabled={confirmDisabled}
          style={({ pressed }) => [
            styles.headerAction,
            confirmDisabled && styles.headerActionDisabled,
            pressed && !confirmDisabled && styles.headerNavPressed,
          ]}
        >
          <Text
            style={[
              styles.headerActionText,
              confirmDisabled && styles.headerActionTextDisabled,
            ]}
          >
            {confirmLabel}
          </Text>
        </Pressable>
      ) : (
        <View style={styles.headerSpacer} />
      )}
    </View>
  );
}

export function WorkspaceEntityPickerScreen({
  mode,
}: {
  mode: WorkspaceEntityPickerMode;
}) {
  const router = useRouter();
  const { user } = useSession();
  const { workspaceId } = useWorkspace();
  const { actorId, workspaceMemberId, contactId } = useLocalSearchParams<{
    actorId?: string;
    workspaceMemberId?: string;
    contactId?: string;
  }>();
  const [actors, setActors] = useState<Actor[]>([]);
  const [hub, setHub] = useState<ContactHubResponse | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const initializedSelectionRef = useRef(false);

  useEffect(() => {
    initializedSelectionRef.current = false;
    setSelectedKeys([]);
  }, [mode, workspaceId]);

  async function loadData(isRefreshing = false) {
    if (!workspaceId) {
      setActors([]);
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
      if (mode === "actor") {
        const response = await api.getActors(workspaceId);
        setActors(response.actors.filter((actor) => actor.isActive));
        setHub(null);
      } else {
        const response = await api.getContactHub(workspaceId);
        setHub(response);
        setActors([]);
      }
      setError(null);
    } catch (nextError) {
      setError(
        nextError instanceof Error
          ? nextError.message
          : mode === "actor"
            ? "Actor 列表加载失败。"
            : "可选联系人加载失败。",
      );
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    void loadData();
  }, [mode, workspaceId]);

  const groupEntries = useMemo(
    () =>
      [
        ...(hub?.workspaceActors || []),
        ...(hub?.workspaceMembers || []).filter((entry) => entry.userId !== user?.id),
        ...(hub?.friends || []),
      ],
    [hub?.friends, hub?.workspaceActors, hub?.workspaceMembers, user?.id],
  );

  useEffect(() => {
    if (mode !== "group" || initializedSelectionRef.current || loading) {
      return;
    }

    const nextSelectedKeys = new Set<string>();

    for (const entry of groupEntries) {
      if (actorId && entry.actorId === actorId) {
        nextSelectedKeys.add(getEntryKey(entry));
      }
      if (workspaceMemberId && entry.workspaceMemberId === workspaceMemberId) {
        nextSelectedKeys.add(getEntryKey(entry));
      }
      if (contactId && entry.id === contactId) {
        nextSelectedKeys.add(getEntryKey(entry));
      }
    }

    setSelectedKeys(Array.from(nextSelectedKeys));
    initializedSelectionRef.current = true;
  }, [actorId, contactId, groupEntries, loading, mode, workspaceMemberId]);

  const selectedEntries = useMemo(
    () => groupEntries.filter((entry) => selectedKeys.includes(getEntryKey(entry))),
    [groupEntries, selectedKeys],
  );

  const selectedActorIds = useMemo(
    () => uniqueIds(selectedEntries.map((entry) => entry.actorId)),
    [selectedEntries],
  );

  const selectedWorkspaceMemberIds = useMemo(
    () => uniqueIds(selectedEntries.map((entry) => entry.workspaceMemberId)),
    [selectedEntries],
  );

  async function handleSelectActor(actor: Actor) {
    if (!workspaceId || submitting) return;

    setSubmitting(true);
    setError(null);
    try {
      await api.updateWorkspaceChiefActorPreference(workspaceId, {
        chiefActorId: actor.id,
      });
      router.replace({
        pathname: "/",
        params: {
          actorId: actor.id,
        },
      });
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "切换 Actor 失败。");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCreateGroup() {
    if (!workspaceId || selectedEntries.length === 0 || submitting) {
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      if (
        selectedEntries.some(
          (entry) => entry.targetType === "member" && !entry.workspaceMemberId,
        )
      ) {
        throw new Error("存在缺少 workspace 成员身份的联系人，暂时无法发起群聊。");
      }

      const created = await api.createThread(workspaceId, {
        kind: "group",
        actorIds: selectedActorIds,
        workspaceMemberIds: selectedWorkspaceMemberIds,
      });

      if (!created.conversationId) {
        throw new Error("服务器没有返回 conversationId");
      }

      router.replace(`/chat/${created.conversationId}`);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "发起群聊失败。");
    } finally {
      setSubmitting(false);
    }
  }

  const items = useMemo<AlphabetIndexedEntityItem[]>(() => {
    if (mode === "actor") {
      return actors.map((actor) => ({
        key: actor.id,
        title: actor.definition.name,
        subtitle:
          actor.definition.role || actor.definition.title || "工作区 Actor",
        avatarUrl: actor.avatarUrl || null,
        targetType: "actor",
        onPress: () => void handleSelectActor(actor),
      }));
    }

    return groupEntries.map((entry) => {
      const key = getEntryKey(entry);
      const selected = selectedKeys.includes(key);

      return {
        key,
        title: entry.title,
        subtitle: entry.subtitle || entry.workspace.name,
        avatarUrl: entry.avatarUrl || null,
        targetType: mapEntryTargetType(entry),
        leadingAccessory: <SelectionCircle selected={selected} />,
        onPress: () => {
          setSelectedKeys((current) =>
            current.includes(key)
              ? current.filter((item) => item !== key)
              : [...current, key],
          );
        },
      };
    });
  }, [actors, groupEntries, mode, selectedKeys, submitting, workspaceId]);

  const title = mode === "actor" ? "选择Actor" : "发起群聊";
  const emptyState = (
    <View style={styles.emptyWrap}>
      <EmptyState
        icon={mode === "actor" ? "cpu" : "users"}
        title={mode === "actor" ? "当前没有可选 Actor" : "当前没有可选对象"}
        description={
          mode === "actor"
            ? "请先在工作区里创建或启用一个 Actor。"
            : "当前工作区里还没有可以发起群聊的对象。"
        }
      />
    </View>
  );

  return (
    <ScreenView>
      <View style={styles.screen}>
        <PickerHeader
          title={title}
          onBack={() => router.back()}
          confirmVisible={mode === "group"}
          confirmDisabled={selectedEntries.length === 0 || submitting}
          confirmLabel="完成"
          onConfirm={() => void handleCreateGroup()}
        />

        {loading ? (
          <View style={styles.stateWrap}>
            <LoadingBlock
              label={mode === "actor" ? "正在加载 Actor..." : "正在加载可选对象..."}
            />
          </View>
        ) : error && items.length === 0 ? (
          <View style={styles.stateWrap}>
            <EmptyState
              icon="alert-circle"
              title={mode === "actor" ? "Actor 列表加载失败" : "群聊列表加载失败"}
              description={error}
            />
          </View>
        ) : (
          <AlphabetIndexedEntityList
            items={items}
            bottomPadding={72}
            refreshControl={
              <RefreshControl
                refreshing={refreshing}
                onRefresh={() => void loadData(true)}
              />
            }
            headerContent={
              error ? (
                <View style={styles.inlineError}>
                  <Text style={styles.inlineErrorText}>{error}</Text>
                </View>
              ) : null
            }
            emptyState={emptyState}
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
  headerAction: {
    width: 56,
    height: 40,
    justifyContent: "center",
    alignItems: "flex-end",
  },
  headerActionDisabled: {
    opacity: 0.45,
  },
  headerActionText: {
    fontSize: 15,
    fontWeight: "700",
    color: theme.colors.primary,
  },
  headerActionTextDisabled: {
    color: theme.colors.textSoft,
  },
  headerSpacer: {
    width: 56,
    height: 40,
  },
  stateWrap: {
    flex: 1,
    justifyContent: "center",
    paddingHorizontal: 18,
  },
  inlineError: {
    marginBottom: 12,
    paddingHorizontal: 2,
  },
  inlineErrorText: {
    fontSize: 13,
    lineHeight: 18,
    color: theme.colors.danger,
  },
  emptyWrap: {
    paddingHorizontal: 18,
    paddingTop: 24,
  },
  selectionCircle: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1.5,
    borderColor: theme.colors.borderStrong,
    alignItems: "center",
    justifyContent: "center",
  },
  selectionCircleActive: {
    borderColor: theme.colors.primary,
    backgroundColor: theme.colors.primary,
  },
});
