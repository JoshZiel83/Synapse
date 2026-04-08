import {
  buildChatWorkspaceSnapshotFromQueueState,
  toChatWorkspaceQueueState,
} from "@/lib/chat-data";
import type { ChatPersistence } from "@/lib/chat-persistence";
import {
  clearStoredChatWorkspaceQueueState,
  deleteStoredChatWorkspaceQueueState,
  loadStoredChatWorkspaceQueueState,
  saveStoredChatWorkspaceQueueState,
} from "@/lib/chat-web-queue-storage";

export function createChatPersistence(): ChatPersistence {
  return {
    loadWorkspaceQueueState: loadStoredChatWorkspaceQueueState,
    async loadWorkspaceState(workspaceId) {
      const queueState = await loadStoredChatWorkspaceQueueState(workspaceId);
      return buildChatWorkspaceSnapshotFromQueueState(workspaceId, queueState);
    },
    async saveWorkspaceState(snapshot) {
      const queueState = toChatWorkspaceQueueState(snapshot);
      await saveStoredChatWorkspaceQueueState(queueState);
    },
    async deleteWorkspaceState(workspaceId) {
      await deleteStoredChatWorkspaceQueueState(workspaceId);
    },
    async clearAllWorkspaceState() {
      await clearStoredChatWorkspaceQueueState();
    },
  };
}
