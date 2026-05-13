import type Ionicons from "@expo/vector-icons/Ionicons"
import type { ComponentProps } from "react"

export type RootTabKey = "home" | "chats" | "contacts" | "me"

type IoniconName = ComponentProps<typeof Ionicons>["name"]
type RootTabHref = "/" | "/chats" | "/contacts" | "/me"

type RootTabDefinition = {
  href: RootTabHref
  label: string
  activeIcon: IoniconName
  inactiveIcon: IoniconName
}

export const ROOT_TAB_ORDER: RootTabKey[] = ["home", "chats", "contacts", "me"]

export const ROOT_TAB_CONFIG: Record<RootTabKey, RootTabDefinition> = {
  home: {
    href: "/",
    label: "首页",
    activeIcon: "home",
    inactiveIcon: "home-outline",
  },
  chats: {
    href: "/chats",
    label: "聊天",
    activeIcon: "chatbubble",
    inactiveIcon: "chatbubble-outline",
  },
  contacts: {
    href: "/contacts",
    label: "联系人",
    activeIcon: "people",
    inactiveIcon: "people-outline",
  },
  me: {
    href: "/me",
    label: "我的",
    activeIcon: "person",
    inactiveIcon: "person-outline",
  },
}

function normalizePathname(pathname: string) {
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return pathname.slice(0, -1)
  }

  return pathname
}

export function getRootTabFromPathname(pathname: string): RootTabKey | null {
  switch (normalizePathname(pathname)) {
    case "/":
      return "home"
    case "/chats":
      return "chats"
    case "/contacts":
      return "contacts"
    case "/me":
      return "me"
    default:
      return null
  }
}

export function getRootTabHref(tab: RootTabKey): RootTabHref {
  return ROOT_TAB_CONFIG[tab].href
}

export function getRootTabIndex(tab: RootTabKey) {
  return ROOT_TAB_ORDER.indexOf(tab)
}

export function getRootTabByIndex(index: number) {
  return ROOT_TAB_ORDER[index] ?? ROOT_TAB_ORDER[0]
}
