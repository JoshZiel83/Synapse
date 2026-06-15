import { type Executor } from "../../infrastructure/database/kysely.js"
import { chatRootExecutor, getConversationRecord } from "./repo.js"

function rootQueryable(): Executor {
  return chatRootExecutor()
}

export async function getConversation(
  conversationId: string,
  queryable: Executor = rootQueryable()
) {
  return getConversationRecord(queryable, conversationId)
}
