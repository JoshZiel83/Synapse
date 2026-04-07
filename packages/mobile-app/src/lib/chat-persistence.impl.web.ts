import {
  buildChatWorkspaceSnapshotFromQueueState,
  normalizeChatWorkspaceQueueState,
  toChatWorkspaceQueueState,
  type ChatWorkspaceQueueState,
} from "@/lib/chat-data";
import type { ChatPersistence } from "@/lib/chat-persistence";

const DB_NAME = "synapse-chat-web-queue";
const STORE_NAME = "workspace_queue_states";
const VERSION = 1;

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, VERSION);

    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: "workspaceId" });
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => Promise<T> | T,
) {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, mode);
  const store = transaction.objectStore(STORE_NAME);

  try {
    const result = await run(store);
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    return result;
  } finally {
    database.close();
  }
}

function requestToPromise<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function createChatPersistence(): ChatPersistence {
  async function loadWorkspaceQueueState(workspaceId: string) {
    const row = await withStore("readonly", (store) =>
      requestToPromise<
        { workspaceId: string; payload: ChatWorkspaceQueueState } | undefined
      >(store.get(workspaceId)),
    );

    if (!row?.payload) {
      return null;
    }

    return normalizeChatWorkspaceQueueState(workspaceId, row.payload);
  }

  return {
    loadWorkspaceQueueState,
    async loadWorkspaceState(workspaceId) {
      const queueState = await loadWorkspaceQueueState(workspaceId);
      return buildChatWorkspaceSnapshotFromQueueState(workspaceId, queueState);
    },
    async saveWorkspaceState(snapshot) {
      const queueState = toChatWorkspaceQueueState(snapshot);
      await withStore("readwrite", (store) =>
        requestToPromise(
          store.put({
            workspaceId: snapshot.workspaceId,
            payload: queueState,
            updatedAt: new Date().toISOString(),
          }),
        ),
      );
    },
    async deleteWorkspaceState(workspaceId) {
      await withStore("readwrite", (store) =>
        requestToPromise(store.delete(workspaceId)),
      );
    },
    async clearAllWorkspaceState() {
      await withStore("readwrite", (store) =>
        requestToPromise(store.clear()),
      );
    },
  };
}
