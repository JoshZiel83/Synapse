import * as SQLite from "expo-sqlite";

import {
  normalizeChatWorkspaceSnapshot,
  type ChatWorkspaceSnapshot,
} from "@/lib/chat-data";
import type { ChatPersistence } from "@/lib/chat-persistence";

const DB_NAME = "synapse-chat.db";
const TABLE_NAME = "chat_workspace_snapshots";

let databasePromise: Promise<SQLite.SQLiteDatabase> | null = null;

async function getDatabase() {
  if (!databasePromise) {
    databasePromise = (async () => {
      const database = await SQLite.openDatabaseAsync(DB_NAME);
      await database.execAsync(`
        CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
          workspace_id TEXT PRIMARY KEY NOT NULL,
          payload TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
      return database;
    })();
  }

  return databasePromise;
}

export function createChatPersistence(): ChatPersistence {
  return {
    async loadWorkspaceSnapshot(workspaceId) {
      const database = await getDatabase();
      const row = await database.getFirstAsync<{ payload: string }>(
        `SELECT payload FROM ${TABLE_NAME} WHERE workspace_id = ? LIMIT 1`,
        [workspaceId],
      );

      if (!row?.payload) {
        return null;
      }

      try {
        return normalizeChatWorkspaceSnapshot(workspaceId, JSON.parse(row.payload));
      } catch {
        return null;
      }
    },
    async saveWorkspaceSnapshot(snapshot) {
      const database = await getDatabase();
      await database.runAsync(
        `
          INSERT INTO ${TABLE_NAME} (workspace_id, payload, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(workspace_id) DO UPDATE SET
            payload = excluded.payload,
            updated_at = excluded.updated_at
        `,
        [
          snapshot.workspaceId,
          JSON.stringify(snapshot),
          new Date().toISOString(),
        ],
      );
    },
    async deleteWorkspaceSnapshot(workspaceId) {
      const database = await getDatabase();
      await database.runAsync(
        `DELETE FROM ${TABLE_NAME} WHERE workspace_id = ?`,
        [workspaceId],
      );
    },
    async clearAllWorkspaceSnapshots() {
      const database = await getDatabase();
      await database.execAsync(`DELETE FROM ${TABLE_NAME};`);
    },
  };
}
