// mcp-plugins/presenter.ts — DTO/wire-shaping helpers for the mcp-plugins
// module.
//
// presenter.ts is neither a service nor a controller, so it is the layer that
// is permitted to call serializeInstant / serializeOptionalInstant (see
// packages/api/scripts/guard-layering.mjs r3). service.ts shapes timestamps via
// the thin wrappers below instead of touching the infra serializers directly,
// and the auth row → DTO mappers live here (guard-layering r4) instead of in
// plugin-auth-connections.ts.
//
// This file MUST NOT import generated/db or use TableRow<…>; it takes row
// values structurally (the row aliases imported below resolve to TableRow but
// are pulled in via `import type`, so no generated/db import lands here).

import type {
  PluginAuthConnection,
  PluginAuthSession,
  MarketplacePublisherView,
  PluginCategoryView,
  WorkspaceAppGrant,
} from "@synapse/shared"
import {
  parseJsonObject,
  resolveNarrowedConversationTypeMask,
  WORKSPACE_APP_GRANT_PERMISSION,
} from "@synapse/shared"
import { assertIsoInstant } from "@synapse/shared/datetime"
import {
  serializeInstant,
  serializeOptionalInstant,
  type IsoInstantString,
} from "../../infrastructure/datetime.js"
import { getFileUrlById } from "../files/service.js"
import type {
  PluginAuthSessionRow,
  PluginConnectionRow,
} from "./plugin-auth-connections.js"
import {
  installationAccessRowToTarget,
  type InstallationAccessRow,
} from "./service.js"
import type { PluginCategoryRecord, PublisherRecord } from "./repo.types.js"

/**
 * Present a stored installation-access row as a WorkspaceAppGrant View. Row→DTO
 * mapper + Date→ISO serializer, so it lives in the presenter (guard r3/r4). The
 * row decoder installationAccessRowToTarget + the row type stay in service.ts;
 * this imports them (same direction as skills/presenter ← service). round-6 P1-7.
 */
export function presentInstallationAccessGrant(
  mount: InstallationAccessRow,
  options?: {
    workspaceConversationTypeMask: number
    instanceConversationTypeMaskOverride: number | null
  }
): WorkspaceAppGrant {
  const effectiveConversationTypeMask = options
    ? resolveNarrowedConversationTypeMask(
        resolveNarrowedConversationTypeMask(
          options.workspaceConversationTypeMask,
          options.instanceConversationTypeMaskOverride
        ),
        mount.conversation_type_mask_override
      )
    : undefined
  return {
    id: mount.id,
    workspaceAppId: mount.installation_id,
    workspaceId: mount.workspace_id,
    target: installationAccessRowToTarget(mount),
    permissions: [WORKSPACE_APP_GRANT_PERMISSION.USE],
    status: mount.status,
    source: mount.source,
    grantedByWorkspaceMemberId:
      mount.created_by_workspace_member_id || undefined,
    reason: mount.reason || undefined,
    conversationTypeMaskOverride: mount.conversation_type_mask_override ?? null,
    effectiveConversationTypeMask,
    createdAt: serializeInstant(mount.created_at),
    revokedAt: serializeOptionalInstant(mount.revoked_at),
  }
}

/** Present a stored instant as an ISO timestamp for the wire DTO. */
export function presentInstant(value: Date): IsoInstantString {
  return serializeInstant(value)
}

/** Present a nullable stored instant as an optional ISO timestamp. */
export function presentOptionalInstant(
  value: Date | null | undefined
): IsoInstantString | undefined {
  return serializeOptionalInstant(value)
}

type JsonObject = Record<string, unknown>

// Business JSON decode → shared parseJsonObject (object-only, array-reject). r6 P1-8.
const asObject = parseJsonObject

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function getAuthChallenge(
  row: PluginAuthSessionRow
): PluginAuthSession["challenge"] | undefined {
  const challenge = asObject(row.challengePayload)
  const kind = asString(challenge.kind)
  if (!kind) return undefined
  if (kind !== "redirect" && kind !== "qr_code" && kind !== "none") {
    return undefined
  }
  return {
    kind: kind as NonNullable<PluginAuthSession["challenge"]>["kind"],
    url: asString(challenge.url) || undefined,
    qrUrl: asString(challenge.qrUrl) || undefined,
    openMode:
      challenge.openMode === "replace" || challenge.openMode === "popup"
        ? challenge.openMode
        : undefined,
    expiresAt: asString(challenge.expiresAt)
      ? assertIsoInstant(asString(challenge.expiresAt)!)
      : undefined,
    metadata: asObject(challenge.metadata),
  }
}

/** Shape a plugin connection row into the app-facing PluginAuthConnection DTO. */
export function presentAuthConnection(
  row: PluginConnectionRow
): PluginAuthConnection {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    packageId: row.catalogItemId,
    bindingKey: row.bindingKey,
    driver: row.driver as PluginAuthConnection["driver"],
    externalAccountId: row.externalAccountId || undefined,
    displayName: row.displayName || undefined,
    avatarUrl: row.avatarUrl || undefined,
    status: row.status as PluginAuthConnection["status"],
    expiresAt: serializeOptionalInstant(row.expiresAt),
    publicPayload: asObject(row.publicPayload),
    createdAt: serializeInstant(row.createdAt),
    updatedAt: serializeInstant(row.updatedAt),
  }
}

/** Shape a plugin auth session row into the app-facing PluginAuthSession DTO. */
export function presentAuthSession(
  row: PluginAuthSessionRow
): PluginAuthSession {
  const metadata = asObject(row.metadata)
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    packageId: row.catalogItemId,
    revisionId: row.catalogVersionId || undefined,
    bindingKey: row.bindingKey,
    driver: row.driver as PluginAuthSession["driver"],
    workspaceMemberId: row.workspaceMemberId,
    status: row.status as PluginAuthSession["status"],
    phase: (row.phase as PluginAuthSession["phase"] | null) || undefined,
    state: row.state || undefined,
    challenge: getAuthChallenge(row),
    errorCode: row.errorCode || undefined,
    errorMessage: row.errorMessage || undefined,
    resultPreview: asObject(row.resultPreview),
    authConnectionId:
      typeof metadata.consumedConnectionId === "string"
        ? metadata.consumedConnectionId
        : undefined,
    metadata,
    expiresAt: serializeInstant(row.expiresAt),
    createdAt: serializeInstant(row.createdAt),
    updatedAt: serializeInstant(row.updatedAt),
  }
}

/** Shape a publisher record into the app-facing MarketplacePublisherView DTO. */
export function presentPublisher(
  row: PublisherRecord
): MarketplacePublisherView {
  return {
    id: row.id,
    slug: row.slug,
    displayName: row.displayName,
    description: row.description || "",
    logoUrl: row.logoFileId ? getFileUrlById(row.logoFileId) : null,
    isBuiltin: Boolean(row.isBuiltin),
    isVerified: Boolean(row.isVerified),
    ownerUserId: row.ownerUserId,
    workspaceId: row.workspaceId,
    pluginCount:
      typeof row.pluginCount === "number"
        ? row.pluginCount
        : Number(row.pluginCount || 0),
    createdAt: serializeInstant(row.createdAt),
    updatedAt: serializeInstant(row.updatedAt),
  }
}

/** Shape a plugin-category record into the app-facing PluginCategoryView DTO. */
export function presentPluginCategory(
  row: PluginCategoryRecord
): PluginCategoryView {
  const metadata = asObject(row.metadata)
  return {
    id: row.id,
    slug: row.slug,
    displayName: row.displayName,
    description: row.description || "",
    displayNameI18n: asObject(metadata.displayNameI18n) as Record<
      string,
      string
    >,
    descriptionI18n: asObject(metadata.descriptionI18n) as Record<
      string,
      string
    >,
    defaultLocale:
      typeof metadata.defaultLocale === "string"
        ? metadata.defaultLocale
        : "en",
    sortOrder: row.sortOrder,
  }
}
