/**
 * Persistence helper for DingTalk Device-Flow + manual registration paths.
 *
 * Mirrors the `persistWeixinAccount` precedent (qr-login.ts:170/184):
 *
 *   1. Look up an existing account by (workspace, kind="dingtalk", key=clientId).
 *   2. If present, run `updateTransportAccount` with the full set of fields
 *      that must be in sync after a registration (status="active",
 *      connectionMode="long_connection", credentials, owner, inbound actor,
 *      displayName) AND a *merged* config/metadata so we don't accidentally
 *      wipe registration metadata that other modules may have written.
 *   3. If absent, `createTransportAccount` with the same fields.
 *   4. On a 23505 unique-key race between (1) and (3), retry the lookup
 *      and follow the update branch.
 *   5. Wake the runtime reconcile loop so the new account starts within
 *      seconds rather than waiting for the next 15s tick.
 *
 * Used by both the Device Flow `/poll` route (after a SUCCESS status) and
 * the manual `/manual` route — passing the credentials in either case.
 */

import type {
  TransportAccountInboundActorMode,
  TransportAccountOwnerScope,
  TransportAccountSummary,
} from "@synapse/shared/types"
import {
  createTransportAccount,
  getTransportAccountByWorkspaceKindAndKey,
  updateTransportAccount,
} from "../../service.js"
import { refreshTransportRuntimeManager } from "../../runtime.js"

export interface PersistDingtalkAccountInput {
  workspaceId: string
  clientId: string
  clientSecret: string
  displayName: string
  ownerScope: TransportAccountOwnerScope
  ownerWorkspaceMemberId?: string | null
  inboundActorMode: TransportAccountInboundActorMode
  inboundActorId?: string | null
  /**
   * Extra config to merge into the account row (e.g. registration provider
   * tag, baseUrl override). Always merged on top of existing config so
   * unrelated keys survive.
   */
  configPatch?: Record<string, unknown>
  /**
   * Extra metadata to merge — useful for tracking which registration
   * flow created the account (device_flow vs manual) and when.
   */
  metadataPatch?: Record<string, unknown>
}

function mergeObject(
  existing: Record<string, unknown> | undefined,
  patch: Record<string, unknown> | undefined
): Record<string, unknown> {
  return { ...(existing || {}), ...(patch || {}) }
}

async function applyUpdate(
  existing: TransportAccountSummary,
  input: PersistDingtalkAccountInput
): Promise<TransportAccountSummary> {
  return updateTransportAccount({
    workspaceId: input.workspaceId,
    accountId: existing.id,
    displayName: input.displayName,
    ownerScope: input.ownerScope,
    ownerWorkspaceMemberId: input.ownerWorkspaceMemberId ?? null,
    inboundActorMode: input.inboundActorMode,
    inboundActorId: input.inboundActorId ?? null,
    connectionMode: "long_connection",
    status: "active",
    credentials: {
      clientId: input.clientId,
      clientSecret: input.clientSecret,
    },
    // Crucial: updateTransportAccount replaces config/metadata wholesale
    // when given, so we must explicitly spread existing values first.
    config: mergeObject(existing.config, input.configPatch),
    metadata: mergeObject(existing.metadata, input.metadataPatch),
  })
}

async function applyCreate(
  input: PersistDingtalkAccountInput
): Promise<TransportAccountSummary> {
  return createTransportAccount({
    workspaceId: input.workspaceId,
    transportKind: "dingtalk",
    accountKey: input.clientId,
    displayName: input.displayName,
    ownerScope: input.ownerScope,
    ownerWorkspaceMemberId: input.ownerWorkspaceMemberId ?? null,
    inboundActorMode: input.inboundActorMode,
    inboundActorId: input.inboundActorId ?? null,
    connectionMode: "long_connection",
    status: "active",
    credentials: {
      clientId: input.clientId,
      clientSecret: input.clientSecret,
    },
    config: input.configPatch ?? {},
    metadata: input.metadataPatch ?? {},
  })
}

export async function persistDingtalkAccountFromRegistration(
  input: PersistDingtalkAccountInput
): Promise<TransportAccountSummary> {
  const existing = await getTransportAccountByWorkspaceKindAndKey({
    workspaceId: input.workspaceId,
    transportKind: "dingtalk",
    accountKey: input.clientId,
  })

  let account: TransportAccountSummary
  if (existing) {
    account = await applyUpdate(existing, input)
  } else {
    try {
      account = await applyCreate(input)
    } catch (error: unknown) {
      // Concurrent registration race — another request just inserted
      // the same (workspace, kind, accountKey) triple. Re-fetch and
      // follow the update branch with merge semantics intact.
      const pgError = error as { code?: string } | null
      if (pgError?.code !== "23505") throw error
      const concurrent = await getTransportAccountByWorkspaceKindAndKey({
        workspaceId: input.workspaceId,
        transportKind: "dingtalk",
        accountKey: input.clientId,
      })
      if (!concurrent) throw error
      account = await applyUpdate(concurrent, input)
    }
  }

  await refreshTransportRuntimeManager().catch((err: unknown) => {
    // Failure to wake reconcile isn't fatal — the next 15s tick will
    // pick the account up — but it deserves a log so an operator can
    // investigate why the in-process refresh hook is broken.
    // eslint-disable-next-line no-console
    console.error("[im][dingtalk] refreshTransportRuntimeManager failed:", err)
  })
  return account
}
