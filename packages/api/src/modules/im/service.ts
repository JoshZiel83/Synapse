/**
 * IM service barrel — every export below is implemented in service/*.ts.
 * Kept as a top-level file so existing `from "./service.js"` imports
 * (controllers, workers, runtime, tests) don't need to be rewritten.
 *
 * Add new functionality to the appropriate sub-file, not here. Only
 * touch this file when introducing a new domain group.
 *
 * Layout:
 *
 * - _helpers.ts            — JSON parsers + row normalizers used by every
 *                            domain. Pure, no DB calls.
 * - accounts.ts            — transport_accounts CRUD + the joined session
 *                            row loader the dashboard renders.
 * - addresses.ts           — transport_addresses + the join table that
 *                            attaches them to conversation_participants.
 * - bindings.ts            — conversation_transport_bindings CRUD + the
 *                            endpoint upsert that happens alongside it.
 * - delivery-links.ts      — transport_message_links: outbound enqueue,
 *                            inbound dedupe, status updates, joined
 *                            loader for the delivery worker.
 * - external-users.ts      — dashboard list of external IM users with
 *                            their joined sessions + last-seen activity.
 * - reactions-storage.ts   — external_emoji_reactions JSONB persistence
 *                            for the status reaction adapter.
 * - weixin-binding.ts      — "current user's WeChat" dashboard: get /
 *                            set auto-link target / link to current
 *                            workspace member.
 */

export {
  normalizeAccountRow,
  normalizeBindingRow,
  normalizeEndpointRow,
  normalizeTransportExternalUserRow,
  normalizeTransportMessageLinkRow,
  normalizeTransportSessionRow,
  parseJsonArray,
  parseJsonObject,
  readTrimmedString,
  toIsoString,
} from "./service/_helpers.js"

export {
  assertConversationInboundActor,
  consumeTransportAccountAutoLink,
  createTransportAccount,
  getPendingTransportAccountAutoLinkWorkspaceMemberId,
  getTransportAccountById,
  getTransportAccountByKindAndId,
  getTransportAccountByWorkspaceKindAndKey,
  listActiveTransportAccounts,
  listTransportAccounts,
  listTransportSessions,
  loadTransportAccountRow,
  updateTransportAccount,
} from "./service/accounts.js"

export {
  assertWorkspaceMember,
  ensureConversationParticipantTransportAddress,
  ensureTransportAddress,
  getPrimaryTransportAddressForParticipant,
  getReachableTransportAddressForParticipant,
  getTransportAddressByExternalId,
  getTransportAddressById,
  setConversationExternalParticipantLinkedUser,
  setTransportAddressLinkedUser,
  syncTransportAddressConversationParticipant,
  updateTransportAddressMetadata,
  updateTransportEndpointMetadata,
} from "./service/addresses.js"

export {
  findConversationTransportBindingByEndpoint,
  getConversationTransportBinding,
  updateConversationTransportSettings,
  updateTransportSessionSettings,
  upsertConversationTransportBinding,
} from "./service/bindings.js"

export {
  enqueueOutboundDelivery,
  findTransportMessageLinkByExternalMessage,
  loadTransportMessageLinkForDelivery,
  patchTransportMessageLinkMetadata,
  persistOutboundLinkRowRaw,
  queueConversationTransportProjection,
  removeTransportMessageLinkMetadataKey,
  updateTransportMessageLinkStatus,
} from "./service/delivery-links.js"

export { listTransportExternalUsers } from "./service/external-users.js"

export {
  findExternalMessageIdForItem,
  loadTransportEmojiReactions,
  saveTransportEmojiReactions,
} from "./service/reactions-storage.js"

export {
  getCurrentUserWeixinBinding,
  linkCurrentUserWeixinBinding,
  setCurrentUserWeixinBindingAutoLink,
} from "./service/weixin-binding.js"
