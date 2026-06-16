import { z } from "zod"
import { nonEmpty } from "./client.js"

const jsonObjectSchema = z.custom<Record<string, unknown>>(
  (value) =>
    typeof value === "object" && value !== null && !Array.isArray(value)
)

const itemListSchema = z.array(jsonObjectSchema)

export interface WeixinSendResponse {
  externalMessageId?: string
}

function parseJsonText(text: string): unknown | null {
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function readMessageIdFields(record: Record<string, unknown>) {
  return nonEmpty(record.msg_id) || nonEmpty(record.message_id)
}

export function parseWeixinSendResponseText(
  text: string
): WeixinSendResponse | null {
  const json = parseJsonText(text)
  if (json === null) return null

  const root = jsonObjectSchema.safeParse(json)
  if (!root.success) return null

  const rootMessageId = readMessageIdFields(root.data)
  if (rootMessageId) return { externalMessageId: rootMessageId }

  const msg = jsonObjectSchema.safeParse(root.data.msg)
  if (!msg.success) return {}

  const nestedMessageId = readMessageIdFields(msg.data)
  if (nestedMessageId) return { externalMessageId: nestedMessageId }

  const itemList = itemListSchema.safeParse(msg.data.item_list)
  if (!itemList.success) return {}

  const itemMessageId = readMessageIdFields(itemList.data[0] ?? {})
  return itemMessageId ? { externalMessageId: itemMessageId } : {}
}
