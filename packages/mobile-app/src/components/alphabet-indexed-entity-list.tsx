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
  ScrollView,
  StyleSheet,
  Text,
  View,
  type RefreshControlProps,
} from "react-native"

import { Avatar } from "@/components/ui"
import { theme } from "@/theme/tokens"

export type AlphabetIndexedEntityItem = {
  key: string
  title: string
  subtitle?: string
  avatarUrl?: string | null
  targetType: "actor" | "user"
  onPress: () => void
  leadingAccessory?: React.ReactNode
  trailingAccessory?: React.ReactNode
}

type AlphabetSection = {
  letter: string
  items: AlphabetIndexedEntityItem[]
}

const LETTER_RAIL = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ", "#"]

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
] as const

function compareText(left: string, right: string) {
  try {
    return left.localeCompare(right, "zh-Hans-u-co-pinyin", {
      sensitivity: "base",
    })
  } catch {
    return left.localeCompare(right, undefined, {
      sensitivity: "base",
    })
  }
}

function getInitialLetter(value: string) {
  const first = value.trim().charAt(0)
  if (!first) return "#"

  const upper = first.toUpperCase()
  if (/^[A-Z]$/.test(upper)) return upper

  if (/^[\u4E00-\u9FFF]$/.test(first)) {
    for (
      let index = PINYIN_INITIAL_BOUNDARIES.length - 1;
      index >= 0;
      index -= 1
    ) {
      const current = PINYIN_INITIAL_BOUNDARIES[index]
      if (current && compareText(first, current.boundary) >= 0) {
        return current.letter
      }
    }
    return "A"
  }

  return "#"
}

function compareItems(
  left: AlphabetIndexedEntityItem,
  right: AlphabetIndexedEntityItem
) {
  const titleCompare = compareText(left.title, right.title)
  if (titleCompare !== 0) return titleCompare
  return compareText(left.subtitle || "", right.subtitle || "")
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
  const scrollRef = useRef<ScrollView | null>(null)
  const letterOffsetsRef = useRef<Record<string, number>>({})
  const [railHeight, setRailHeight] = useState(0)
  const [activeLetter, setActiveLetter] = useState<string | null>(null)

  const sortedItems = useMemo(() => [...items].sort(compareItems), [items])

  const sections = useMemo<AlphabetSection[]>(() => {
    const grouped = new Map<string, AlphabetIndexedEntityItem[]>()
    for (const item of sortedItems) {
      const letter = getInitialLetter(item.title)
      if (!grouped.has(letter)) {
        grouped.set(letter, [])
      }
      grouped.get(letter)!.push(item)
    }

    return LETTER_RAIL.filter((letter) => grouped.has(letter)).map(
      (letter) => ({
        letter,
        items: grouped.get(letter) || [],
      })
    )
  }, [sortedItems])

  function scrollToLetter(letter: string) {
    const offset = letterOffsetsRef.current[letter]
    if (typeof offset !== "number") return
    setActiveLetter(letter)
    scrollRef.current?.scrollTo({
      y: Math.max(offset - 10, 0),
      animated: false,
    })
  }

  function activateRailByLocation(locationY: number) {
    if (!railHeight) return
    const index = Math.min(
      LETTER_RAIL.length - 1,
      Math.max(0, Math.floor((locationY / railHeight) * LETTER_RAIL.length))
    )
    const letter = LETTER_RAIL[index]!
    scrollToLetter(letter)
  }

  const railResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (event) => {
          activateRailByLocation(event.nativeEvent.locationY)
        },
        onPanResponderMove: (event) => {
          activateRailByLocation(event.nativeEvent.locationY)
        },
      }),
    [railHeight]
  )

  return (
    <View style={styles.pageShell}>
      <ScrollView
        ref={scrollRef}
        style={styles.scroll}
        contentContainerStyle={[
          styles.scrollContent,
          {
            paddingBottom: bottomPadding,
          },
        ]}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        refreshControl={refreshControl}
      >
        {headerContent}
        {sortedItems.length > 0 ? (
          <View style={styles.listCard}>
            {sections.map((section) => (
              <View
                key={section.letter}
                onLayout={(event) => {
                  letterOffsetsRef.current[section.letter] =
                    event.nativeEvent.layout.y
                }}
              >
                <View style={styles.letterHeader}>
                  <Text style={styles.letterHeaderText}>{section.letter}</Text>
                </View>
                {section.items.map((item) => (
                  <Pressable
                    key={item.key}
                    onPress={item.onPress}
                    style={({ pressed }) => [
                      styles.rowCard,
                      pressed && styles.rowCardPressed,
                    ]}
                  >
                    {item.leadingAccessory}
                    <View style={styles.avatarShell}>
                      <Avatar
                        name={item.title}
                        uri={item.avatarUrl || undefined}
                        icon={item.targetType === "actor" ? "cpu" : "user"}
                        size={40}
                      />
                      {item.targetType === "actor" ? (
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
                      <Text style={styles.rowTitle}>{item.title}</Text>
                      {item.subtitle ? (
                        <Text numberOfLines={2} style={styles.rowSubtitle}>
                          {item.subtitle}
                        </Text>
                      ) : null}
                    </View>
                    {item.trailingAccessory}
                  </Pressable>
                ))}
              </View>
            ))}
          </View>
        ) : (
          emptyState
        )}
      </ScrollView>

      {sortedItems.length > 0 && sections.length > 0 ? (
        <View
          style={styles.letterRail}
          onLayout={(event) => setRailHeight(event.nativeEvent.layout.height)}
          {...railResponder.panHandlers}
        >
          {LETTER_RAIL.map((letter) => {
            const enabled = sections.some(
              (section) => section.letter === letter
            )
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
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  pageShell: {
    flex: 1,
    position: "relative",
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 18,
    paddingTop: 16,
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
