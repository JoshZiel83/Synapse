/**
 * transport_external_users domain: the dashboard's list of external IM
 * users (with their joined sessions + auto-link state). Read-only side
 * — address writes live in addresses.ts.
 *
 * Extracted from service.ts. service.ts re-exports for back-compat.
 */

import { sql } from "kysely"
import { db } from "../../../infrastructure/database/kysely.js"
import type { TransportExternalUserSummary } from "@synapse/shared/types"
import { normalizeTransportExternalUserRow } from "./_helpers.js"

export async function listTransportExternalUsers(params: {
  workspaceId: string
  transportAccountId?: string
}): Promise<TransportExternalUserSummary[]> {
  const activity = db
    .selectFrom("conversation_participant_addresses as cpa_activity")
    .innerJoin(
      "conversation_participants as cm_activity",
      "cm_activity.id",
      "cpa_activity.conversation_participant_id"
    )
    .innerJoin(
      "transport_message_links as tml",
      "tml.conversation_id",
      "cm_activity.conversation_id"
    )
    .select("cpa_activity.transport_address_id")
    .select(sql<Date | null>`MAX(tml.created_at)`.as("last_seen_at"))
    .groupBy("cpa_activity.transport_address_id")
    .as("activity")

  let builder = db
    .selectFrom("transport_addresses as ta")
    .innerJoin(
      "transport_accounts as account",
      "account.id",
      "ta.transport_account_id"
    )
    .leftJoin(
      "workspace_members as linked_wm",
      "linked_wm.id",
      "ta.workspace_member_id"
    )
    .leftJoin("users as linked_user", "linked_user.id", "linked_wm.user_id")
    .leftJoin(
      "conversation_participant_addresses as cpa",
      "cpa.transport_address_id",
      "ta.id"
    )
    .leftJoin(
      "conversation_participants as cm",
      "cm.id",
      "cpa.conversation_participant_id"
    )
    .leftJoin("conversations as c", "c.id", "cm.conversation_id")
    .leftJoin(
      "conversation_transport_bindings as ctb",
      "ctb.conversation_id",
      "c.id"
    )
    .leftJoin("transport_endpoints as te", "te.id", "ctb.transport_endpoint_id")
    .leftJoin(activity, "activity.transport_address_id", "ta.id")
    .select([
      "ta.id",
      "ta.workspace_id",
      "ta.transport_account_id",
      "ta.transport_kind",
      "ta.external_id",
      "ta.display_name",
      "ta.metadata",
      "ta.created_at",
      "ta.updated_at",
      "account.display_name as account_display_name",
      "linked_wm.id as linked_workspace_member_id",
      "linked_user.name as linked_workspace_member_name",
      "activity.last_seen_at as last_seen_at",
      sql<any>`COALESCE(
        jsonb_agg(
          DISTINCT jsonb_build_object(
            'conversationId', c.id,
            'conversationTitle', c.title,
            'endpointId', te.id,
            'endpointType', te.endpoint_type,
            'endpointExternalId', te.external_id,
            'endpointDisplayName', te.display_name
          )
        ) FILTER (WHERE te.id IS NOT NULL),
        '[]'::jsonb
      )`.as("sessions"),
    ])
    .where("ta.workspace_id", "=", params.workspaceId)
    .where("ta.address_type", "=", "user")

  if (params.transportAccountId) {
    builder = builder.where(
      "ta.transport_account_id",
      "=",
      params.transportAccountId
    )
  }

  const rows = await builder
    .groupBy([
      "ta.id",
      "account.display_name",
      "linked_user.id",
      "linked_user.name",
      "activity.last_seen_at",
    ])
    .orderBy(
      sql`COALESCE(activity.last_seen_at, ta.updated_at, ta.created_at)`,
      "desc"
    )
    .orderBy("ta.created_at", "desc")
    .execute()

  return rows.map(normalizeTransportExternalUserRow)
}
