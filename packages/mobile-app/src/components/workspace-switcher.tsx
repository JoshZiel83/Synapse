import Feather from "@expo/vector-icons/Feather";
import { useState } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { theme } from "@/theme/tokens";
import type { WorkspaceInfo } from "@/types/api";

export function WorkspaceSwitcher({
  workspaceName,
  activeWorkspaceId,
  workspaces,
  onSelectWorkspace,
  onCreateWorkspace,
}: {
  workspaceName: string | null;
  activeWorkspaceId: string | null;
  workspaces: WorkspaceInfo[];
  onSelectWorkspace: (workspaceId: string) => Promise<void>;
  onCreateWorkspace: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [open, setOpen] = useState(false);
  const [switchingWorkspaceId, setSwitchingWorkspaceId] = useState<string | null>(
    null,
  );
  const otherWorkspaces = workspaces.filter(
    (workspace) => workspace.id !== activeWorkspaceId,
  );

  async function handleSelectWorkspace(workspaceId: string) {
    if (workspaceId === activeWorkspaceId) {
      setOpen(false);
      return;
    }

    setSwitchingWorkspaceId(workspaceId);
    try {
      await onSelectWorkspace(workspaceId);
      setOpen(false);
    } finally {
      setSwitchingWorkspaceId(null);
    }
  }

  function handleCreateWorkspace() {
    setOpen(false);
    onCreateWorkspace();
  }

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="切换工作区"
        onPress={() => setOpen(true)}
        style={({ pressed }) => [
          styles.trigger,
          pressed && styles.triggerPressed,
        ]}
      >
        <Text numberOfLines={1} style={styles.triggerLabel}>
          {workspaceName || "选择工作区"}
        </Text>
        <Feather
          name={open ? "chevron-up" : "chevron-down"}
          size={18}
          color={theme.colors.text}
        />
      </Pressable>

      <Modal
        animationType="fade"
        visible={open}
        transparent
        onRequestClose={() => setOpen(false)}
      >
        <View style={styles.modalRoot}>
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={() => setOpen(false)}
          />

          <View
            style={[
              styles.menu,
              {
                top: insets.top + 48,
              },
            ]}
          >
            <View style={styles.menuList}>
              {otherWorkspaces.map((workspace) => {
                const switching = workspace.id === switchingWorkspaceId;
                return (
                  <Pressable
                    key={workspace.id}
                    onPress={() => void handleSelectWorkspace(workspace.id)}
                    style={({ pressed }) => [
                      styles.menuItem,
                      pressed && styles.menuItemPressed,
                    ]}
                  >
                    <Text style={styles.menuItemTitle}>{workspace.name}</Text>
                    {switching ? (
                      <Text style={styles.switchingText}>切换中</Text>
                    ) : null}
                  </Pressable>
                );
              })}
            </View>

            <Pressable
              onPress={handleCreateWorkspace}
              style={({ pressed }) => [
                styles.createAction,
                pressed && styles.createActionPressed,
              ]}
            >
              <Feather name="plus" size={16} color={theme.colors.primary} />
              <Text style={styles.createActionText}>新建工作区</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  trigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    alignSelf: "flex-start",
    maxWidth: "100%",
  },
  triggerPressed: {
    opacity: 0.55,
  },
  triggerLabel: {
    flexShrink: 1,
    fontSize: 18,
    lineHeight: 22,
    fontWeight: "800",
    color: theme.colors.text,
  },
  modalRoot: {
    flex: 1,
    backgroundColor: "rgba(15, 23, 42, 0.12)",
  },
  menu: {
    position: "absolute",
    left: 18,
    right: 18,
    maxWidth: 280,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: "rgba(255,255,255,0.98)",
    paddingVertical: 8,
    boxShadow: "0 20px 44px rgba(15, 23, 42, 0.12)",
  },
  menuList: {
    gap: 2,
  },
  menuItem: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  menuItemPressed: {
    backgroundColor: theme.colors.backgroundAlt,
  },
  menuItemTitle: {
    fontSize: 15,
    fontWeight: "600",
    color: theme.colors.text,
  },
  switchingText: {
    fontSize: 12,
    fontWeight: "700",
    color: theme.colors.textSoft,
  },
  createAction: {
    marginTop: 4,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-start",
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  createActionPressed: {
    backgroundColor: theme.colors.backgroundAlt,
  },
  createActionText: {
    fontSize: 14,
    fontWeight: "700",
    color: theme.colors.primary,
  },
});
