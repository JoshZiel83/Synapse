/**
 * IM module repo-layer type aliases.
 *
 * Named aliases for Kysely-generated insert/update column subtypes used by the
 * IM service/domain helpers. Per AGENTS.md hard rule 1 (guard r2), only
 * `repo*.ts` / `repo.types.ts` files may reference `TableInsert<…>` /
 * `TableUpdate<…>` directly; the helper files import these named types instead.
 *
 * These are pure type-location moves — each alias is the exact column subtype
 * the helper previously spelled inline.
 */

import type {
  TableInsert,
  TableUpdate,
} from "../../infrastructure/database/kysely.js"

// ───────────────────────── transport_accounts ─────────────────────────

export type TransportAccountCredentialsInsert =
  TableInsert<"transportAccounts">["credentials"]
export type TransportAccountConfigInsert =
  TableInsert<"transportAccounts">["config"]
export type TransportAccountMetadataInsert =
  TableInsert<"transportAccounts">["metadata"]

// ───────────────────────── transport_addresses ─────────────────────────

export type TransportAddressMetadataInsert =
  TableInsert<"transportAddresses">["metadata"]

// ──────────────── conversation_participant_addresses ────────────────

export type ConversationParticipantAddressMetadataInsert =
  TableInsert<"conversationParticipantAddresses">["metadata"]

// ───────────────────────── transport_endpoints ─────────────────────────

export type TransportEndpointMetadataInsert =
  TableInsert<"transportEndpoints">["metadata"]

// ──────────────── conversation_transport_bindings ────────────────

export type ConversationTransportBindingMetadataInsert =
  TableInsert<"conversationTransportBindings">["metadata"]
export type ConversationTransportBindingMetadataUpdate =
  TableUpdate<"conversationTransportBindings">["metadata"]
export type ConversationTransportBindingUpdatedAtUpdate =
  TableUpdate<"conversationTransportBindings">["updatedAt"]

// ───────────────────────── transport_message_links ─────────────────────────

export type TransportMessageLinkMetadataInsert =
  TableInsert<"transportMessageLinks">["metadata"]
export type TransportMessageLinkMetadataUpdate =
  TableUpdate<"transportMessageLinks">["metadata"]
