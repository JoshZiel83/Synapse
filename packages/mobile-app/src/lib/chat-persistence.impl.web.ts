import {
  normalizeChatWorkspaceSnapshot,
  type ChatWorkspaceSnapshot,
} from "@/lib/chat-data";
import type { ChatPersistence } from "@/lib/chat-persistence";

const DB_NAME = "synapse-chat";
const STORE_NAME = "workspace_snapshots";
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
  return {
    async loadWorkspaceSnapshot(workspaceId) {
      const row = await withStore("readonly", (store) =>
        requestToPromise<{ workspaceId: string; payload: ChatWorkspaceSnapshot } | undefined>(
          store.get(workspaceId),
        ),
      );

      if (!row?.payload) {
        return null;
      }

      return normalizeChatWorkspaceSnapshot(workspaceId, row.payload);
    },
    async saveWorkspaceSnapshot(snapshot) {
      await withStore("readwrite", (store) =>
        requestToPromise(
          store.put({
            workspaceId: snapshot.workspaceId,
            payload: snapshot,
            updatedAt: new Date().toISOString(),
          }),
        ),
      );
    },
    async deleteWorkspaceSnapshot(workspaceId) {
      await withStore("readwrite", (store) =>
        requestToPromise(store.delete(workspaceId)),
      );
    },
    async clearAllWorkspaceSnapshots() {
      await withStore("readwrite", (store) =>
        requestToPromise(store.clear()),
      );
    },
  };
}
