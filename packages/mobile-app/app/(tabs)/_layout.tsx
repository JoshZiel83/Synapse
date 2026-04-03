import Ionicons from "@expo/vector-icons/Ionicons";
import type { BottomTabBarProps } from "@react-navigation/bottom-tabs";
import { Tabs } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useWorkspaceWebSocket } from "@/hooks/use-workspace-websocket";
import { api } from "@/lib/api";
import { applyPendingConversationReadState } from "@/lib/conversations";
import { useWorkspace } from "@/providers/workspace-provider";
import { theme } from "@/theme/tokens";
import type { ChatSocketEvent, ConversationFeedItem } from "@shared";

function AppTabBar({
  state,
  descriptors,
  navigation,
  unreadCount,
}: BottomTabBarProps & { unreadCount: number }) {
  const insets = useSafeAreaInsets();

  return (
    <View
      style={[
        styles.tabBar,
        {
          paddingBottom: Math.max(insets.bottom, 3),
          height: 42 + Math.max(insets.bottom, 3),
        },
      ]}
    >
      {state.routes.map((route, index) => {
        const descriptor = descriptors[route.key];
        const options = descriptor.options;
        const focused = state.index === index;
        const color = focused ? theme.colors.primary : theme.colors.textSoft;
        const label =
          typeof options.tabBarLabel === "string"
            ? options.tabBarLabel
            : typeof options.title === "string"
              ? options.title
              : route.name;

        const onPress = () => {
          const event = navigation.emit({
            type: "tabPress",
            target: route.key,
            canPreventDefault: true,
          });

          if (!focused && !event.defaultPrevented) {
            navigation.navigate(route.name, route.params);
          }
        };

        const onLongPress = () => {
          navigation.emit({
            type: "tabLongPress",
            target: route.key,
          });
        };

        return (
          <Pressable
            key={route.key}
            accessibilityRole="button"
            accessibilityState={focused ? { selected: true } : {}}
            accessibilityLabel={options.tabBarAccessibilityLabel}
            testID={options.tabBarButtonTestID}
            onPress={onPress}
            onLongPress={onLongPress}
            style={({ pressed }) => [
              styles.tabItem,
              pressed && styles.tabItemPressed,
            ]}
          >
            <View style={styles.tabIconWrap}>
              {options.tabBarIcon?.({
                focused,
                color,
                size: 20,
              })}
              {route.name === "chats" && unreadCount > 0 ? (
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
              {label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export default function TabLayout() {
  const { workspaceId } = useWorkspace();
  const [unreadCount, setUnreadCount] = useState(0);

  const refreshUnreadCount = useCallback(async () => {
    if (!workspaceId) {
      setUnreadCount(0);
      return;
    }

    try {
      const response = await api.getThreads(workspaceId);
      const conversations = await applyPendingConversationReadState(
        response.conversations,
      );
      setUnreadCount(
        conversations.reduce(
          (total, conversation) => total + conversation.unreadCount,
          0,
        ),
      );
    } catch {
      // Keep the last badge state if inbox refresh fails.
    }
  }, [workspaceId]);

  useEffect(() => {
    void refreshUnreadCount();
  }, [refreshUnreadCount]);

  const handleSocketEvent = useCallback(
    (event: ChatSocketEvent | Record<string, unknown>) => {
      if (!workspaceId || typeof event.type !== "string") {
        return;
      }

      switch (event.type) {
        case "conversation.item.created": {
          const payload = (event as ChatSocketEvent<"conversation.item.created">)
            .payload as ConversationFeedItem;
          if (payload.conversationId) {
            void refreshUnreadCount();
          }
          return;
        }
        case "conversation.updated":
        case "conversation.read.updated":
          void refreshUnreadCount();
          return;
        default:
          return;
      }
    },
    [refreshUnreadCount, workspaceId],
  );

  useWorkspaceWebSocket({
    workspaceId: workspaceId || undefined,
    enabled: Boolean(workspaceId),
    subscriptions: workspaceId
      ? [
          {
            key: `tab-inbox:${workspaceId}`,
            topic: "inbox",
          },
        ]
      : [],
    onConnected: () => {
      void refreshUnreadCount();
    },
    onEvent: handleSocketEvent,
  });

  return (
    <Tabs
      tabBar={(props) => <AppTabBar {...props} unreadCount={unreadCount} />}
      screenOptions={{
        headerShown: false,
        tabBarHideOnKeyboard: true,
        sceneStyle: {
          backgroundColor: theme.colors.background,
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "首页",
          tabBarIcon: ({ color, focused }) => (
            <Ionicons
              name={focused ? "home" : "home-outline"}
              size={18}
              color={color}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="chats"
        options={{
          title: "聊天",
          tabBarIcon: ({ color, focused }) => (
            <Ionicons
              name={focused ? "chatbubble" : "chatbubble-outline"}
              size={18}
              color={color}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="contacts"
        options={{
          title: "联系人",
          tabBarIcon: ({ color, focused }) => (
            <Ionicons
              name={focused ? "people" : "people-outline"}
              size={18}
              color={color}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="me"
        options={{
          title: "我的",
          tabBarIcon: ({ color, focused }) => (
            <Ionicons
              name={focused ? "person" : "person-outline"}
              size={18}
              color={color}
            />
          ),
        }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  tabBar: {
    flexDirection: "row",
    alignItems: "flex-end",
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    backgroundColor: "rgba(255, 255, 255, 0.98)",
    paddingTop: 2,
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
});
