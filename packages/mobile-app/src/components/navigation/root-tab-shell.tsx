import Ionicons from "@expo/vector-icons/Ionicons"
import { useIsFocused } from "@react-navigation/native"
import { usePathname, useRouter } from "expo-router"
import { Keyboard, Pressable, StyleSheet, Text, View } from "react-native"
import { useEffect, useMemo, useState, type ComponentType } from "react"
import { useSafeAreaInsets } from "react-native-safe-area-context"

import { RootTabPages } from "@/components/navigation/root-tab-pages"
import { useChat } from "@/providers/chat-provider"
import { useWorkspace } from "@/providers/workspace-provider"
import { theme } from "@/theme/tokens"
import {
  ROOT_TAB_CONFIG,
  ROOT_TAB_ORDER,
  getRootTabByIndex,
  getRootTabFromPathname,
  getRootTabHref,
  getRootTabIndex,
  type RootTabKey,
} from "@/navigation/root-tabs"
import ChatsTabScreen from "@/screens/tabs/chats-tab-screen"
import ContactsTabScreen from "@/screens/tabs/contacts-tab-screen"
import HomeTabScreen from "@/screens/tabs/home-tab-screen"
import MeTabScreen from "@/screens/tabs/me-tab-screen"

const TAB_SCREEN_COMPONENTS: Record<RootTabKey, ComponentType> = {
  home: HomeTabScreen,
  chats: ChatsTabScreen,
  contacts: ContactsTabScreen,
  me: MeTabScreen,
}

function addVisitedTab(
  currentTabs: RootTabKey[],
  nextTab: RootTabKey
): RootTabKey[] {
  if (currentTabs.includes(nextTab)) {
    return currentTabs
  }

  return [...currentTabs, nextTab]
}

function RootTabBar({
  activeTab,
  hidden,
  onSelectTab,
  unreadCount,
}: {
  activeTab: RootTabKey
  hidden: boolean
  onSelectTab: (tab: RootTabKey) => void
  unreadCount: number
}) {
  const insets = useSafeAreaInsets()

  return (
    <View
      style={[
        styles.tabBar,
        hidden && styles.tabBarHidden,
        {
          paddingBottom: Math.max(insets.bottom, 3),
          height: hidden ? 0 : 42 + Math.max(insets.bottom, 3),
        },
      ]}
      pointerEvents={hidden ? "none" : "auto"}
    >
      {ROOT_TAB_ORDER.map((tab) => {
        const focused = tab === activeTab
        const color = focused ? theme.colors.primary : theme.colors.textSoft
        const config = ROOT_TAB_CONFIG[tab]

        return (
          <Pressable
            key={tab}
            accessibilityRole="tab"
            accessibilityState={focused ? { selected: true } : {}}
            onPress={() => onSelectTab(tab)}
            style={({ pressed }) => [
              styles.tabItem,
              pressed && styles.tabItemPressed,
            ]}
          >
            <View style={styles.tabIconWrap}>
              <Ionicons
                name={focused ? config.activeIcon : config.inactiveIcon}
                size={20}
                color={color}
              />
              {tab === "chats" && unreadCount > 0 ? (
                <View style={styles.tabBadge}>
                  <Text style={styles.tabBadgeText}>
                    {unreadCount > 99 ? "99+" : unreadCount}
                  </Text>
                </View>
              ) : null}
            </View>
            <Text
              numberOfLines={1}
              style={[
                styles.tabLabel,
                {
                  color,
                },
              ]}
            >
              {config.label}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}

export function RootTabShell() {
  const router = useRouter()
  const pathname = usePathname()
  const isFocused = useIsFocused()
  const { workspaceId } = useWorkspace()
  const { totalUnreadCount } = useChat()
  const initialTab = getRootTabFromPathname(pathname) ?? "home"
  const [selectedTab, setSelectedTab] = useState<RootTabKey>(initialTab)
  const [visitedTabs, setVisitedTabs] = useState<RootTabKey[]>([initialTab])
  const [keyboardVisible, setKeyboardVisible] = useState(false)

  const unreadCount = useMemo(
    () => (workspaceId ? totalUnreadCount : 0),
    [totalUnreadCount, workspaceId]
  )

  useEffect(() => {
    setVisitedTabs((currentTabs) => addVisitedTab(currentTabs, selectedTab))
  }, [selectedTab])

  useEffect(() => {
    const showSubscription = Keyboard.addListener("keyboardDidShow", () => {
      setKeyboardVisible(true)
    })
    const hideSubscription = Keyboard.addListener("keyboardDidHide", () => {
      setKeyboardVisible(false)
    })

    return () => {
      showSubscription.remove()
      hideSubscription.remove()
    }
  }, [])

  useEffect(() => {
    if (!isFocused) {
      return
    }

    const nextTab = getRootTabFromPathname(pathname)
    if (!nextTab || nextTab === selectedTab) {
      return
    }

    setSelectedTab(nextTab)
  }, [isFocused, pathname, selectedTab])

  function handleSelectTab(nextTab: RootTabKey) {
    if (nextTab === selectedTab) {
      return
    }

    setSelectedTab(nextTab)
    router.replace(getRootTabHref(nextTab))
  }

  function renderTabPage(tab: RootTabKey) {
    const ScreenComponent = TAB_SCREEN_COMPONENTS[tab]
    return <ScreenComponent />
  }

  return (
    <View style={styles.shell}>
      <View style={styles.pagerWrap}>
        <RootTabPages
          initialTab={initialTab}
          selectedTab={selectedTab}
          visitedTabs={visitedTabs}
          onSelectTab={handleSelectTab}
          renderTabPage={renderTabPage}
        />
      </View>

      <RootTabBar
        activeTab={selectedTab}
        hidden={keyboardVisible}
        unreadCount={unreadCount}
        onSelectTab={handleSelectTab}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  shell: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  pagerWrap: {
    flex: 1,
  },
  tabBar: {
    flexDirection: "row",
    alignItems: "flex-end",
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    backgroundColor: "rgba(255, 255, 255, 0.98)",
    paddingTop: 2,
  },
  tabBarHidden: {
    opacity: 0,
    borderTopWidth: 0,
  },
  tabItem: {
    flex: 1,
    minWidth: 0,
    alignItems: "center",
    justifyContent: "center",
    gap: 0,
    paddingHorizontal: 4,
  },
  tabItemPressed: {
    opacity: 0.7,
  },
  tabIconWrap: {
    position: "relative",
    width: 24,
    height: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  tabBadge: {
    position: "absolute",
    top: -5,
    right: -9,
    minWidth: 16,
    height: 16,
    paddingHorizontal: 4,
    borderRadius: 8,
    borderWidth: 1.5,
    borderColor: theme.colors.surface,
    backgroundColor: theme.colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  tabBadgeText: {
    fontSize: 9,
    lineHeight: 10,
    fontWeight: "800",
    color: theme.colors.white,
  },
  tabLabel: {
    maxWidth: "100%",
    fontSize: 10,
    lineHeight: 11,
    fontWeight: "500",
    includeFontPadding: false,
    textAlign: "center",
  },
})
