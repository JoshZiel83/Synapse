import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons"
import {
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react"
import {
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
  type RefreshControlProps,
} from "react-native"
import { FlashList, type FlashListRef } from "@shopify/flash-list"
import {
  ALPHABET_RAIL,
  comparePinyin,
  getAlphabetInitial,
} from "@shared/pinyin"

import { Avatar } from "@/components/ui"
import { theme } from "@/theme/tokens"

export const ALPHABET_ENTITY_TARGET_TYPE = {
  ACTOR: "actor",
  USER: "user",
} as const

export type AlphabetIndexedEntityItem = {
  key: string
  title: string
  subtitle?: string
  avatarUrl?: string | null
  targetType: (typeof ALPHABET_ENTITY_TARGET_TYPE)[keyof typeof ALPHABET_ENTITY_TARGET_TYPE]
  onPress: () => void
  leadingAccessory?: React.ReactNode
  trailingAccessory?: React.ReactNode
}

const LETTER_RAIL = ALPHABET_RAIL

type FlatRow =
  | { kind: "header"; letter: string }
  | { kind: "item"; item: AlphabetIndexedEntityItem }

function compareItems(
  left: AlphabetIndexedEntityItem,
  right: AlphabetIndexedEntityItem
) {
  const titleCompare = comparePinyin(left.title, right.title)
  if (titleCompare !== 0) return titleCompare
  return comparePinyin(left.subtitle || "", right.subtitle || "")
}

export function AlphabetIndexedEntityList({
  items,
  headerContent,
  emptyState,
  refreshControl,
  bottomPadding = 120,
}: {
  items: AlphabetIndexedEntityItem[]
  headerContent?: ReactNode
  emptyState?: ReactNode
  refreshControl?: ReactElement<RefreshControlProps>
  bottomPadding?: number
}) {
  const listRef = useRef<FlashListRef<FlatRow>>(null)
  const [railHeight, setRailHeight] = useState(0)
  const [activeLetter, setActiveLetter] = useState<string | null>(null)

  const sortedItems = useMemo(() => [...items].sort(compareItems), [items])

  // Flatten sorted items into header/item rows, and remember the flat index of
  // each letter header so the rail can scrollToIndex.
  const { rows, stickyHeaderIndices, letterToIndex, presentLetters } =
    useMemo(() => {
      const grouped = new Map<string, AlphabetIndexedEntityItem[]>()
      for (const item of sortedItems) {
        const letter = getAlphabetInitial(item.title)
        if (!grouped.has(letter)) grouped.set(letter, [])
        grouped.get(letter)!.push(item)
      }

      const flat: FlatRow[] = []
      const sticky: number[] = []
      const index = new Map<string, number>()
      const present = new Set<string>()
      for (const letter of LETTER_RAIL) {
        const group = grouped.get(letter)
        if (!group || group.length === 0) continue
        present.add(letter)
        index.set(letter, flat.length)
        sticky.push(flat.length)
        flat.push({ kind: "header", letter })
        for (const item of group) flat.push({ kind: "item", item })
      }
      return {
        rows: flat,
        stickyHeaderIndices: sticky,
        letterToIndex: index,
        presentLetters: present,
      }
    }, [sortedItems])

  function scrollToLetter(letter: string) {
    const targetIndex = letterToIndex.get(letter)
    if (typeof targetIndex !== "number") return
    setActiveLetter(letter)
    listRef.current?.scrollToIndex({ index: targetIndex, animated: false })
  }

  function activateRailByLocation(locationY: number) {
    if (!railHeight) return
    const railIndex = Math.min(
      LETTER_RAIL.length - 1,
      Math.max(0, Math.floor((locationY / railHeight) * LETTER_RAIL.length))
    )
    const letter = LETTER_RAIL[railIndex]!
    if (presentLetters.has(letter)) {
      scrollToLetter(letter)
    }
  }

  const railResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (event) =>
          activateRailByLocation(event.nativeEvent.locationY),
        onPanResponderMove: (event) =>
          activateRailByLocation(event.nativeEvent.locationY),
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [railHeight, presentLetters]
  )

  if (sortedItems.length === 0) {
    return (
      <View style={styles.pageShell}>
        <FlashList
          data={[]}
          renderItem={() => null}
          ListHeaderComponent={headerContent as ReactElement}
          ListEmptyComponent={emptyState as ReactElement}
          refreshControl={refreshControl}
          contentContainerStyle={{ paddingHorizontal: 18, paddingTop: 16 }}
        />
      </View>
    )
  }

  return (
    <View style={styles.pageShell}>
      <FlashList
        ref={listRef}
        data={rows}
        keyExtractor={(row, i) =>
          row.kind === "header" ? `h:${row.letter}` : `i:${row.item.key}:${i}`
        }
        getItemType={(row) => row.kind}
        stickyHeaderIndices={stickyHeaderIndices}
        renderItem={({ item: row }) =>
          row.kind === "header" ? (
            <View style={styles.letterHeader}>
              <Text style={styles.letterHeaderText}>{row.letter}</Text>
            </View>
          ) : (
            <Pressable
              onPress={row.item.onPress}
              style={({ pressed }) => [
                styles.rowCard,
                pressed && styles.rowCardPressed,
              ]}
            >
              {row.item.leadingAccessory}
              <View style={styles.avatarShell}>
                <Avatar
                  name={row.item.title}
                  uri={row.item.avatarUrl || undefined}
                  icon={
                    row.item.targetType === ALPHABET_ENTITY_TARGET_TYPE.ACTOR
                      ? "cpu"
                      : "user"
                  }
                  size={40}
                />
                {row.item.targetType === ALPHABET_ENTITY_TARGET_TYPE.ACTOR ? (
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
                <Text style={styles.rowTitle}>{row.item.title}</Text>
                {row.item.subtitle ? (
                  <Text numberOfLines={2} style={styles.rowSubtitle}>
                    {row.item.subtitle}
                  </Text>
                ) : null}
              </View>
              {row.item.trailingAccessory}
            </Pressable>
          )
        }
        ListHeaderComponent={headerContent as ReactElement}
        refreshControl={refreshControl}
        contentContainerStyle={{
          paddingHorizontal: 18,
          paddingTop: 16,
          paddingBottom: bottomPadding,
        }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      />

      <View
        style={styles.letterRail}
        onLayout={(event) => setRailHeight(event.nativeEvent.layout.height)}
        {...railResponder.panHandlers}
      >
        {LETTER_RAIL.map((letter) => {
          const enabled = presentLetters.has(letter)
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
          )
        })}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  pageShell: {
    flex: 1,
    position: "relative",
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
  rowBody: {
    flex: 1,
    gap: 4,
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
    top: 124,
    bottom: 20,
    width: 22,
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 4,
  },
  letterRailItem: {
    width: 22,
    alignItems: "center",
    justifyContent: "center",
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
})
