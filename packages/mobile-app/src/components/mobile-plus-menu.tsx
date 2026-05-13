import Feather from "@expo/vector-icons/Feather"
import { useState } from "react"
import { Modal, Pressable, StyleSheet, Text, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"

import { theme } from "@/theme/tokens"

type MobilePlusMenuAction = {
  key: string
  label: string
  icon: keyof typeof Feather.glyphMap
  onPress: () => void
}

export function MobilePlusMenu({
  onStartGroup,
  onAddFriend,
  onScan,
}: {
  onStartGroup: () => void
  onAddFriend: () => void
  onScan: () => void
}) {
  const insets = useSafeAreaInsets()
  const [open, setOpen] = useState(false)

  const actions: MobilePlusMenuAction[] = [
    {
      key: "group",
      label: "发起群聊",
      icon: "users",
      onPress: onStartGroup,
    },
    {
      key: "friend",
      label: "添加好友",
      icon: "user-plus",
      onPress: onAddFriend,
    },
    {
      key: "scan",
      label: "扫一扫",
      icon: "camera",
      onPress: onScan,
    },
  ]

  function handleSelect(action: MobilePlusMenuAction) {
    setOpen(false)
    action.onPress()
  }

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="打开快捷操作"
        onPress={() => setOpen(true)}
        style={({ pressed }) => [
          styles.trigger,
          pressed && styles.triggerPressed,
        ]}
      >
        <Feather name="plus" size={20} color={theme.colors.text} />
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
                top: insets.top + 46,
              },
            ]}
          >
            {actions.map((action) => (
              <Pressable
                key={action.key}
                onPress={() => handleSelect(action)}
                style={({ pressed }) => [
                  styles.menuAction,
                  pressed && styles.menuActionPressed,
                ]}
              >
                <Feather
                  name={action.icon}
                  size={18}
                  color={theme.colors.text}
                />
                <Text style={styles.menuLabel}>{action.label}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      </Modal>
    </>
  )
}

const styles = StyleSheet.create({
  trigger: {
    paddingVertical: 2,
    paddingHorizontal: 2,
  },
  triggerPressed: {
    opacity: 0.55,
  },
  modalRoot: {
    flex: 1,
    backgroundColor: "rgba(15, 23, 42, 0.12)",
  },
  menu: {
    position: "absolute",
    right: 18,
    minWidth: 168,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: "rgba(255,255,255,0.98)",
    paddingVertical: 6,
    shadowColor: theme.colors.text,
    shadowOpacity: 0.12,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 10 },
    elevation: 12,
  },
  menuAction: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  menuActionPressed: {
    backgroundColor: theme.colors.backgroundAlt,
  },
  menuLabel: {
    fontSize: 15,
    fontWeight: "600",
    color: theme.colors.text,
  },
})
