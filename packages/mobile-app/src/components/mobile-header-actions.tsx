import Feather from "@expo/vector-icons/Feather"
import { Pressable, StyleSheet, View } from "react-native"

import { MobilePlusMenu } from "@/components/mobile-plus-menu"
import { theme } from "@/theme/tokens"

export function MobileHeaderActions({
  onSearch,
  onStartGroup,
  onAddFriend,
  onScan,
  extraAction,
}: {
  onSearch: () => void
  onStartGroup: () => void
  onAddFriend: () => void
  onScan: () => void
  extraAction?: React.ReactNode
}) {
  return (
    <View style={styles.row}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="搜索"
        onPress={onSearch}
        style={({ pressed }) => [
          styles.searchTrigger,
          pressed && styles.pressed,
        ]}
      >
        <Feather name="search" size={20} color={theme.colors.text} />
      </Pressable>
      {extraAction}
      <MobilePlusMenu
        onStartGroup={onStartGroup}
        onAddFriend={onAddFriend}
        onScan={onScan}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  searchTrigger: {
    paddingVertical: 2,
    paddingHorizontal: 2,
  },
  pressed: {
    opacity: 0.55,
  },
})
