import { randomUUID } from "node:crypto"
import {
  fromUnixSeconds,
  requireEpochMillis,
  fromExternalRfc3339,
  parseIsoInstant,
} from "@synapse/shared/datetime"
import {
  FILE_ORIGIN_SYSTEMS,
  parseJsonObject,
  textBlock,
  textBlocks,
  type ToolDefinition,
  type ToolParameterProperty,
} from "@synapse/shared"
import type { BuiltinPluginExecuteResult } from "../builtin/index.js"
import {
  fileToBuffer,
  saveFromBuffer,
} from "../../../infrastructure/storage/file-io.js"
import { buildExternalImportOrigin } from "../../files/service.js"
import { pluginOutputFileRef, resolveFileRefRecord } from "../file-ref.js"
import {
  createFeishuApiClient,
  parseJsonArrayInput,
  parseJsonObjectInput,
} from "./client.js"
import {
  DEFAULT_FEISHU_FEATURES,
  type FeishuFeatureKey,
  normalizeFeishuFeatureKeys,
} from "./features.js"

type JsonObject = Record<string, unknown>

/**
 * Wrap a Feishu API JSON response into a CallableToolResult that preserves
 * the structured payload via structuredContent while still surfacing a
 * human-readable JSON text block. Without this wrapper, the runtime
 * normalizer would also stringify the object, but at the type level
 * BuiltinPluginExecuteResult no longer accepts arbitrary objects — every
 * sub-feature must produce canonical content blocks at its handler
 * boundary.
 */
function jsonResult(value: unknown): BuiltinPluginExecuteResult {
  const structured =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : { value }
  return {
    content: textBlocks(JSON.stringify(value)),
    structuredContent: structured,
  }
}

type FeishuToolSpec = {
  name: string
  feature: FeishuFeatureKey
  definition: ToolDefinition
  execute: (
    input: Record<string, unknown>,
    config: Record<string, unknown>
  ) => Promise<BuiltinPluginExecuteResult>
}

const jsonObjectProperty = (description: string): ToolParameterProperty => ({
  type: "object",
  description,
})

const jsonArrayProperty = (description: string): ToolParameterProperty => ({
  type: "array",
  description,
})

function asString(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
}

// Business JSON decode → shared parseJsonObject (object-only, array-reject). r6 P1-8.
const asObject = parseJsonObject

function asNumber(value: unknown, fallback = 0) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }
  return fallback
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string")
  }
  if (typeof value === "string" && value.trim().length > 0) {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  }
  return []
}

function getWorkspaceId(config: Record<string, unknown>) {
  return asString(config.workspace_id) || null
}

async function resolveChatIdFromInput(
  client: ReturnType<typeof createFeishuApiClient>["client"],
  input: Record<string, unknown>
) {
  const directChatId = asString(input.chatId)
  if (directChatId) {
    return directChatId
  }

  const userId = asString(input.userId)
  if (!userId) {
    throw new Error("Provide either chatId or userId.")
  }

  const data = await client.requestJson<{
    p2p_chats?: Array<{ chat_id?: string }>
  }>({
    path: "/open-apis/im/v1/chat_p2p/batch_query",
    method: "POST",
    query: {
      chatter_id_type: "open_id",
    },
    body: {
      chatter_ids: [userId],
    },
  })
  const chatId = data.p2p_chats?.[0]?.chat_id
  if (!chatId) {
    throw new Error("P2P chat not found for the provided userId.")
  }
  return chatId
}

function parseContentDispositionFilename(value: string, fallback: string) {
  const utf8Match = value.match(/filename\*=UTF-8''([^;]+)/i)
  if (utf8Match?.[1]) {
    return decodeURIComponent(utf8Match[1])
  }
  const plainMatch = value.match(/filename="?([^"]+)"?/i)
  return plainMatch?.[1] || fallback
}

function bufferToArrayBuffer(buffer: Buffer) {
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength
  ) as ArrayBuffer
}

function toUnixTimestampSeconds(value: unknown, label: string) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.floor(value).toString()
  }
  if (typeof value === "string" && value.trim().length > 0) {
    if (/^\d+$/.test(value.trim())) {
      return value.trim()
    }
    // ISO/RFC3339 string — route through the canonical parser (C1). A fully
    // unparseable value makes fromExternalRfc3339 throw, which propagates as the
    // existing "must be an ISO time string or a unix timestamp" error below.
    return Math.floor(
      parseIsoInstant(fromExternalRfc3339(value.trim())).getTime() / 1000
    ).toString()
  }
  throw new Error(
    `${label} must be an ISO time string or a unix timestamp in seconds.`
  )
}

function normalizeCalendarAttendees(value: unknown) {
  return asStringArray(value).map((id) => {
    if (id.startsWith("oc_")) {
      return { type: "chat", chat_id: id }
    }
    if (id.startsWith("omm_")) {
      return { type: "resource", room_id: id }
    }
    return { type: "user", user_id: id }
  })
}

type FeishuDocumentRef = {
  kind: "doc" | "docx" | "wiki"
  token: string
}

const FEISHU_DOC_MEDIA_MAX_BYTES = 20 * 1024 * 1024
const FEISHU_DOC_IMAGE_ALIGN: Record<string, number> = {
  left: 1,
  center: 2,
  right: 3,
}
const FEISHU_DOC_MEDIA_EXTENSIONS: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
  "application/pdf": ".pdf",
  "video/mp4": ".mp4",
  "text/plain": ".txt",
}

function extractFeishuDocumentToken(raw: string, marker: string) {
  const index = raw.indexOf(marker)
  if (index < 0) {
    return ""
  }

  let token = raw.slice(index + marker.length)
  const endIndex = token.search(/[/?#]/)
  if (endIndex >= 0) {
    token = token.slice(0, endIndex)
  }
  return token.trim()
}

function parseFeishuDocumentRef(
  value: unknown,
  label: string
): FeishuDocumentRef {
  const raw = asString(value)
  if (!raw) {
    throw new Error(`${label} is required.`)
  }

  const wikiToken = extractFeishuDocumentToken(raw, "/wiki/")
  if (wikiToken) {
    return {
      kind: "wiki",
      token: wikiToken,
    }
  }

  const docxToken = extractFeishuDocumentToken(raw, "/docx/")
  if (docxToken) {
    return {
      kind: "docx",
      token: docxToken,
    }
  }

  const docToken = extractFeishuDocumentToken(raw, "/doc/")
  if (docToken) {
    return {
      kind: "doc",
      token: docToken,
    }
  }

  if (raw.includes("://")) {
    throw new Error(
      `${label} must be a docx token, a /docx/ URL, or a /wiki/ URL that resolves to docx.`
    )
  }

  if (/[/?#]/.test(raw)) {
    throw new Error(
      `${label} must be a docx token or a supported document URL.`
    )
  }

  return {
    kind: "docx",
    token: raw,
  }
}

async function resolveFeishuDocxDocumentId(
  client: ReturnType<typeof createFeishuApiClient>["client"],
  value: unknown,
  label: string
) {
  const ref = parseFeishuDocumentRef(value, label)
  if (ref.kind === "docx") {
    return ref.token
  }
  if (ref.kind === "doc") {
    throw new Error(`${label} must refer to a docx document.`)
  }

  const result = await client.requestJson<{
    node?: {
      obj_type?: string
      obj_token?: string
    }
  }>({
    path: "/open-apis/wiki/v2/spaces/get_node",
    query: {
      token: ref.token,
    },
  })
  const objType = asString(result.node?.obj_type)
  const objToken = asString(result.node?.obj_token)
  if (!objType || !objToken) {
    throw new Error("Feishu wiki resolution returned incomplete node data.")
  }
  if (objType !== "docx") {
    throw new Error(
      `The wiki node resolved to '${objType}', not a docx document.`
    )
  }
  return objToken
}

function normalizeDocSearchTimeRange(filter: JsonObject, key: string) {
  const range = asObject(filter[key])
  if (Object.keys(range).length === 0) {
    return
  }

  const normalized: JsonObject = {}
  if (range.start !== undefined) {
    normalized.start = Number(
      toUnixTimestampSeconds(range.start, `${key}.start`)
    )
  }
  if (range.end !== undefined) {
    normalized.end = Number(toUnixTimestampSeconds(range.end, `${key}.end`))
  }
  filter[key] = normalized
}

function buildFeishuDocSearchRequest(input: Record<string, unknown>) {
  const request: JsonObject = {
    query: asString(input.query),
    page_size: Math.min(Math.max(asNumber(input.pageSize, 15) || 15, 1), 20),
  }
  const pageToken = asString(input.pageToken)
  if (pageToken) {
    request.page_token = pageToken
  }

  const rawFilter = input.filter
  if (
    rawFilter === undefined ||
    rawFilter === null ||
    (typeof rawFilter === "string" && rawFilter.trim().length === 0)
  ) {
    request.doc_filter = {}
    request.wiki_filter = {}
    return request
  }

  const filter = parseJsonObjectInput(rawFilter, "filter")
  normalizeDocSearchTimeRange(filter, "open_time")
  normalizeDocSearchTimeRange(filter, "create_time")
  request.doc_filter = filter
  request.wiki_filter = { ...filter }
  return request
}

function serializeUnixTimestampToInstant(value: unknown) {
  let seconds: number
  if (typeof value === "number") {
    seconds = value
  } else if (typeof value === "string" && value.trim() !== "") {
    seconds = Number(value.trim())
  } else {
    seconds = Number.NaN
  }
  if (!Number.isFinite(seconds)) return undefined
  try {
    // Feishu drive metadata timestamps are Unix seconds.
    return fromUnixSeconds(seconds)
  } catch {
    // Implausible value -> omit the enriched *_iso field (honest absence, not a
    // fabricated time). This is display-only search-result enrichment.
    return undefined
  }
}

function addIsoTimeFieldsToDocSearchResults(results: unknown[]) {
  return results.map((item) => {
    const unit = asObject(item)
    const resultMeta = { ...asObject(unit.result_meta) }
    for (const field of ["create_time", "open_time", "update_time"] as const) {
      const iso = serializeUnixTimestampToInstant(resultMeta[field])
      if (iso) {
        resultMeta[`${field}_iso`] = iso
      }
    }
    return Object.assign({}, unit, { result_meta: resultMeta })
  })
}

async function listFeishuDocumentRootChildren(
  client: ReturnType<typeof createFeishuApiClient>["client"],
  documentId: string
) {
  const items: JsonObject[] = []
  let pageToken = ""

  for (;;) {
    const page = await client.requestJson<{
      items?: unknown[]
      has_more?: boolean
      page_token?: string
    }>({
      path: `/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/blocks/${encodeURIComponent(documentId)}/children`,
      query: {
        page_size: 200,
        page_token: pageToken || undefined,
      },
    })

    if (Array.isArray(page.items)) {
      items.push(...page.items.map((item) => asObject(item)))
    }

    if (!page.has_more || !asString(page.page_token)) {
      break
    }
    pageToken = asString(page.page_token)
  }

  return items
}

async function clearFeishuDocumentContent(
  client: ReturnType<typeof createFeishuApiClient>["client"],
  documentId: string
) {
  const rootChildren = await listFeishuDocumentRootChildren(client, documentId)
  if (rootChildren.length === 0) {
    return 0
  }

  await client.requestJson({
    path: `/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/blocks/${encodeURIComponent(documentId)}/children/batch_delete`,
    method: "DELETE",
    query: {
      client_token: randomUUID(),
    },
    body: {
      start_index: 0,
      end_index: rootChildren.length,
    },
  })

  return rootChildren.length
}

async function convertMarkdownToFeishuDocBlocks(
  client: ReturnType<typeof createFeishuApiClient>["client"],
  markdown: string
) {
  const converted = await client.requestJson<{
    first_level_block_ids?: unknown[]
    blocks?: unknown[]
  }>({
    path: "/open-apis/docx/v1/documents/blocks/convert",
    method: "POST",
    body: {
      content_type: "markdown",
      content: markdown,
    },
  })

  const firstLevelBlockIds = Array.isArray(converted.first_level_block_ids)
    ? converted.first_level_block_ids.filter(
        (item): item is string => typeof item === "string" && item.length > 0
      )
    : []
  const descendants = Array.isArray(converted.blocks)
    ? converted.blocks.map((block) => {
        const { parent_id, ...rest } = asObject(block)
        return rest
      })
    : []

  return {
    firstLevelBlockIds,
    descendants,
  }
}

async function insertConvertedFeishuDocumentBlocks(
  client: ReturnType<typeof createFeishuApiClient>["client"],
  documentId: string,
  converted: {
    firstLevelBlockIds: string[]
    descendants: JsonObject[]
  },
  index: number
) {
  if (
    converted.firstLevelBlockIds.length === 0 ||
    converted.descendants.length === 0
  ) {
    return {
      insertedBlocks: 0,
    }
  }

  await client.requestJson({
    path: `/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/blocks/${encodeURIComponent(documentId)}/descendant`,
    method: "POST",
    body: {
      children_id: converted.firstLevelBlockIds,
      index,
      descendants: converted.descendants,
    },
  })

  return {
    insertedBlocks: converted.firstLevelBlockIds.length,
  }
}

function getFeishuDocMediaBlockType(mediaType: "file" | "image") {
  return mediaType === "file" ? 23 : 27
}

function getFeishuDocMediaParentType(mediaType: "file" | "image") {
  return mediaType === "file" ? "docx_file" : "docx_image"
}

function buildFeishuDocMediaCreateBlockBody(
  mediaType: "file" | "image",
  index: number
) {
  const child: JsonObject = {
    block_type: getFeishuDocMediaBlockType(mediaType),
  }
  child[mediaType] = {}
  return {
    children: [child],
    index,
  }
}

function buildFeishuDocMediaRouteExtra(documentId: string) {
  return JSON.stringify({
    drive_route_token: documentId,
  })
}

function extractFeishuDocMediaTargets(
  createResult: unknown,
  mediaType: "file" | "image"
) {
  const children = Array.isArray(asObject(createResult).children)
    ? (asObject(createResult).children as unknown[])
    : []
  const child = asObject(children[0])
  const blockId = asString(child.block_id)
  let uploadParentNode = blockId
  let replaceBlockId = blockId

  if (
    mediaType === "file" &&
    Array.isArray(child.children) &&
    typeof child.children[0] === "string"
  ) {
    uploadParentNode = child.children[0]
    replaceBlockId = child.children[0]
  }

  if (!blockId || !uploadParentNode || !replaceBlockId) {
    throw new Error(
      "Feishu did not return the created media block identifiers."
    )
  }

  return {
    blockId,
    uploadParentNode,
    replaceBlockId,
  }
}

function buildFeishuDocMediaReplaceBody(input: {
  blockId: string
  mediaType: "file" | "image"
  fileToken: string
  align?: string
  caption?: string
}) {
  const request: JsonObject = {
    block_id: input.blockId,
  }

  if (input.mediaType === "file") {
    request.replace_file = {
      token: input.fileToken,
    }
  } else {
    const replaceImage: JsonObject = {
      token: input.fileToken,
    }
    const align = asString(input.align).toLowerCase()
    if (FEISHU_DOC_IMAGE_ALIGN[align]) {
      replaceImage.align = FEISHU_DOC_IMAGE_ALIGN[align]
    }
    const caption = asString(input.caption)
    if (caption) {
      replaceImage.caption = {
        content: caption,
      }
    }
    request.replace_image = replaceImage
  }

  return {
    requests: [request],
  }
}

function guessFileExtensionFromContentType(
  contentType: string,
  fallback = ".bin"
) {
  const mimeType = contentType.split(";")[0]?.trim().toLowerCase()
  return FEISHU_DOC_MEDIA_EXTENSIONS[mimeType] || fallback
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
          pageToken: {
            type: "string",
            description: "Pagination token from the previous page.",
          },
        },
        required: ["query"],
      },
    },
    async execute(input, config) {
      const { client } = createFeishuApiClient(config)
      return jsonResult(
        await client.requestJson({
          path: "/open-apis/search/v1/user",
          query: {
            query: asString(input.query),
            page_size: asNumber(input.pageSize, 20) || 20,
            page_token: asString(input.pageToken) || undefined,
          },
        })
      )
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
          userId: {
            type: "string",
            description:
              "Optional Feishu open_id. Omit to read the current authorized user.",
          },
        },
        required: [],
      },
    },
    async execute(input, config) {
      const { client } = createFeishuApiClient(config)
      const userId = asString(input.userId)
      if (!userId) {
        return jsonResult(
          await client.requestJson({
            path: "/open-apis/authen/v1/user_info",
          })
        )
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
      })

      return jsonResult({
        user: Array.isArray(data.users) ? data.users[0] || null : null,
      })
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
          memberIds: {
            type: "array",
            description: "Optional open_id list to restrict the chat search.",
            items: { type: "string" },
          },
          pageSize: { type: "number", description: "Page size, 1-100." },
          pageToken: {
            type: "string",
            description: "Pagination token from the previous page.",
          },
        },
        required: [],
      },
    },
    async execute(input, config) {
      const { client } = createFeishuApiClient(config)
      const body: JsonObject = {}
      const query = asString(input.query)
      const memberIds = asStringArray(input.memberIds)
      if (!query && memberIds.length === 0) {
        throw new Error("Provide query or memberIds.")
      }
      if (query) {
        body.query = query
      }
      if (memberIds.length > 0) {
        body.filter = { member_ids: memberIds }
      }

      return jsonResult(
        await client.requestJson({
          path: "/open-apis/im/v2/chats/search",
          method: "POST",
          query: {
            page_size: asNumber(input.pageSize, 20) || 20,
            page_token: asString(input.pageToken) || undefined,
          },
          body,
        })
      )
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
          chatId: {
            type: "string",
            description: "Chat ID, for example oc_xxx.",
          },
          userId: {
            type: "string",
            description:
              "Alternative to chatId. Provide a user open_id to resolve the P2P chat first.",
          },
          startTime: {
            type: "string",
            description: "Optional ISO time or unix timestamp in seconds.",
          },
          endTime: {
            type: "string",
            description: "Optional ISO time or unix timestamp in seconds.",
          },
          sort: {
            type: "string",
            description: "Sort order.",
            enum: ["asc", "desc"],
          },
          pageSize: { type: "number", description: "Page size, 1-50." },
          pageToken: {
            type: "string",
            description: "Pagination token from the previous page.",
          },
        },
        required: [],
      },
    },
    async execute(input, config) {
      const { client } = createFeishuApiClient(config)
      const chatId = await resolveChatIdFromInput(client, input)

      return jsonResult(
        await client.requestJson({
          path: "/open-apis/im/v1/messages",
          query: {
            container_id_type: "chat",
            container_id: chatId,
            sort_type:
              asString(input.sort) === "asc"
                ? "ByCreateTimeAsc"
                : "ByCreateTimeDesc",
            page_size: Math.min(
              Math.max(asNumber(input.pageSize, 50) || 50, 1),
              50
            ),
            page_token: asString(input.pageToken) || undefined,
            card_msg_content_type: "raw_card_content",
            start_time: input.startTime
              ? toUnixTimestampSeconds(input.startTime, "startTime")
              : undefined,
            end_time: input.endTime
              ? toUnixTimestampSeconds(input.endTime, "endTime")
              : undefined,
          },
        })
      )
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
          chatIds: {
            type: "array",
            description: "Optional chat IDs to narrow the search.",
            items: { type: "string" },
          },
          senderIds: {
            type: "array",
            description: "Optional sender open_id list.",
            items: { type: "string" },
          },
          startTime: {
            type: "string",
            description: "Optional ISO time or unix timestamp in seconds.",
          },
          endTime: {
            type: "string",
            description: "Optional ISO time or unix timestamp in seconds.",
          },
          pageSize: { type: "number", description: "Page size, 1-50." },
          pageToken: {
            type: "string",
            description: "Pagination token from the previous page.",
          },
        },
        required: [],
      },
    },
    async execute(input, config) {
      const { client } = createFeishuApiClient(config)
      const body: JsonObject = {}
      const query = asString(input.query)
      if (query) {
        body.query = query
      }

      const filter: JsonObject = {}
      const chatIds = asStringArray(input.chatIds)
      const senderIds = asStringArray(input.senderIds)
      if (chatIds.length > 0) {
        filter.chat_ids = chatIds
      }
      if (senderIds.length > 0) {
        filter.sender_ids = senderIds
      }
      if (input.startTime || input.endTime) {
        filter.time_range = {
          ...(input.startTime
            ? {
                start_time: toUnixTimestampSeconds(
                  input.startTime,
                  "startTime"
                ),
              }
            : {}),
          ...(input.endTime
            ? { end_time: toUnixTimestampSeconds(input.endTime, "endTime") }
            : {}),
        }
      }
      if (Object.keys(filter).length > 0) {
        body.filter = filter
      }

      return jsonResult(
        await client.requestJson({
          path: "/open-apis/im/v1/messages/search",
          method: "POST",
          query: {
            page_size: Math.min(
              Math.max(asNumber(input.pageSize, 20) || 20, 1),
              50
            ),
            page_token: asString(input.pageToken) || undefined,
          },
          body,
        })
      )
    },
  },
  {
    name: "feishu.im.send_text_message",
    feature: "im_send",
    definition: {
      name: "feishu.im.send_text_message",
      description:
        "Send a text message to a chat or user as the connected Feishu user.",
      parameters: {
        type: "object",
        properties: {
          chatId: {
            type: "string",
            description: "Chat ID, for example oc_xxx.",
          },
          userId: {
            type: "string",
            description:
              "Alternative to chatId. Provide a user open_id to send a P2P message.",
          },
          text: { type: "string", description: "Text message content." },
          idempotencyKey: {
            type: "string",
            description: "Optional idempotency key.",
          },
        },
        required: ["text"],
      },
    },
    async execute(input, config) {
      const { client } = createFeishuApiClient(config)
      const text = asString(input.text)
      if (!text) {
        throw new Error("text is required.")
      }

      const chatId = asString(input.chatId)
      const userId = asString(input.userId)
      if (!chatId && !userId) {
        throw new Error("Provide chatId or userId.")
      }

      const receiveIdType = userId ? "open_id" : "chat_id"
      const receiveId = userId || chatId
      return jsonResult(
        await client.requestJson({
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
        })
      )
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
          calendarId: {
            type: "string",
            description: "Calendar ID. Defaults to primary.",
          },
          startTime: {
            type: "string",
            description:
              "Start time as ISO string or unix timestamp in seconds.",
          },
          endTime: {
            type: "string",
            description: "End time as ISO string or unix timestamp in seconds.",
          },
        },
        required: ["startTime", "endTime"],
      },
    },
    async execute(input, config) {
      const { client } = createFeishuApiClient(config)
      const calendarId = asString(input.calendarId) || "primary"
      return jsonResult(
        await client.requestJson({
          path: `/open-apis/calendar/v4/calendars/${encodeURIComponent(calendarId)}/events/instance_view`,
          query: {
            start_time: toUnixTimestampSeconds(input.startTime, "startTime"),
            end_time: toUnixTimestampSeconds(input.endTime, "endTime"),
          },
        })
      )
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
          description: {
            type: "string",
            description: "Optional event description.",
          },
          calendarId: {
            type: "string",
            description: "Calendar ID. Defaults to primary.",
          },
          startTime: {
            type: "string",
            description:
              "Start time as ISO string or unix timestamp in seconds.",
          },
          endTime: {
            type: "string",
            description: "End time as ISO string or unix timestamp in seconds.",
          },
          attendeeIds: {
            type: "array",
            description:
              "Optional attendee IDs. Supports ou_, oc_, and omm_ prefixes.",
            items: { type: "string" },
          },
          rrule: {
            type: "string",
            description: "Optional RFC5545 recurrence rule.",
          },
        },
        required: ["summary", "startTime", "endTime"],
      },
    },
    async execute(input, config) {
      const { client } = createFeishuApiClient(config)
      const calendarId = asString(input.calendarId) || "primary"
      const event = await client.requestJson<{ event?: { event_id?: string } }>(
        {
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
        }
      )

      const attendeeIds = normalizeCalendarAttendees(input.attendeeIds)
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
        })
      }

      return jsonResult(event)
    },
  },
  {
    name: "feishu.docs.search",
    feature: "docs",
    definition: {
      name: "feishu.docs.search",
      description: "Search Feishu docs, wiki nodes, and sheets with Search v2.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Optional keyword query. Leave empty to use Feishu's default recent/discovery ranking.",
          },
          filter: jsonObjectProperty(
            "Optional filter object applied to both doc_filter and wiki_filter. open_time/create_time may use ISO time strings."
          ),
          pageSize: { type: "number", description: "Page size, 1-20." },
          pageToken: {
            type: "string",
            description: "Pagination token from the previous page.",
          },
        },
        required: [],
      },
    },
    async execute(input, config) {
      const { client } = createFeishuApiClient(config)
      const data = await client.requestJson<{
        total?: number
        has_more?: boolean
        page_token?: string
        res_units?: unknown[]
      }>({
        path: "/open-apis/search/v2/doc_wiki/search",
        method: "POST",
        body: buildFeishuDocSearchRequest(input),
      })

      return jsonResult({
        total: typeof data.total === "number" ? data.total : 0,
        has_more: Boolean(data.has_more),
        page_token: asString(data.page_token) || undefined,
        results: addIsoTimeFieldsToDocSearchResults(
          Array.isArray(data.res_units) ? data.res_units : []
        ),
      })
    },
  },
  {
    name: "feishu.docs.get_document",
    feature: "docs",
    definition: {
      name: "feishu.docs.get_document",
      description:
        "Get docx metadata and raw plain-text content. Rich formatting and embedded media are not reconstructed.",
      parameters: {
        type: "object",
        properties: {
          documentId: {
            type: "string",
            description:
              "Docx token, /docx/ URL, or a /wiki/ URL that resolves to docx.",
          },
        },
        required: ["documentId"],
      },
    },
    async execute(input, config) {
      const { client } = createFeishuApiClient(config)
      const documentId = await resolveFeishuDocxDocumentId(
        client,
        input.documentId,
        "documentId"
      )
      const [metadata, rawContent] = await Promise.all([
        client.requestJson<{
          document?: {
            document_id?: string
            revision_id?: number
            title?: string
          }
        }>({
          path: `/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}`,
        }),
        client.requestJson<{
          content?: string
        }>({
          path: `/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/raw_content`,
        }),
      ])

      return jsonResult({
        document_id: documentId,
        title: asString(metadata.document?.title),
        revision_id: metadata.document?.revision_id,
        content_type: "text/plain",
        content: asString(rawContent.content),
      })
    },
  },
  {
    name: "feishu.docs.create_document",
    feature: "docs",
    definition: {
      name: "feishu.docs.create_document",
      description:
        "Create a docx document and seed it from Lark-flavored Markdown.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Optional document title." },
          markdown: {
            type: "string",
            description:
              "Lark-flavored Markdown content used to initialize the document.",
          },
          folderToken: {
            type: "string",
            description: "Optional Feishu Drive folder token.",
          },
        },
        required: ["markdown"],
      },
    },
    async execute(input, config) {
      const { client } = createFeishuApiClient(config)
      const markdown = asString(input.markdown)
      if (!markdown) {
        throw new Error("markdown is required.")
      }
      const converted = await convertMarkdownToFeishuDocBlocks(client, markdown)

      const created = await client.requestJson<{
        document?: {
          document_id?: string
        }
      }>({
        path: "/open-apis/docx/v1/documents",
        method: "POST",
        body: {
          title: asString(input.title) || undefined,
          folder_token: asString(input.folderToken) || undefined,
        },
      })
      const documentId = asString(created.document?.document_id)
      if (!documentId) {
        throw new Error("Feishu did not return the created document_id.")
      }

      try {
        const writeResult = await insertConvertedFeishuDocumentBlocks(
          client,
          documentId,
          converted,
          0
        )
        const metadata = await client.requestJson<{
          document?: {
            revision_id?: number
            title?: string
          }
        }>({
          path: `/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}`,
        })

        return jsonResult({
          document_id: documentId,
          title: asString(metadata.document?.title),
          revision_id: metadata.document?.revision_id,
          inserted_blocks: writeResult.insertedBlocks,
        })
      } catch (error) {
        const reason = error instanceof Error ? error.message : "Unknown error"
        throw new Error(
          `Document ${documentId} was created, but the initial markdown import failed: ${reason}`
        )
      }
    },
  },
  {
    name: "feishu.docs.update_document",
    feature: "docs",
    definition: {
      name: "feishu.docs.update_document",
      description:
        "Append to a docx document or overwrite its current block content with Lark-flavored Markdown.",
      parameters: {
        type: "object",
        properties: {
          documentId: {
            type: "string",
            description:
              "Docx token, /docx/ URL, or a /wiki/ URL that resolves to docx.",
          },
          mode: {
            type: "string",
            description: "Update mode.",
            enum: ["append", "overwrite"],
          },
          markdown: {
            type: "string",
            description: "Lark-flavored Markdown content to write.",
          },
        },
        required: ["documentId", "mode", "markdown"],
      },
    },
    async execute(input, config) {
      const { client } = createFeishuApiClient(config)
      const documentId = await resolveFeishuDocxDocumentId(
        client,
        input.documentId,
        "documentId"
      )
      const mode = asString(input.mode)
      const markdown = asString(input.markdown)
      if (mode !== "append" && mode !== "overwrite") {
        throw new Error("mode must be either 'append' or 'overwrite'.")
      }
      if (!markdown) {
        throw new Error("markdown is required.")
      }
      const converted = await convertMarkdownToFeishuDocBlocks(client, markdown)

      let clearedBlocks = 0
      let insertIndex = 0

      if (mode === "overwrite") {
        clearedBlocks = await clearFeishuDocumentContent(client, documentId)
      } else {
        const rootChildren = await listFeishuDocumentRootChildren(
          client,
          documentId
        )
        insertIndex = rootChildren.length
      }

      const writeResult = await insertConvertedFeishuDocumentBlocks(
        client,
        documentId,
        converted,
        insertIndex
      )

      const metadata = await client.requestJson<{
        document?: {
          revision_id?: number
          title?: string
        }
      }>({
        path: `/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}`,
      })

      return jsonResult({
        document_id: documentId,
        mode,
        title: asString(metadata.document?.title),
        revision_id: metadata.document?.revision_id,
        insert_index: insertIndex,
        inserted_blocks: writeResult.insertedBlocks,
        cleared_blocks: clearedBlocks,
      })
    },
  },
  {
    name: "feishu.docs.insert_media",
    feature: "docs_media",
    definition: {
      name: "feishu.docs.insert_media",
      description:
        "Insert a Synapse FileRef at the end of a docx document as an image or attachment.",
      parameters: {
        type: "object",
        properties: {
          documentId: {
            type: "string",
            description:
              "Docx token, /docx/ URL, or a /wiki/ URL that resolves to docx.",
          },
          fileRef: {
            type: "string",
            description: "The Synapse FileRef to upload.",
          },
          type: {
            type: "string",
            description: "Media block type.",
            enum: ["image", "file"],
          },
          align: {
            type: "string",
            description: "Image alignment.",
            enum: ["left", "center", "right"],
          },
          caption: {
            type: "string",
            description: "Optional image caption. Only used when type=image.",
          },
        },
        required: ["documentId", "fileRef"],
      },
    },
    async execute(input, config) {
      const { client } = createFeishuApiClient(config)
      const documentId = await resolveFeishuDocxDocumentId(
        client,
        input.documentId,
        "documentId"
      )
      const mediaType = asString(input.type) === "file" ? "file" : "image"
      const record = await resolveFileRefRecord(input.fileRef, "fileRef")
      if (record.sizeBytes > FEISHU_DOC_MEDIA_MAX_BYTES) {
        throw new Error(
          `Feishu docs media upload only supports files up to 20MB. Current file is ${(record.sizeBytes / 1024 / 1024).toFixed(1)}MB.`
        )
      }

      const insertIndex = (
        await listFeishuDocumentRootChildren(client, documentId)
      ).length
      const createdBlock = await client.requestJson({
        path: `/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/blocks/${encodeURIComponent(documentId)}/children`,
        method: "POST",
        body: buildFeishuDocMediaCreateBlockBody(mediaType, insertIndex),
      })
      const targets = extractFeishuDocMediaTargets(createdBlock, mediaType)

      const rollback = async () => {
        await client.requestJson({
          path: `/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/blocks/${encodeURIComponent(documentId)}/children/batch_delete`,
          method: "DELETE",
          query: {
            client_token: randomUUID(),
          },
          body: {
            start_index: insertIndex,
            end_index: insertIndex + 1,
          },
        })
      }

      try {
        const buffer = await fileToBuffer(record)
        const form = new FormData()
        form.append("file_name", record.originalName)
        form.append("parent_type", getFeishuDocMediaParentType(mediaType))
        form.append("parent_node", targets.uploadParentNode)
        form.append("size", String(record.sizeBytes))
        form.append("extra", buildFeishuDocMediaRouteExtra(documentId))
        form.append(
          "file",
          new Blob([bufferToArrayBuffer(buffer)], { type: record.mimeType }),
          record.originalName
        )

        const upload = await client.requestJson<{
          file_token?: string
        }>({
          path: "/open-apis/drive/v1/medias/upload_all",
          method: "POST",
          body: form,
        })
        const fileToken = asString(upload.file_token)
        if (!fileToken) {
          throw new Error("Feishu media upload did not return file_token.")
        }

        await client.requestJson({
          path: `/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/blocks/batch_update`,
          method: "PATCH",
          body: buildFeishuDocMediaReplaceBody({
            blockId: targets.replaceBlockId,
            mediaType,
            fileToken,
            align: asString(input.align) || undefined,
            caption: asString(input.caption) || undefined,
          }),
        })

        return jsonResult({
          document_id: documentId,
          block_id: targets.blockId,
          file_token: fileToken,
          type: mediaType,
          file_name: record.originalName,
        })
      } catch (error) {
        try {
          await rollback()
        } catch {}
        throw error
      }
    },
  },
  {
    name: "feishu.docs.download_media",
    feature: "docs_media",
    definition: {
      name: "feishu.docs.download_media",
      description:
        "Download document media or a whiteboard snapshot into the Synapse file system and return a FileRef.",
      parameters: {
        type: "object",
        properties: {
          token: {
            type: "string",
            description: "Media file_token or whiteboard token.",
          },
          type: {
            type: "string",
            description: "Token type.",
            enum: ["media", "whiteboard"],
          },
          fileName: {
            type: "string",
            description: "Optional output file name override.",
          },
        },
        required: ["token"],
      },
    },
    async execute(input, config) {
      const { client } = createFeishuApiClient(config)
      const workspaceId = getWorkspaceId(config)
      const token = asString(input.token)
      const mediaType =
        asString(input.type) === "whiteboard" ? "whiteboard" : "media"
      if (!token) {
        throw new Error("token is required.")
      }
      if (!workspaceId) {
        throw new Error("workspace_id is missing from plugin runtime config.")
      }

      const result = await client.requestBuffer({
        path:
          mediaType === "whiteboard"
            ? `/open-apis/board/v1/whiteboards/${encodeURIComponent(token)}/download_as_image`
            : `/open-apis/drive/v1/medias/${encodeURIComponent(token)}/download`,
      })
      const originalName =
        asString(input.fileName) ||
        parseContentDispositionFilename(
          result.contentDisposition,
          `${token}${guessFileExtensionFromContentType(
            result.contentType,
            mediaType === "whiteboard" ? ".png" : ".bin"
          )}`
        )
      const saved = await saveFromBuffer(
        result.buffer,
        originalName,
        result.contentType,
        workspaceId,
        null,
        buildExternalImportOrigin({
          system: FILE_ORIGIN_SYSTEMS.FEISHU_DOCS_DOWNLOAD_MEDIA,
          providerKey: "feishu",
          externalResourceKey: token,
          details: {
            mediaType,
          },
        })
      )

      return [
        textBlock(
          `Downloaded Feishu ${mediaType} ${token} as ${saved.originalName}.`
        ),
        pluginOutputFileRef(saved),
      ]
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
          spreadsheetToken: {
            type: "string",
            description: "Spreadsheet token.",
          },
          range: {
            type: "string",
            description: "Read range such as Sheet1!A1:D10.",
          },
          valueRenderOption: {
            type: "string",
            description: "Optional render mode.",
          },
        },
        required: ["spreadsheetToken", "range"],
      },
    },
    async execute(input, config) {
      const { client } = createFeishuApiClient(config)
      const token = asString(input.spreadsheetToken)
      const range = asString(input.range)
      if (!token || !range) {
        throw new Error("spreadsheetToken and range are required.")
      }

      return jsonResult(
        await client.requestJson({
          path: `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(token)}/values/${encodeURIComponent(range)}`,
          query: {
            valueRenderOption: asString(input.valueRenderOption) || undefined,
          },
        })
      )
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
          spreadsheetToken: {
            type: "string",
            description: "Spreadsheet token.",
          },
          range: {
            type: "string",
            description: "Write range such as Sheet1!A1:D10.",
          },
          values: jsonArrayProperty("Two-dimensional array of cell values."),
        },
        required: ["spreadsheetToken", "range", "values"],
      },
    },
    async execute(input, config) {
      const { client } = createFeishuApiClient(config)
      const token = asString(input.spreadsheetToken)
      const range = asString(input.range)
      const values = parseJsonArrayInput(input.values, "values")
      if (!token || !range) {
        throw new Error("spreadsheetToken and range are required.")
      }

      return jsonResult(
        await client.requestJson({
          path: `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(token)}/values`,
          method: "PUT",
          body: {
            valueRange: {
              range,
              values,
            },
          },
        })
      )
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
          filter: {
            type: "string",
            description: "Optional filter expression.",
          },
          pageSize: { type: "number", description: "Page size." },
          pageToken: {
            type: "string",
            description: "Pagination token from the previous page.",
          },
        },
        required: ["appToken", "tableId"],
      },
    },
    async execute(input, config) {
      const { client } = createFeishuApiClient(config)
      const appToken = asString(input.appToken)
      const tableId = asString(input.tableId)
      if (!appToken || !tableId) {
        throw new Error("appToken and tableId are required.")
      }

      return jsonResult(
        await client.requestJson({
          path: `/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records`,
          query: {
            view_id: asString(input.viewId) || undefined,
            filter: asString(input.filter) || undefined,
            page_size: asNumber(input.pageSize, 20) || 20,
            page_token: asString(input.pageToken) || undefined,
          },
        })
      )
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
      const { client } = createFeishuApiClient(config)
      const appToken = asString(input.appToken)
      const tableId = asString(input.tableId)
      const fields = parseJsonObjectInput(input.fields, "fields")
      if (!appToken || !tableId) {
        throw new Error("appToken and tableId are required.")
      }

      return jsonResult(
        await client.requestJson({
          path: `/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records`,
          method: "POST",
          body: {
            fields,
          },
        })
      )
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
          description: {
            type: "string",
            description: "Optional task description.",
          },
          assigneeOpenId: {
            type: "string",
            description: "Optional assignee open_id.",
          },
          tasklistGuid: {
            type: "string",
            description: "Optional task list GUID.",
          },
          dueTime: {
            type: "string",
            description:
              "Optional due time as ISO string or unix timestamp in milliseconds.",
          },
        },
        required: ["summary"],
      },
    },
    async execute(input, config) {
      const { client } = createFeishuApiClient(config)
      const body: JsonObject = {
        summary: asString(input.summary),
      }
      if (asString(input.description)) {
        body.description = asString(input.description)
      }
      if (asString(input.assigneeOpenId)) {
        body.members = [
          {
            id: asString(input.assigneeOpenId),
            role: "assignee",
            type: "user",
          },
        ]
      }
      if (asString(input.tasklistGuid)) {
        body.tasklists = [
          {
            tasklist_guid: asString(input.tasklistGuid),
          },
        ]
      }
      if (asString(input.dueTime)) {
        const due = asString(input.dueTime)
        const numeric = Number(due)
        const ms = Number.isFinite(numeric)
          ? requireEpochMillis(numeric, "ms") // already an epoch-ms value
          : parseIsoInstant(fromExternalRfc3339(due)).getTime() // ISO/RFC3339
        if (!Number.isFinite(ms)) {
          throw new Error(
            `dueTime must be a millisecond epoch or an ISO datetime string: ${due}`
          )
        }
        body.due = { timestamp: String(ms), is_all_day: false }
      }

      return jsonResult(
        await client.requestJson({
          path: "/open-apis/task/v2/tasks",
          method: "POST",
          query: {
            user_id_type: "open_id",
          },
          body,
        })
      )
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
          folderToken: {
            type: "string",
            description: "Optional target folder token.",
          },
          fileName: {
            type: "string",
            description: "Optional destination file name.",
          },
        },
        required: ["fileRef"],
      },
    },
    async execute(input, config) {
      const { client } = createFeishuApiClient(config)
      const record = await resolveFileRefRecord(input.fileRef, "fileRef")
      const buffer = await fileToBuffer(record)

      const form = new FormData()
      form.append("file_name", asString(input.fileName) || record.originalName)
      form.append("parent_type", "explorer")
      form.append("parent_node", asString(input.folderToken))
      form.append("size", String(record.sizeBytes))
      form.append(
        "file",
        new Blob([bufferToArrayBuffer(buffer)], { type: record.mimeType }),
        asString(input.fileName) || record.originalName
      )

      return jsonResult(
        await client.requestJson({
          path: "/open-apis/drive/v1/files/upload_all",
          method: "POST",
          body: form,
        })
      )
    },
  },
  {
    name: "feishu.drive.download_file",
    feature: "drive",
    definition: {
      name: "feishu.drive.download_file",
      description:
        "Download a Feishu Drive file into the Synapse file system and return a FileRef.",
      parameters: {
        type: "object",
        properties: {
          fileToken: {
            type: "string",
            description: "Feishu Drive file token.",
          },
          fileName: {
            type: "string",
            description: "Optional output file name override.",
          },
        },
        required: ["fileToken"],
      },
    },
    async execute(input, config) {
      const { client } = createFeishuApiClient(config)
      const fileToken = asString(input.fileToken)
      const workspaceId = getWorkspaceId(config)
      if (!fileToken) {
        throw new Error("fileToken is required.")
      }
      if (!workspaceId) {
        throw new Error("workspace_id is missing from plugin runtime config.")
      }

      const result = await client.requestBuffer({
        path: `/open-apis/drive/v1/files/${encodeURIComponent(fileToken)}/download`,
      })
      const originalName =
        asString(input.fileName) ||
        parseContentDispositionFilename(
          result.contentDisposition,
          `${fileToken}.bin`
        )
      const saved = await saveFromBuffer(
        result.buffer,
        originalName,
        result.contentType,
        workspaceId,
        null,
        buildExternalImportOrigin({
          system: FILE_ORIGIN_SYSTEMS.FEISHU_DRIVE_DOWNLOAD_FILE,
          providerKey: "feishu",
          externalResourceKey: fileToken,
        })
      )

      return [
        textBlock(
          `Downloaded Feishu Drive file ${fileToken} as ${saved.originalName}.`
        ),
        pluginOutputFileRef(saved),
      ]
    },
  },
]

const feishuToolMap = new Map(feishuToolSpecs.map((tool) => [tool.name, tool]))

function getEnabledFeatures(config: Record<string, unknown>) {
  const features = normalizeFeishuFeatureKeys(config.features)
  return features.length > 0 ? features : DEFAULT_FEISHU_FEATURES
}

export function getFeishuToolDefinitions(
  config: Record<string, unknown> = {}
): ToolDefinition[] {
  const enabled = new Set<FeishuFeatureKey>(getEnabledFeatures(config))
  return feishuToolSpecs
    .filter((tool) => enabled.has(tool.feature))
    .map((tool) => tool.definition)
}

export async function executeFeishuTool(
  toolName: string,
  input: Record<string, unknown>,
  config: Record<string, unknown>
): Promise<BuiltinPluginExecuteResult> {
  const tool = feishuToolMap.get(toolName)
  if (!tool) {
    throw new Error(`Unknown Feishu tool '${toolName}'.`)
  }

  const enabled = new Set<FeishuFeatureKey>(getEnabledFeatures(config))
  if (!enabled.has(tool.feature)) {
    throw new Error(
      `The Feishu feature '${tool.feature}' is not enabled for this installation.`
    )
  }

  return tool.execute(input, config)
}
