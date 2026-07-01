import {
  ChatClientInstanceViewSchema,
  ChatConversationEnvelopeViewSchema,
  ChatRuntimeTurnDetailViewSchema,
  ChatSendMessageViewSchema,
  ChatTaskRespondViewSchema,
  ChatReadWatermarkViewSchema,
  ChatTypingBroadcastViewSchema,
  ChatPushTokenRegistrationViewSchema,
  ChatPushTokenListViewSchema,
  ChatPushTokenDeleteViewSchema,
  ChatMessageRetryViewSchema,
} from "@synapse/shared/schemas"
import { mock } from "../faker-setup"
import { designChatBootstrap, designMessagesFor } from "../fixtures/chat"
import type { DesignHandlers } from "./_types"

// Chat surface: bootstrap / sync / conversation messages / runtime turns /
// push tokens. These feed the inbox, the conversation timeline, and the
// realtime panes — the core of the messaging UI.
export const chatHandlers = {
  retryConversationMessage: async () => mock(ChatMessageRetryViewSchema),
  // Curated fixed scenarios (see lib/design/fixtures/chat.ts) instead of random
  // data: native DMs / a group / IM-linked WeChat·Telegram·Feishu, actors in
  // idle / running / error / input-required states, and in-conversation
  // interactions (plan-approval + user-input tasks).
  getChatBootstrap: async () => designChatBootstrap,
  createChatClientInstance: async () => mock(ChatClientInstanceViewSchema),
  touchChatClientInstance: async () => mock(ChatClientInstanceViewSchema),
  createChatConversation: async () => mock(ChatConversationEnvelopeViewSchema),
  // Re-enabled after the RC1 fix (b9647863): ChatRuntimeTurnDetailViewSchema now
  // embeds PersistedCanonicalContentBlockSchema (id required).
  getChatConversationRuntimeTurnDetail: async () =>
    mock(ChatRuntimeTurnDetailViewSchema),
  // Re-enabled after 4f1f4978 closed the KNOWN gap: the approvedGrant.id drift is
  // fixed and contract-parity.ts now soundly asserts all four chat response pairs
  // (MutualAssign). `mock` returns z.infer, which those assertions guarantee is
  // assignable to the hand-written response types.
  // Empty sync so the store never overwrites the curated fixtures with random
  // upserts — the scenarios stay stable across reloads.
  getChatSync: async () => ({ events: [], nextCursor: 0, hasMore: false }),
  getChatConversationMessages: async (
    _workspaceId: string,
    conversationId: string
  ) => designMessagesFor(conversationId),
  sendChatConversationMessage: async () => mock(ChatSendMessageViewSchema),
  // resolveChatTask returns the ChatTaskResolveResponse union; ChatTaskRespondView
  // is its applied arm (the 200 body), a valid member of the union.
  resolveChatTask: async () => mock(ChatTaskRespondViewSchema),
  updateChatConversationReadWatermark: async () =>
    mock(ChatReadWatermarkViewSchema),
  sendChatTypingState: async () => mock(ChatTypingBroadcastViewSchema),
  registerChatPushToken: async () => mock(ChatPushTokenRegistrationViewSchema),
  listChatPushTokens: async () => mock(ChatPushTokenListViewSchema),
  deleteChatPushToken: async () => mock(ChatPushTokenDeleteViewSchema),
} satisfies DesignHandlers
