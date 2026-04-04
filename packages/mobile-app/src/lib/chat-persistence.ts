import { Platform } from "react-native";

import type { ChatWorkspaceSnapshot } from "@/lib/chat-data";

export interface ChatPersistence {
  loadWorkspaceSnapshot: (workspaceId: string) => Promise<ChatWorkspaceSnapshot | null>;
  saveWorkspaceSnapshot: (snapshot: ChatWorkspaceSnapshot) => Promise<void>;
  deleteWorkspaceSnapshot: (workspaceId: string) => Promise<void>;
  clearAllWorkspaceSnapshots: () => Promise<void>;
}

export function createChatPersistence(): ChatPersistence {
  if (Platform.OS === "web") {
    return (
      require("@/lib/chat-persistence.impl.web") as {
        createChatPersistence: () => ChatPersistence;
      }
    ).createChatPersistence();
  }

  return (
    require("@/lib/chat-persistence.impl.native") as {
      createChatPersistence: () => ChatPersistence;
    }
  ).createChatPersistence();
}
