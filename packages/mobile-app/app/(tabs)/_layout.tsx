import Ionicons from "@expo/vector-icons/Ionicons";
import { Tabs } from "expo-router";

import { theme } from "@/theme/tokens";

export default function TabLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarHideOnKeyboard: true,
        tabBarActiveTintColor: theme.colors.primary,
        tabBarInactiveTintColor: theme.colors.textSoft,
        tabBarLabelPosition: "below-icon",
        tabBarStyle: {
          backgroundColor: "rgba(255, 255, 255, 0.98)",
          borderTopColor: theme.colors.border,
          borderTopWidth: 1,
        },
        tabBarLabelStyle: {
          fontSize: 10,
          fontWeight: "500",
        },
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
