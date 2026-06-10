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
    .selectFrom("conversationParticipantAddresses as cpa_activity")
    .innerJoin(
      "conversationParticipants as cm_activity",
      "cm_activity.id",
      "cpa_activity.conversationParticipantId"
    )
    .innerJoin(
      "transportMessageLinks as tml",
      "tml.conversationId",
      "cm_activity.conversationId"
    )
    .select("cpa_activity.transportAddressId")
    .select(sql<Date | null>`MAX(tml.created_at)`.as("lastSeenAt"))
    .groupBy("cpa_activity.transportAddressId")
    .as("activity")

  let builder = db
    .selectFrom("transportAddresses as ta")
    .innerJoin(
      "transportAccounts as account",
      "account.id",
      "ta.transportAccountId"
    )
    .leftJoin(
      "workspaceMembers as linked_wm",
      "linked_wm.id",
      "ta.workspaceMemberId"
    )
    .leftJoin("users as linked_user", "linked_user.id", "linked_wm.userId")
    .leftJoin(
      "conversationParticipantAddresses as cpa",
      "cpa.transportAddressId",
      "ta.id"
    )
    .leftJoin(
      "conversationParticipants as cm",
      "cm.id",
      "cpa.conversationParticipantId"
    )
    .leftJoin("conversations as c", "c.id", "cm.conversationId")
    .leftJoin(
      "conversationTransportBindings as ctb",
      "ctb.conversationId",
      "c.id"
    )
    .leftJoin("transportEndpoints as te", "te.id", "ctb.transportEndpointId")
    .leftJoin(activity, "activity.transportAddressId", "ta.id")
    .select([
      "ta.id",
      "ta.workspaceId",
      "ta.transportAccountId",
      "ta.transportKind",
      "ta.externalId",
      "ta.displayName",
      "ta.metadata",
      "ta.createdAt",
      "ta.updatedAt",
      "account.displayName as accountDisplayName",
      "linked_wm.id as linkedWorkspaceMemberId",
      "linked_user.name as linkedWorkspaceMemberName",
      "activity.lastSeenAt as lastSeenAt",
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
    .where("ta.workspaceId", "=", params.workspaceId)
    .where("ta.addressType", "=", "user")

  if (params.transportAccountId) {
    builder = builder.where(
      "ta.transportAccountId",
      "=",
      params.transportAccountId
    )
  }

  const rows = await builder
    .groupBy([
      "ta.id",
      "account.displayName",
      "linked_user.id",
      "linked_user.name",
      "activity.lastSeenAt",
    ])
    .orderBy(
      sql`COALESCE(activity.last_seen_at, ta.updated_at, ta.created_at)`,
      "desc"
    )
    .orderBy("ta.createdAt", "desc")
    .execute()

  return rows.map(normalizeTransportExternalUserRow)
}
