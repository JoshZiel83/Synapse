import Feather from "@expo/vector-icons/Feather";
import { useEffect, useRef } from "react";
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { theme } from "@/theme/tokens";

const MENU_WIDTH = 144;
const MENU_HEIGHT = 98;

export function ChatMessageActionSheet({
  open,
  anchor,
  onClose,
  onQuote,
  onCopy,
}: {
  open: boolean;
  anchor: {
    x: number;
    y: number;
    mine: boolean;
  } | null;
  onClose: () => void;
  onQuote: () => void;
  onCopy: () => void;
}) {
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const openedAtRef = useRef(0);

  useEffect(() => {
    if (open) {
      openedAtRef.current = Date.now();
    }
  }, [open]);

  const left = anchor
    ? Math.max(
        12,
        Math.min(
          width - MENU_WIDTH - 12,
          anchor.mine ? anchor.x - MENU_WIDTH + 28 : anchor.x - 20,
        ),
      )
    : 12;

  const top = anchor
    ? Math.max(
        insets.top + 8,
        Math.min(
          height - insets.bottom - MENU_HEIGHT - 8,
          anchor.y - MENU_HEIGHT - 16,
        ),
      )
    : insets.top + 8;

  function handleBackdropPress() {
    if (Date.now() - openedAtRef.current < 320) {
      return;
    }

    onClose();
  }

  return (
    <Modal
      visible={open}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <View style={styles.overlay}>
        <Pressable style={StyleSheet.absoluteFill} onPress={handleBackdropPress} />

        <View
          style={[
            styles.menu,
            {
              left,
              top,
            },
          ]}
        >
          <Pressable onPress={onQuote} style={styles.menuItem}>
            <Feather
              name="corner-up-left"
              size={16}
              color={theme.colors.text}
            />
            <Text style={styles.menuLabel}>引用</Text>
          </Pressable>
          <View style={styles.separator} />
          <Pressable onPress={onCopy} style={styles.menuItem}>
            <Feather name="copy" size={16} color={theme.colors.text} />
            <Text style={styles.menuLabel}>复制</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: "rgba(15, 23, 42, 0.08)",
  },
  menu: {
    position: "absolute",
    width: MENU_WIDTH,
    borderRadius: 16,
    backgroundColor: "rgba(255,255,255,0.98)",
    borderWidth: 1,
    borderColor: theme.colors.border,
    boxShadow: "0 18px 36px rgba(15, 23, 42, 0.12)",
  },
  menuItem: {
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
  },
  separator: {
    height: 1,
    backgroundColor: theme.colors.border,
  },
  menuLabel: {
    fontSize: 14,
    fontWeight: "600",
    color: theme.colors.text,
  },
});
