import { Platform } from "react-native"

import type {
  ChatWorkspaceQueueState,
  ChatWorkspaceSnapshot,
} from "@/lib/chat-data"

export interface ChatPersistence {
  loadWorkspaceState: (
    workspaceId: string
  ) => Promise<ChatWorkspaceSnapshot | null>
  loadWorkspaceQueueState: (
    workspaceId: string
  ) => Promise<ChatWorkspaceQueueState | null>
  saveWorkspaceState: (snapshot: ChatWorkspaceSnapshot) => Promise<void>
  deleteWorkspaceState: (workspaceId: string) => Promise<void>
  clearAllWorkspaceState: () => Promise<void>
}

export function createChatPersistence(): ChatPersistence {
  if (Platform.OS === "web") {
    return (
      require("@/lib/chat-persistence.impl.web") as {
        createChatPersistence: () => ChatPersistence
      }
    ).createChatPersistence()
  }

  return (
    require("@/lib/chat-persistence.impl.native") as {
      createChatPersistence: () => ChatPersistence
    }
  ).createChatPersistence()
}
