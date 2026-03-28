import type { ToolDefinition, ToolParameterProperty } from "@synapse/shared";
import {
  fileToBuffer,
  saveFromBuffer,
} from "../../../infrastructure/storage/file-io.js";
import {
  pluginOutputFileRef,
  resolveFileRefRecord,
} from "../file-ref.js";
import {
  createFeishuApiClient,
  parseJsonArrayInput,
  parseJsonObjectInput,
} from "./client.js";
import {
  DEFAULT_FEISHU_FEATURES,
  type FeishuFeatureKey,
  normalizeFeishuFeatureKeys,
} from "./features.js";

type JsonObject = Record<string, unknown>;

type FeishuToolSpec = {
  name: string;
  feature: FeishuFeatureKey;
  definition: ToolDefinition;
  execute: (input: Record<string, unknown>, config: Record<string, unknown>) => Promise<unknown>;
};

const jsonObjectProperty = (description: string): ToolParameterProperty => ({
  type: "object",
  description,
});

const jsonArrayProperty = (description: string): ToolParameterProperty => ({
  type: "array",
  description,
});

function asString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function asNumber(value: unknown, fallback = 0) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  if (typeof value === "string" && value.trim().length > 0) {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function getWorkspaceId(config: Record<string, unknown>) {
  return asString(config.workspace_id) || null;
}

async function resolveChatIdFromInput(
  client: ReturnType<typeof createFeishuApiClient>["client"],
  input: Record<string, unknown>,
) {
  const directChatId = asString(input.chatId);
  if (directChatId) {
    return directChatId;
  }

  const userId = asString(input.userId);
  if (!userId) {
    throw new Error("Provide either chatId or userId.");
  }

  const data = await client.requestJson<{ p2p_chats?: Array<{ chat_id?: string }> }>({
    path: "/open-apis/im/v1/chat_p2p/batch_query",
    method: "POST",
    query: {
      chatter_id_type: "open_id",
    },
    body: {
      chatter_ids: [userId],
    },
  });
  const chatId = data.p2p_chats?.[0]?.chat_id;
  if (!chatId) {
    throw new Error("P2P chat not found for the provided userId.");
  }
  return chatId;
}

function parseContentDispositionFilename(value: string, fallback: string) {
  const utf8Match = value.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match?.[1]) {
    return decodeURIComponent(utf8Match[1]);
  }
  const plainMatch = value.match(/filename="?([^"]+)"?/i);
  return plainMatch?.[1] || fallback;
}

function bufferToArrayBuffer(buffer: Buffer) {
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;
}

function toUnixTimestampSeconds(value: unknown, label: string) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.floor(value).toString();
  }
  if (typeof value === "string" && value.trim().length > 0) {
    if (/^\d+$/.test(value.trim())) {
      return value.trim();
    }
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) {
      return Math.floor(parsed / 1000).toString();
    }
  }
  throw new Error(`${label} must be an ISO time string or a unix timestamp in seconds.`);
}

function normalizeCalendarAttendees(value: unknown) {
  return asStringArray(value).map((id) => {
    if (id.startsWith("oc_")) {
      return { type: "chat", chat_id: id };
    }
    if (id.startsWith("omm_")) {
      return { type: "resource", room_id: id };
    }
    return { type: "user", user_id: id };
  });
}

const feishuToolSpecs: FeishuToolSpec[] = [
  {
    name: "feishu.contacts.search_users",
    feature: "contacts",
    definition: {
      name: "feishu.contacts.search_users",
      description: "Search Feishu users by keyword.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search keyword." },
          pageSize: { type: "number", description: "Page size, 1-200." },
          pageToken: { type: "string", description: "Pagination token from the previous page." },
        },
        required: ["query"],
      },
    },
    async execute(input, config) {
      const { client } = createFeishuApiClient(config);
      return client.requestJson({
        path: "/open-apis/search/v1/user",
        query: {
          query: asString(input.query),
          page_size: asNumber(input.pageSize, 20) || 20,
          page_token: asString(input.pageToken) || undefined,
        },
      });
    },
  },
  {
    name: "feishu.contacts.get_user",
    feature: "contacts",
    definition: {
      name: "feishu.contacts.get_user",
      description: "Get the current user or fetch a user by open_id.",
      parameters: {
        type: "object",
        properties: {
          userId: { type: "string", description: "Optional Feishu open_id. Omit to read the current authorized user." },
        },
        required: [],
      },
    },
    async execute(input, config) {
      const { client } = createFeishuApiClient(config);
      const userId = asString(input.userId);
      if (!userId) {
        return client.requestJson({
          path: "/open-apis/authen/v1/user_info",
        });
      }

      const data = await client.requestJson<{ users?: unknown[] }>({
        path: "/open-apis/contact/v3/users/basic_batch",
        method: "POST",
        query: {
          user_id_type: "open_id",
        },
        body: {
          user_ids: [userId],
        },
      });

      return {
        user: Array.isArray(data.users) ? data.users[0] || null : null,
      };
    },
  },
  {
    name: "feishu.im.search_chats",
    feature: "im_read",
    definition: {
      name: "feishu.im.search_chats",
      description: "Search visible group chats by keyword or member open_id.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Chat search keyword." },
          memberIds: { type: "array", description: "Optional open_id list to restrict the chat search.", items: { type: "string" } },
          pageSize: { type: "number", description: "Page size, 1-100." },
          pageToken: { type: "string", description: "Pagination token from the previous page." },
        },
        required: [],
      },
    },
    async execute(input, config) {
      const { client } = createFeishuApiClient(config);
      const body: JsonObject = {};
      const query = asString(input.query);
      const memberIds = asStringArray(input.memberIds);
      if (!query && memberIds.length === 0) {
        throw new Error("Provide query or memberIds.");
      }
      if (query) {
        body.query = query;
      }
      if (memberIds.length > 0) {
        body.filter = { member_ids: memberIds };
      }

      return client.requestJson({
        path: "/open-apis/im/v2/chats/search",
        method: "POST",
        query: {
          page_size: asNumber(input.pageSize, 20) || 20,
          page_token: asString(input.pageToken) || undefined,
        },
        body,
      });
    },
  },
  {
    name: "feishu.im.list_chat_messages",
    feature: "im_read",
    definition: {
      name: "feishu.im.list_chat_messages",
      description: "List messages in a Feishu group chat or P2P chat.",
      parameters: {
        type: "object",
        properties: {
          chatId: { type: "string", description: "Chat ID, for example oc_xxx." },
          userId: { type: "string", description: "Alternative to chatId. Provide a user open_id to resolve the P2P chat first." },
          startTime: { type: "string", description: "Optional ISO time or unix timestamp in seconds." },
          endTime: { type: "string", description: "Optional ISO time or unix timestamp in seconds." },
          sort: { type: "string", description: "Sort order.", enum: ["asc", "desc"] },
          pageSize: { type: "number", description: "Page size, 1-50." },
          pageToken: { type: "string", description: "Pagination token from the previous page." },
        },
        required: [],
      },
    },
    async execute(input, config) {
      const { client } = createFeishuApiClient(config);
      const chatId = await resolveChatIdFromInput(client, input);

      return client.requestJson({
        path: "/open-apis/im/v1/messages",
        query: {
          container_id_type: "chat",
          container_id: chatId,
          sort_type: asString(input.sort) === "asc" ? "ByCreateTimeAsc" : "ByCreateTimeDesc",
          page_size: Math.min(Math.max(asNumber(input.pageSize, 50) || 50, 1), 50),
          page_token: asString(input.pageToken) || undefined,
          card_msg_content_type: "raw_card_content",
          start_time: input.startTime ? toUnixTimestampSeconds(input.startTime, "startTime") : undefined,
          end_time: input.endTime ? toUnixTimestampSeconds(input.endTime, "endTime") : undefined,
        },
      });
    },
  },
  {
    name: "feishu.im.search_messages",
    feature: "im_search",
    definition: {
      name: "feishu.im.search_messages",
      description: "Search messages across chats.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Message search keyword." },
          chatIds: { type: "array", description: "Optional chat IDs to narrow the search.", items: { type: "string" } },
          senderIds: { type: "array", description: "Optional sender open_id list.", items: { type: "string" } },
          startTime: { type: "string", description: "Optional ISO time or unix timestamp in seconds." },
          endTime: { type: "string", description: "Optional ISO time or unix timestamp in seconds." },
          pageSize: { type: "number", description: "Page size, 1-50." },
          pageToken: { type: "string", description: "Pagination token from the previous page." },
        },
        required: [],
      },
    },
    async execute(input, config) {
      const { client } = createFeishuApiClient(config);
      const body: JsonObject = {};
      const query = asString(input.query);
      if (query) {
        body.query = query;
      }

      const filter: JsonObject = {};
      const chatIds = asStringArray(input.chatIds);
      const senderIds = asStringArray(input.senderIds);
      if (chatIds.length > 0) {
        filter.chat_ids = chatIds;
      }
      if (senderIds.length > 0) {
        filter.sender_ids = senderIds;
      }
      if (input.startTime || input.endTime) {
        filter.time_range = {
          ...(input.startTime
            ? { start_time: toUnixTimestampSeconds(input.startTime, "startTime") }
            : {}),
          ...(input.endTime
            ? { end_time: toUnixTimestampSeconds(input.endTime, "endTime") }
            : {}),
        };
      }
      if (Object.keys(filter).length > 0) {
        body.filter = filter;
      }

      return client.requestJson({
        path: "/open-apis/im/v1/messages/search",
        method: "POST",
        query: {
          page_size: Math.min(Math.max(asNumber(input.pageSize, 20) || 20, 1), 50),
          page_token: asString(input.pageToken) || undefined,
        },
        body,
      });
    },
  },
  {
    name: "feishu.im.send_text_message",
    feature: "im_send",
    definition: {
      name: "feishu.im.send_text_message",
      description: "Send a text message to a chat or user as the connected Feishu user.",
      parameters: {
        type: "object",
        properties: {
          chatId: { type: "string", description: "Chat ID, for example oc_xxx." },
          userId: { type: "string", description: "Alternative to chatId. Provide a user open_id to send a P2P message." },
          text: { type: "string", description: "Text message content." },
          idempotencyKey: { type: "string", description: "Optional idempotency key." },
        },
        required: ["text"],
      },
    },
    async execute(input, config) {
      const { client } = createFeishuApiClient(config);
      const text = asString(input.text);
      if (!text) {
        throw new Error("text is required.");
      }

      const chatId = asString(input.chatId);
      const userId = asString(input.userId);
      if (!chatId && !userId) {
        throw new Error("Provide chatId or userId.");
      }

      const receiveIdType = userId ? "open_id" : "chat_id";
      const receiveId = userId || chatId;
      return client.requestJson({
        path: "/open-apis/im/v1/messages",
        method: "POST",
        query: {
          receive_id_type: receiveIdType,
        },
        body: {
          receive_id: receiveId,
          msg_type: "text",
          content: JSON.stringify({ text }),
          ...(asString(input.idempotencyKey)
            ? { uuid: asString(input.idempotencyKey) }
            : {}),
        },
      });
    },
  },
  {
    name: "feishu.calendar.list_events",
    feature: "calendar",
    definition: {
      name: "feishu.calendar.list_events",
      description: "List calendar events in a time range.",
      parameters: {
        type: "object",
        properties: {
          calendarId: { type: "string", description: "Calendar ID. Defaults to primary." },
          startTime: { type: "string", description: "Start time as ISO string or unix timestamp in seconds." },
          endTime: { type: "string", description: "End time as ISO string or unix timestamp in seconds." },
        },
        required: ["startTime", "endTime"],
      },
    },
    async execute(input, config) {
      const { client } = createFeishuApiClient(config);
      const calendarId = asString(input.calendarId) || "primary";
      return client.requestJson({
        path: `/open-apis/calendar/v4/calendars/${encodeURIComponent(calendarId)}/events/instance_view`,
        query: {
          start_time: toUnixTimestampSeconds(input.startTime, "startTime"),
          end_time: toUnixTimestampSeconds(input.endTime, "endTime"),
        },
      });
    },
  },
  {
    name: "feishu.calendar.create_event",
    feature: "calendar",
    definition: {
      name: "feishu.calendar.create_event",
      description: "Create a calendar event and optionally invite attendees.",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string", description: "Event title." },
          description: { type: "string", description: "Optional event description." },
          calendarId: { type: "string", description: "Calendar ID. Defaults to primary." },
          startTime: { type: "string", description: "Start time as ISO string or unix timestamp in seconds." },
          endTime: { type: "string", description: "End time as ISO string or unix timestamp in seconds." },
          attendeeIds: { type: "array", description: "Optional attendee IDs. Supports ou_, oc_, and omm_ prefixes.", items: { type: "string" } },
          rrule: { type: "string", description: "Optional RFC5545 recurrence rule." },
        },
        required: ["summary", "startTime", "endTime"],
      },
    },
    async execute(input, config) {
      const { client } = createFeishuApiClient(config);
      const calendarId = asString(input.calendarId) || "primary";
      const event = await client.requestJson<{ event?: { event_id?: string } }>({
        path: `/open-apis/calendar/v4/calendars/${encodeURIComponent(calendarId)}/events`,
        method: "POST",
        body: {
          summary: asString(input.summary),
          description: asString(input.description) || undefined,
          start_time: {
            timestamp: toUnixTimestampSeconds(input.startTime, "startTime"),
          },
          end_time: {
            timestamp: toUnixTimestampSeconds(input.endTime, "endTime"),
          },
          attendee_ability: "can_modify_event",
          free_busy_status: "busy",
          ...(asString(input.rrule)
            ? { recurrence: asString(input.rrule) }
            : {}),
        },
      });

      const attendeeIds = normalizeCalendarAttendees(input.attendeeIds);
      if (attendeeIds.length > 0 && event.event?.event_id) {
        await client.requestJson({
          path: `/open-apis/calendar/v4/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(event.event.event_id)}/attendees`,
          method: "POST",
          query: {
            user_id_type: "open_id",
          },
          body: {
            attendees: attendeeIds,
            need_notification: true,
          },
        });
      }

      return event;
    },
  },
  {
    name: "feishu.sheets.read_values",
    feature: "sheets",
    definition: {
      name: "feishu.sheets.read_values",
      description: "Read cell values from a spreadsheet range.",
      parameters: {
        type: "object",
        properties: {
          spreadsheetToken: { type: "string", description: "Spreadsheet token." },
          range: { type: "string", description: "Read range such as Sheet1!A1:D10." },
          valueRenderOption: { type: "string", description: "Optional render mode." },
        },
        required: ["spreadsheetToken", "range"],
      },
    },
    async execute(input, config) {
      const { client } = createFeishuApiClient(config);
      const token = asString(input.spreadsheetToken);
      const range = asString(input.range);
      if (!token || !range) {
        throw new Error("spreadsheetToken and range are required.");
      }

      return client.requestJson({
        path: `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(token)}/values/${encodeURIComponent(range)}`,
        query: {
          valueRenderOption: asString(input.valueRenderOption) || undefined,
        },
      });
    },
  },
  {
    name: "feishu.sheets.write_values",
    feature: "sheets",
    definition: {
      name: "feishu.sheets.write_values",
      description: "Overwrite values in a spreadsheet range.",
      parameters: {
        type: "object",
        properties: {
          spreadsheetToken: { type: "string", description: "Spreadsheet token." },
          range: { type: "string", description: "Write range such as Sheet1!A1:D10." },
          values: jsonArrayProperty("Two-dimensional array of cell values."),
        },
        required: ["spreadsheetToken", "range", "values"],
      },
    },
    async execute(input, config) {
      const { client } = createFeishuApiClient(config);
      const token = asString(input.spreadsheetToken);
      const range = asString(input.range);
      const values = parseJsonArrayInput(input.values, "values");
      if (!token || !range) {
        throw new Error("spreadsheetToken and range are required.");
      }

      return client.requestJson({
        path: `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(token)}/values`,
        method: "PUT",
        body: {
          valueRange: {
            range,
            values,
          },
        },
      });
    },
  },
  {
    name: "feishu.base.list_records",
    feature: "base",
    definition: {
      name: "feishu.base.list_records",
      description: "List Bitable records from one table.",
      parameters: {
        type: "object",
        properties: {
          appToken: { type: "string", description: "Bitable app token." },
          tableId: { type: "string", description: "Bitable table ID." },
          viewId: { type: "string", description: "Optional Bitable view ID." },
          filter: { type: "string", description: "Optional filter expression." },
          pageSize: { type: "number", description: "Page size." },
          pageToken: { type: "string", description: "Pagination token from the previous page." },
        },
        required: ["appToken", "tableId"],
      },
    },
    async execute(input, config) {
      const { client } = createFeishuApiClient(config);
      const appToken = asString(input.appToken);
      const tableId = asString(input.tableId);
      if (!appToken || !tableId) {
        throw new Error("appToken and tableId are required.");
      }

      return client.requestJson({
        path: `/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records`,
        query: {
          view_id: asString(input.viewId) || undefined,
          filter: asString(input.filter) || undefined,
          page_size: asNumber(input.pageSize, 20) || 20,
          page_token: asString(input.pageToken) || undefined,
        },
      });
    },
  },
  {
    name: "feishu.base.create_record",
    feature: "base",
    definition: {
      name: "feishu.base.create_record",
      description: "Create a Bitable record.",
      parameters: {
        type: "object",
        properties: {
          appToken: { type: "string", description: "Bitable app token." },
          tableId: { type: "string", description: "Bitable table ID." },
          fields: jsonObjectProperty("Record fields as a JSON object."),
        },
        required: ["appToken", "tableId", "fields"],
      },
    },
    async execute(input, config) {
      const { client } = createFeishuApiClient(config);
      const appToken = asString(input.appToken);
      const tableId = asString(input.tableId);
      const fields = parseJsonObjectInput(input.fields, "fields");
      if (!appToken || !tableId) {
        throw new Error("appToken and tableId are required.");
      }

      return client.requestJson({
        path: `/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records`,
        method: "POST",
        body: {
          fields,
        },
      });
    },
  },
  {
    name: "feishu.task.create_task",
    feature: "task",
    definition: {
      name: "feishu.task.create_task",
      description: "Create a Feishu task.",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string", description: "Task title." },
          description: { type: "string", description: "Optional task description." },
          assigneeOpenId: { type: "string", description: "Optional assignee open_id." },
          tasklistGuid: { type: "string", description: "Optional task list GUID." },
          dueTime: { type: "string", description: "Optional due time as ISO string or unix timestamp in milliseconds." },
        },
        required: ["summary"],
      },
    },
    async execute(input, config) {
      const { client } = createFeishuApiClient(config);
      const body: JsonObject = {
        summary: asString(input.summary),
      };
      if (asString(input.description)) {
        body.description = asString(input.description);
      }
      if (asString(input.assigneeOpenId)) {
        body.members = [
          {
            id: asString(input.assigneeOpenId),
            role: "assignee",
            type: "user",
          },
        ];
      }
      if (asString(input.tasklistGuid)) {
        body.tasklists = [
          {
            tasklist_guid: asString(input.tasklistGuid),
          },
        ];
      }
      if (asString(input.dueTime)) {
        const parsed = Date.parse(asString(input.dueTime));
        body.due = {
          timestamp: Number.isNaN(parsed)
            ? asString(input.dueTime)
            : String(parsed),
          is_all_day: false,
        };
      }

      return client.requestJson({
        path: "/open-apis/task/v2/tasks",
        method: "POST",
        query: {
          user_id_type: "open_id",
        },
        body,
      });
    },
  },
  {
    name: "feishu.drive.upload_file",
    feature: "drive",
    definition: {
      name: "feishu.drive.upload_file",
      description: "Upload a Synapse FileRef to Feishu Drive.",
      parameters: {
        type: "object",
        properties: {
          fileRef: {
            type: "string",
            description: "The FileRef to upload to Feishu Drive.",
          },
          folderToken: { type: "string", description: "Optional target folder token." },
          fileName: { type: "string", description: "Optional destination file name." },
        },
        required: ["fileRef"],
      },
    },
    async execute(input, config) {
      const { client } = createFeishuApiClient(config);
      const record = await resolveFileRefRecord(input.fileRef, "fileRef");
      const buffer = await fileToBuffer(record.storedName);

      const form = new FormData();
      form.append("file_name", asString(input.fileName) || record.originalName);
      form.append("parent_type", "explorer");
      form.append("parent_node", asString(input.folderToken));
      form.append("size", String(record.sizeBytes));
      form.append(
        "file",
        new Blob([bufferToArrayBuffer(buffer)], { type: record.mimeType }),
        asString(input.fileName) || record.originalName,
      );

      return client.requestJson({
        path: "/open-apis/drive/v1/files/upload_all",
        method: "POST",
        body: form,
      });
    },
  },
  {
    name: "feishu.drive.download_file",
    feature: "drive",
    definition: {
      name: "feishu.drive.download_file",
      description: "Download a Feishu Drive file into the Synapse file system and return a FileRef.",
      parameters: {
        type: "object",
        properties: {
          fileToken: { type: "string", description: "Feishu Drive file token." },
          fileName: { type: "string", description: "Optional output file name override." },
        },
        required: ["fileToken"],
      },
    },
    async execute(input, config) {
      const { client } = createFeishuApiClient(config);
      const fileToken = asString(input.fileToken);
      const workspaceId = getWorkspaceId(config);
      if (!fileToken) {
        throw new Error("fileToken is required.");
      }
      if (!workspaceId) {
        throw new Error("workspace_id is missing from plugin runtime config.");
      }

      const result = await client.requestBuffer({
        path: `/open-apis/drive/v1/files/${encodeURIComponent(fileToken)}/download`,
      });
      const originalName =
        asString(input.fileName) ||
        parseContentDispositionFilename(result.contentDisposition, `${fileToken}.bin`);
      const saved = await saveFromBuffer(
        result.buffer,
        originalName,
        result.contentType,
        workspaceId,
        null,
        "plugin_output",
        {
          provider: "feishu",
          source: "drive.download_file",
          fileToken,
        },
      );

      return [
        {
          type: "text",
          text: `Downloaded Feishu Drive file ${fileToken} as ${saved.originalName}.`,
        },
        pluginOutputFileRef(saved),
      ];
    },
  },
];

const feishuToolMap = new Map(
  feishuToolSpecs.map((tool) => [tool.name, tool]),
);

function getEnabledFeatures(config: Record<string, unknown>) {
  const features = normalizeFeishuFeatureKeys(config.features);
  return features.length > 0 ? features : DEFAULT_FEISHU_FEATURES;
}

export function getFeishuToolDefinitions(config: Record<string, unknown> = {}): ToolDefinition[] {
  const enabled = new Set<FeishuFeatureKey>(getEnabledFeatures(config));
  return feishuToolSpecs
    .filter((tool) => enabled.has(tool.feature))
    .map((tool) => tool.definition);
}

export async function executeFeishuTool(
  toolName: string,
  input: Record<string, unknown>,
  config: Record<string, unknown>,
) {
  const tool = feishuToolMap.get(toolName);
  if (!tool) {
    throw new Error(`Unknown Feishu tool '${toolName}'.`);
  }

  const enabled = new Set<FeishuFeatureKey>(getEnabledFeatures(config));
  if (!enabled.has(tool.feature)) {
    throw new Error(
      `The Feishu feature '${tool.feature}' is not enabled for this installation.`,
    );
  }

  return tool.execute(input, config);
}
