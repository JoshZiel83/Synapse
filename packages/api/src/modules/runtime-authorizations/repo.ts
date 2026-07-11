// Repo for the runtime-authorizations module: owns the raw DB reads the
// service/controller/request helpers need so those files stay free of the db
// client (guard r8). Repo functions return camelCase DOMAIN records (Kysely's
// CamelCasePlugin already yields camelCase keys; raw `sql` fragments that use
// snake_case aliases are copied verbatim) and KEEP Date objects — time
// serialization belongs to presenters (guard r3).

import { sql } from "kysely"
import { db } from "../../infrastructure/database/kysely.js"
import type {
  DatabaseTransaction,
  Executor,
} from "../../infrastructure/database/kysely.js"
import type {
  RuntimeAuthorizationGrantCandidate,
  RuntimeAuthorizationGrantCandidateRecord,
  RuntimeAuthorizationGrantCandidateRow,
  RuntimeAuthorizationGrantPolicyInsert,
  RuntimeAuthorizationGrantSourceRequestArgsInsert,
} from "./repo.types.js"
import type { RuntimeAuthorizationGrantRetention } from "@synapse/shared/types"
import {
  actorRef,
  conversationRef,
  remoteAgentRef,
  SUBJECT_KIND,
  workspaceMemberRef,
  workspaceRef,
} from "@synapse/shared"
import {
  validateGrantPolicyForCapability,
  type PolicyValidationFailure,
} from "@synapse/shared/access/policies"
import type { ZodIssue } from "zod"

/**
 * Device tool runtime target (service id, tool revision, etc.) for a freshly
 * approved runtime authorization. Returns null when any piece is missing —
 * caller falls back to the static approval notice (e.g. the device went
 * offline between request and approval).
 *
 * Soft-delete (§8.6) and active-status WHERE clauses are preserved verbatim:
 * never auto-retry against a soft-closed device's tool or an inactive app.
 */
export interface AutoRetryTarget {
  runtimeId: string
  runtimeServiceId: string
  /**
   * Owning service kind (P4a / PREREQ-DISC). The auto-retry dispatch fork keys
   * on 'bare_dataplane'; a device/resident target always resolves
   * 'device_runtime' (F-B), so auto-retry reaches dispatchSyncTool byte-
   * identically (A3).
   */
  serviceKind: "device_runtime" | "remote_agent_daemon" | "bare_dataplane"
  runtimeExposureId: string
  runtimeToolId: string
  runtimeToolRevisionId: string
}

export async function findAutoRetryTarget(args: {
  runtimeCapabilityId: string
  visibleToolName: string
}): Promise<AutoRetryTarget | null> {
  const row = await db
    .selectFrom("runtimeCapabilities as dc")
    .innerJoin("workspaceResources as resource", "resource.id", "dc.id")
    .innerJoin("runtimeExposures as dx", "dx.id", "dc.exposureId")
    // PREREQ-DISC (P4a): to-one join surfacing the owning service's kind so the
    // auto-retry fork can key on 'bare_dataplane'. Byte-neutral for devices/
    // resident (resolves 'device_runtime').
    .innerJoin("runtimeServices as rs", "rs.id", "dx.serviceId")
    // Generalized to the runtimes supertype (P2): existence-only join, so a
    // device-less sandbox runtime is an auto-retry target too. r.id === dx.runtimeId
    // (=== d.id for a real device), so byte-identical for devices.
    .innerJoin("runtimes as r", "r.id", "dx.runtimeId")
    .innerJoin("runtimeTools as dt", "dt.exposureId", "dx.id")
    .innerJoin("runtimeToolRevisions as dtr", "dtr.id", "dt.latestRevisionId")
    .select([
      "r.id as runtimeId",
      "dx.serviceId as runtimeServiceId",
      "rs.serviceKind as serviceKind",
      "dx.id as runtimeExposureId",
      "dt.id as runtimeToolId",
      "dtr.id as runtimeToolRevisionId",
    ])
    .where("dc.id", "=", args.runtimeCapabilityId)
    .where("resource.deletedAt", "is", null)
    .where("resource.status", "=", "active")
    .where("dt.currentName", "=", args.visibleToolName)
    .where("dt.status", "=", "active")
    // Soft-delete (§8.6): never auto-retry against a soft-closed runtime's tool.
    // runtimes.deleted_at is the sole runtime soft-delete root.
    .where("r.deletedAt", "is", null)
    .limit(1)
    .executeTakeFirst()
  if (!row) return null
  return {
    runtimeId: row.runtimeId as string,
    runtimeServiceId: row.runtimeServiceId as string,
    serviceKind: row.serviceKind as AutoRetryTarget["serviceKind"],
    runtimeExposureId: row.runtimeExposureId as string,
    runtimeToolId: row.runtimeToolId as string,
    runtimeToolRevisionId: row.runtimeToolRevisionId as string,
  }
}

/**
 * Reverse-lookup of a device capability for the manual-grant validation path:
 * pull device_id / workspace_id / exposure_id / stable_key / builtin_kind /
 * runtime_status / status before the write. WHERE clauses (dc.id match +
 * resource.deletedAt is null soft-delete guard) preserved verbatim.
 */
export interface RuntimeCapabilityGrantTarget {
  runtimeId: string
  workspaceId: string
  exposureId: string
  exposureStableKey: string
  builtinKind: string
  runtimeStatus: string
  status: string
}

export async function findRuntimeCapabilityGrantTarget(
  runtimeCapabilityId: string,
  executor: Executor = db
): Promise<RuntimeCapabilityGrantTarget | undefined> {
  return (
    executor
      .selectFrom("runtimeCapabilities as dc")
      .innerJoin("workspaceResources as resource", "resource.id", "dc.id")
      .innerJoin("runtimeExposures as dx", "dx.id", "dc.exposureId")
      // Generalized to the runtimes supertype (P2): existence-only join (no device
      // columns selected), so a device-less sandbox runtime resolves. r.id ===
      // dx.runtimeId (=== d.id for a device) — byte-identical for devices.
      .innerJoin("runtimes as r", "r.id", "dx.runtimeId")
      .select([
        "r.id as runtimeId",
        "resource.workspaceId as workspaceId",
        "dx.id as exposureId",
        "dx.stableKey as exposureStableKey",
        "dx.builtinKind as builtinKind",
        "dx.runtimeStatus as runtimeStatus",
        "resource.status as status",
      ])
      .where("dc.id", "=", runtimeCapabilityId)
      .where("resource.deletedAt", "is", null)
      .executeTakeFirst() as Promise<RuntimeCapabilityGrantTarget | undefined>
  )
}

/**
 * Load the conversation kind row used by the request-gating helper. Caller
 * keeps the `fallback?.conversationKind` short-circuit; the repo owns only the
 * query.
 */
export async function loadConversationKindRow(
  conversationId: string
): Promise<{ kind: string } | undefined> {
  return db
    .selectFrom("conversations")
    .select(["kind"])
    .where("id", "=", conversationId)
    .limit(1)
    .executeTakeFirst() as Promise<{ kind: string } | undefined>
}

/**
 * Capability/exposure/device reachability state for the request-gating helper.
 * The `hasActiveRuntimeSession` field comes from an inline raw `sql<boolean>`
 * EXISTS subquery referencing snake_case columns — that raw fragment is NOT
 * camelCase-rewritten, so it is copied verbatim. WHERE clauses (capability.id
 * match + resource.deletedAt is null soft-delete guard) preserved verbatim.
 */
export interface RuntimeCapabilityRequestState {
  capabilityId: string
  capabilityStatus: string
  exposureId: string
  exposureRuntimeStatus: string
  ownerWorkspaceId: string
  hasActiveRuntimeSession: boolean
}

export async function loadRuntimeCapabilityRequestState(
  capabilityId: string
): Promise<RuntimeCapabilityRequestState | undefined> {
  return (
    db
      .selectFrom("runtimeCapabilities as capability")
      .innerJoin(
        "workspaceResources as resource",
        "resource.id",
        "capability.id"
      )
      .innerJoin(
        "runtimeExposures as exposure",
        "exposure.id",
        "capability.exposureId"
      )
      // Generalized to the runtimes supertype (P2): a device-less sandbox
      // runtime resolves its request state identically. workspace_id +
      // control-plane-session id are both keyed on runtimes.id (=== devices.id
      // for a device), so byte-identical for a real device.
      .innerJoin("runtimes as runtime", "runtime.id", "exposure.runtimeId")
      .select([
        "capability.id as capabilityId",
        "resource.status as capabilityStatus",
        "exposure.id as exposureId",
        "exposure.runtimeStatus as exposureRuntimeStatus",
        "runtime.workspaceId as ownerWorkspaceId",
        sql<boolean>`EXISTS (
        SELECT 1
        FROM runtime_control_plane_sessions session_row
        WHERE session_row.runtime_id = runtime.id
          AND session_row.status = 'active'
      )`.as("hasActiveRuntimeSession"),
      ])
      .where("capability.id", "=", capabilityId)
      // TWO independent soft-delete roots gate a request: the capability-as-
      // resource axis (workspace_resources) AND the owning runtime's liveness
      // (principal axis). runtime_capabilities has no deleted_at, so both are
      // load-bearing. Keep resource.deletedAt verbatim; swap only the former
      // device-principal term for the runtimes root (sole runtime root).
      .where("resource.deletedAt", "is", null)
      .where("runtime.deletedAt", "is", null)
      .limit(1)
      .executeTakeFirst() as Promise<RuntimeCapabilityRequestState | undefined>
  )
}

/**
 * Detect a new user-facing conversation message created after `afterIso`. The
 * caller passes an IsoInstantString (Timestamp); the repo converts it once at
 * the query boundary, matching prior behavior. WHERE/OR clauses preserved
 * verbatim (message item type, role=user OR participant subject kind in
 * [workspace_member, external]).
 */
export async function hasNewUserFacingConversationMessage(
  conversationId: string,
  afterIso: string
): Promise<boolean> {
  const row = await db
    .selectFrom("conversationItems as ci")
    .leftJoin(
      "conversationParticipants as cp",
      "cp.id",
      "ci.authorParticipantId"
    )
    .leftJoin("accessSubjects as cpsubj", "cpsubj.id", "cp.subjectId")
    .select("ci.id")
    .where("ci.conversationId", "=", conversationId)
    .where("ci.itemType", "=", "message")
    .where("ci.createdAt", ">", new Date(afterIso))
    .where((eb) =>
      eb.or([
        eb("ci.role", "=", "user"),
        eb("cpsubj.kind", "in", ["workspace_member", "external"]),
      ])
    )
    .limit(1)
    .executeTakeFirst()
  return Boolean(row)
}

// ============================================================================
// Runtime-authorization-grant row queries (moved out of service.ts for guard
// r8). Every fn takes an injected `executor: Executor` (db or an in-flight
// transaction) so the service can keep its multi-statement transactions atomic
// and thread the same trx into both these repo fns and the cross-module
// helpers (upsertAccessSubject, beginRuntimeOperationOn). Rows are returned
// camelCase via CamelCasePlugin, Date objects intact. This repo layer owns
// subject hydration and business JSON policy parsing/validation; presenter owns
// instant serialization.
// ============================================================================

/**
 * SELECT projection for a grant row joined with its subject + scope
 * access_subjects view columns. Aliases are camelCase so the CamelCasePlugin
 * does not double-rewrite; raw `subj`/`scope_subj` table aliases are copied
 * verbatim from the original service query.
 */
function runtimeAuthorizationGrantSelectColumns() {
  return [
    "g.id",
    "g.workspaceId",
    "g.runtimeId",
    "g.runtimeCapabilityId",
    "g.runtimeExposureId",
    "g.subjectId",
    "g.scopeSubjectId",
    "g.createdByWorkspaceMemberId",
    "g.sourceTaskId",
    "g.retention",
    "g.status",
    "g.policy",
    "g.sourceRetryNonce",
    "g.sourceRuntimeSessionId",
    "g.sourceRequestArgs",
    "g.consumedAt",
    "g.revokedAt",
    "g.supersededAt",
    "g.governingResourceGrantId",
    "g.createdAt",
    "g.updatedAt",
    "subj.kind as subjectKind",
    "subj.workspaceId as subjectWorkspaceId",
    "subj.workspaceMemberId as subjectWorkspaceMemberId",
    "subj.actorId as subjectActorId",
    "subj.remoteAgentId as subjectRemoteAgentId",
    "subj.conversationId as subjectConversationId",
    "scope_subj.kind as scopeKind",
    "scope_subj.workspaceId as scopeWorkspaceId",
    "scope_subj.conversationId as scopeConversationId",
  ] as const
}

/**
 * Helper: hydrate a joined access_subjects row into a typed SubjectRef. This is
 * part of repo-exit row decoding because the joined columns are DB projections,
 * not service-domain inputs.
 */
function subjectRowToRef(input: {
  kind: string
  workspaceId: string | null
  workspaceMemberId: string | null
  actorId: string | null
  remoteAgentId: string | null
  conversationId: string | null
}) {
  switch (input.kind) {
    case SUBJECT_KIND.WORKSPACE:
      if (!input.workspaceId) {
        throw new InvalidGrantSubjectRowError(
          "workspace subject missing workspace_id"
        )
      }
      return workspaceRef(input.workspaceId)
    case SUBJECT_KIND.WORKSPACE_MEMBER:
      if (!input.workspaceMemberId) {
        throw new InvalidGrantSubjectRowError(
          "workspace_member subject missing workspace_member_id"
        )
      }
      return workspaceMemberRef(input.workspaceMemberId)
    case SUBJECT_KIND.ACTOR:
      if (!input.actorId) {
        throw new InvalidGrantSubjectRowError("actor subject missing actor_id")
      }
      return actorRef(input.actorId)
    case SUBJECT_KIND.REMOTE_AGENT:
      if (!input.remoteAgentId) {
        throw new InvalidGrantSubjectRowError(
          "remote_agent subject missing remote_agent_id"
        )
      }
      return remoteAgentRef(input.remoteAgentId)
    case SUBJECT_KIND.CONVERSATION:
      if (!input.conversationId) {
        throw new InvalidGrantSubjectRowError(
          "conversation subject missing conversation_id"
        )
      }
      return conversationRef(input.conversationId)
    default:
      throw new InvalidGrantSubjectRowError(
        `unsupported subject kind ${input.kind}`
      )
  }
}

export class InvalidGrantSubjectRowError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "InvalidGrantSubjectRowError"
  }
}

/**
 * Decode a grant row into the domain candidate shape consumed by service logic.
 * Business JSON (`policy`, `sourceRequestArgs`) is parsed/validated at repo
 * exit so downstream code handles typed records instead of raw JSONB.
 */
export function runtimeAuthorizationGrantRowToCandidate(
  row: RuntimeAuthorizationGrantCandidateRow
): RuntimeAuthorizationGrantCandidate {
  const subject = subjectRowToRef({
    kind: row.subjectKind,
    workspaceId: row.subjectWorkspaceId,
    workspaceMemberId: row.subjectWorkspaceMemberId,
    actorId: row.subjectActorId,
    remoteAgentId: row.subjectRemoteAgentId,
    conversationId: row.subjectConversationId,
  })
  const scope = row.scopeKind
    ? subjectRowToRef({
        kind: row.scopeKind,
        workspaceId: row.scopeWorkspaceId,
        workspaceMemberId: null,
        actorId: null,
        remoteAgentId: null,
        conversationId: row.scopeConversationId,
      })
    : undefined
  const policyJson = parseRuntimeAuthorizationGrantPolicy(row.policy)
  const validationResult = policyJson.failure
    ? { ok: false as const, failure: policyJson.failure }
    : validateGrantPolicyForCapability(policyJson.rawPolicy)
  return {
    rawRow: normalizeRuntimeAuthorizationGrantRow(row),
    rawPolicy: policyJson.rawPolicy,
    policyValidationResult: validationResult,
    subject,
    scope,
    retention: row.retention,
    retryNonceOnRow: row.sourceRetryNonce || undefined,
    sourceTaskIdOnRow: row.sourceTaskId || undefined,
  }
}

function normalizeRuntimeAuthorizationGrantRow(
  row: RuntimeAuthorizationGrantCandidateRow
): RuntimeAuthorizationGrantCandidateRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    runtimeId: row.runtimeId,
    runtimeCapabilityId: row.runtimeCapabilityId,
    runtimeExposureId: row.runtimeExposureId,
    subjectId: row.subjectId,
    scopeSubjectId: row.scopeSubjectId,
    createdByWorkspaceMemberId: row.createdByWorkspaceMemberId,
    sourceTaskId: row.sourceTaskId,
    retention: row.retention,
    status: row.status,
    policy: row.policy,
    sourceRetryNonce: row.sourceRetryNonce,
    sourceRuntimeSessionId: row.sourceRuntimeSessionId,
    sourceRequestArgs: parseRuntimeAuthorizationGrantJsonObject(
      row.sourceRequestArgs,
      "runtime authorization grant sourceRequestArgs"
    ),
    consumedAt: row.consumedAt,
    revokedAt: row.revokedAt,
    supersededAt: row.supersededAt,
    governingResourceGrantId: row.governingResourceGrantId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export function runtimeAuthorizationGrantPolicyCapability(
  policy: unknown
): unknown {
  const policyJson = parseRuntimeAuthorizationGrantPolicy(policy)
  if (policyJson.failure) return undefined
  return policyJson.rawPolicy.capability
}

export function runtimeAuthorizationGrantSubjectFailure(
  err: unknown
): PolicyValidationFailure {
  const issue: ZodIssue = {
    code: "custom",
    message: err instanceof Error ? err.message : String(err),
    path: ["subject"],
  }
  return {
    kind: "parse_error",
    issues: [issue],
  }
}

function parseRuntimeAuthorizationGrantPolicy(
  policy: unknown
):
  | { rawPolicy: Record<string, unknown>; failure?: undefined }
  | { rawPolicy: unknown; failure: PolicyValidationFailure } {
  try {
    return {
      rawPolicy: parseRuntimeAuthorizationGrantJsonObject(
        policy,
        "runtime authorization grant policy"
      ),
    }
  } catch (err) {
    return {
      rawPolicy: undefined,
      failure: runtimeAuthorizationGrantJsonFailure(err, "policy"),
    }
  }
}

function parseRuntimeAuthorizationGrantJsonObject(
  value: unknown,
  fieldName: string
): Record<string, unknown> {
  if (value === null || value === undefined) return {}
  const parsed =
    typeof value === "string" ? parseJsonString(value, fieldName) : value
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${fieldName} must be a JSON object`)
  }
  return parsed as Record<string, unknown>
}

function parseJsonString(value: string, fieldName: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch {
    throw new Error(`${fieldName} must be valid JSON`)
  }
}

function runtimeAuthorizationGrantJsonFailure(
  err: unknown,
  fieldName: string
): PolicyValidationFailure {
  const issue: ZodIssue = {
    code: "custom",
    message: err instanceof Error ? err.message : String(err),
    path: [fieldName],
  }
  return {
    kind: "parse_error",
    issues: [issue],
  }
}

/** Single grant row by id (get + post-insert refetch). Returns undefined when absent. */
export async function getRuntimeAuthorizationGrantRow(
  id: string,
  executor: Executor = db
): Promise<RuntimeAuthorizationGrantCandidateRow | undefined> {
  return executor
    .selectFrom("runtimeAuthorizationGrants as g")
    .innerJoin("accessSubjects as subj", "subj.id", "g.subjectId")
    .leftJoin(
      "accessSubjects as scope_subj",
      "scope_subj.id",
      "g.scopeSubjectId"
    )
    .select(runtimeAuthorizationGrantSelectColumns())
    .where("g.id", "=", id)
    .limit(1)
    .executeTakeFirst() as Promise<
    RuntimeAuthorizationGrantCandidateRow | undefined
  >
}

export interface InsertRuntimeAuthorizationGrantValues {
  workspaceId: string
  runtimeId: string
  runtimeCapabilityId: string
  runtimeExposureId: string
  subjectId: string
  scopeSubjectId: string | null
  createdByWorkspaceMemberId: string | null
  sourceTaskId: string | null
  retention: RuntimeAuthorizationGrantRetention
  policy: RuntimeAuthorizationGrantPolicyInsert
  sourceRetryNonce: string | null
  sourceRuntimeSessionId: string | null
  sourceRequestArgs: RuntimeAuthorizationGrantSourceRequestArgsInsert
}

/**
 * The set of CLI-Anything entry_points the device currently reports as runnable,
 * read from runtime_exposures.metadata.availableClis on the given exposure (plan
 * §5.C). Keyed by entry_point (the bare program a program_only grant authorizes).
 * Empty set when the exposure has no availableClis (no catalog reported).
 */
export async function selectExposureAvailableCliEntryPoints(
  runtimeExposureId: string,
  queryable: Executor = db
): Promise<Set<string>> {
  const row = await queryable
    .selectFrom("runtimeExposures")
    .select("metadata")
    .where("id", "=", runtimeExposureId)
    .executeTakeFirst()
  const metadata = row?.metadata as
    | { availableClis?: Record<string, { available?: boolean }> }
    | null
    | undefined
  const availableClis = metadata?.availableClis
  if (!availableClis || typeof availableClis !== "object") return new Set()
  // Only entry_points the device reports as available===true may receive a
  // program_only grant — never mint for an advertised-but-unavailable CLI.
  return new Set(
    Object.entries(availableClis)
      .filter(
        ([, v]) => v != null && typeof v === "object" && v.available === true
      )
      .map(([entryPoint]) => entryPoint)
  )
}

/** INSERT a grant row, RETURNING its id. Caller refetches the joined row. */
export async function insertRuntimeAuthorizationGrantRow(
  executor: Executor,
  values: InsertRuntimeAuthorizationGrantValues
): Promise<{ id: string } | undefined> {
  return executor
    .insertInto("runtimeAuthorizationGrants")
    .values({
      workspaceId: values.workspaceId,
      runtimeId: values.runtimeId,
      runtimeCapabilityId: values.runtimeCapabilityId,
      runtimeExposureId: values.runtimeExposureId,
      subjectId: values.subjectId,
      scopeSubjectId: values.scopeSubjectId,
      createdByWorkspaceMemberId: values.createdByWorkspaceMemberId,
      sourceTaskId: values.sourceTaskId,
      retention: values.retention,
      status: "active",
      policy: values.policy,
      sourceRetryNonce: values.sourceRetryNonce,
      sourceRuntimeSessionId: values.sourceRuntimeSessionId,
      sourceRequestArgs: values.sourceRequestArgs,
    })
    .returning("id")
    .executeTakeFirst()
}

/** Status-flip to 'revoked' (NOW()), guarded by status='active'. */
export async function revokeRuntimeAuthorizationGrantRow(
  id: string,
  executor: Executor = db
): Promise<void> {
  await executor
    .updateTable("runtimeAuthorizationGrants")
    .set({
      status: "revoked",
      revokedAt: sql`NOW()`,
    })
    .where("id", "=", id)
    .where("status", "=", "active")
    .execute()
}

/** Status-flip to 'superseded' (NOW()), guarded by status='active'. */
export async function supersedeRuntimeAuthorizationGrantRow(
  id: string,
  executor: Executor = db
): Promise<void> {
  await executor
    .updateTable("runtimeAuthorizationGrants")
    .set({
      status: "superseded",
      supersededAt: sql`NOW()`,
    })
    .where("id", "=", id)
    .where("status", "=", "active")
    .execute()
}

/**
 * Atomic consume of a `consume_once` grant via raw SQL FOR UPDATE SKIP LOCKED —
 * snake_case identifiers are intentional (this fragment is NOT rewritten by the
 * CamelCasePlugin). Returns true when THIS caller flipped the row to 'consumed';
 * false when another concurrent dispatch won the race or the row was non-active.
 */
export async function consumeRuntimeAuthorizationGrantRow(
  id: string,
  executor: Executor = db
): Promise<boolean> {
  const statement = sql<{ id: string }>`
    UPDATE runtime_authorization_grants
    SET status = 'consumed', consumed_at = NOW()
    WHERE id = (
      SELECT id FROM runtime_authorization_grants
      WHERE id = ${id} AND status = 'active'
        AND EXISTS (
          SELECT 1 FROM runtimes rt
          WHERE rt.id = runtime_authorization_grants.runtime_id
            AND rt.deleted_at IS NULL
        )
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id
  `
  const result = await statement.execute(executor)
  return result.rows.length > 0
}

export interface ListCandidateRowsForDispatchParams {
  workspaceId: string
  runtimeId: string
  runtimeCapabilityId: string
  runtimeExposureId: string
  runtimeSubjectIds: string[]
  runtimeScopeSubjectIds: string[]
  retryNonce?: string
  sourceTaskId?: string
}

/**
 * Multi-predicate candidate SELECT for the dispatch claim path. Every
 * where-clause/guard (status active, subject in-list, scope OR-branch,
 * retention/retryNonce/sourceTaskId OR-branches) is preserved verbatim. Caller
 * guarantees runtimeSubjectIds is non-empty.
 */
export async function listCandidateRowsForDispatch(
  params: ListCandidateRowsForDispatchParams,
  executor: Executor = db
): Promise<RuntimeAuthorizationGrantCandidateRow[]> {
  const rows = await executor
    .selectFrom("runtimeAuthorizationGrants as g")
    .innerJoin("accessSubjects as subj", "subj.id", "g.subjectId")
    .leftJoin(
      "accessSubjects as scope_subj",
      "scope_subj.id",
      "g.scopeSubjectId"
    )
    // Liveness gate: never surface a grant whose owning runtime is soft-deleted
    // (runtimes.deleted_at is the sole runtime root). The consume-claim path
    // gates independently; this pre-filters the dispatch candidate set.
    .innerJoin("runtimes as rt", "rt.id", "g.runtimeId")
    .select(runtimeAuthorizationGrantSelectColumns())
    .where("rt.deletedAt", "is", null)
    .where("g.workspaceId", "=", params.workspaceId)
    .where("g.runtimeId", "=", params.runtimeId)
    .where("g.runtimeCapabilityId", "=", params.runtimeCapabilityId)
    .where("g.runtimeExposureId", "=", params.runtimeExposureId)
    .where("g.status", "=", "active")
    .where("g.subjectId", "in", params.runtimeSubjectIds)
    .where((eb) =>
      eb.or([
        eb("g.scopeSubjectId", "is", null),
        ...(params.runtimeScopeSubjectIds.length > 0
          ? [eb("g.scopeSubjectId", "in", params.runtimeScopeSubjectIds)]
          : []),
      ])
    )
    .where((eb) => {
      const branches: any[] = [eb("g.retention", "=", "until_revoked")]
      if (params.retryNonce) {
        branches.push(
          eb.and([
            eb("g.retention", "=", "consume_once"),
            eb("g.sourceRetryNonce", "=", params.retryNonce),
          ])
        )
      }
      if (params.sourceTaskId) {
        branches.push(
          eb.and([
            eb("g.retention", "=", "consume_once"),
            eb("g.sourceTaskId", "=", params.sourceTaskId),
          ])
        )
      }
      return eb.or(branches)
    })
    .orderBy("g.createdAt", "desc")
    .execute()
  return rows as RuntimeAuthorizationGrantCandidateRow[]
}

/**
 * Dashboard list SELECT. Returns raw rows (service splits into {valid, corrupt}).
 * When includeRevoked is false the active-status guard is applied verbatim.
 */
export async function listDashboardGrantRows(
  input: {
    workspaceId: string
    runtimeCapabilityId: string
    includeRevoked?: boolean
  },
  executor: Executor = db
): Promise<RuntimeAuthorizationGrantCandidateRow[]> {
  let query = executor
    .selectFrom("runtimeAuthorizationGrants as g")
    .innerJoin("accessSubjects as subj", "subj.id", "g.subjectId")
    .leftJoin(
      "accessSubjects as scope_subj",
      "scope_subj.id",
      "g.scopeSubjectId"
    )
    .select(runtimeAuthorizationGrantSelectColumns())
    .where("g.workspaceId", "=", input.workspaceId)
    .where("g.runtimeCapabilityId", "=", input.runtimeCapabilityId)
    .orderBy("g.createdAt", "desc")
  if (!input.includeRevoked) {
    query = query.where("g.status", "=", "active")
  }
  const rows = await query.execute()
  return rows as RuntimeAuthorizationGrantCandidateRow[]
}

// ============================================================================
// Transaction edge for the claim/create paths. The `db.transaction()` open
// lives here (repo is the designated db-client layer) so service.ts can stay
// free of the singleton while keeping its multi-statement transactions atomic:
// service supplies a callback and receives the in-flight trx, threading it into
// both these repo fns and the cross-module helpers it orchestrates.
// ============================================================================

/**
 * Open a fresh runtime-authorization transaction and run `fn` inside it. The
 * service uses this for the no-executor create path and the claim path so the
 * subject upsert + INSERT + refetch (create) and lock_timeout + FOR SHARE
 * drift/race checks + beginRuntimeOperationOn (claim) all run atomically.
 */
export async function runRuntimeAuthorizationGrantTransaction<T>(
  fn: (trx: DatabaseTransaction) => Promise<T>
): Promise<T> {
  return db.transaction().execute(fn)
}

/**
 * `SET LOCAL lock_timeout = '500ms'` for the claim transaction: a lock_timeout
 * means another connection is updating runtime_tools (catalog sync); the service
 * aborts and surfaces a transient runtime_constraint rather than waiting.
 */
export async function setLocalLockTimeout(
  trx: DatabaseTransaction
): Promise<void> {
  await sql`SET LOCAL lock_timeout = '500ms'`.execute(trx)
}

/**
 * FOR SHARE read of runtime_tools.latest_revision_id inside the claim tx: blocks
 * the catalog UPDATE without blocking other dispatch share-lockers. Returns the
 * row (or undefined) so the service does its drift comparison.
 */
export async function lockDeviceToolLatestRevisionForShare(
  trx: DatabaseTransaction,
  toolId: string
): Promise<{ latestRevisionId: string | null } | undefined> {
  const row = await trx
    .selectFrom("runtimeTools")
    .select(["latestRevisionId"])
    .where("id", "=", toolId)
    .forShare()
    .executeTakeFirst()
  if (!row) return undefined
  return { latestRevisionId: row.latestRevisionId as string | null }
}

/**
 * FOR SHARE re-check that an until_revoked grant is still active inside the
 * claim tx. No state mutation. Returns true when the row is still active.
 */
export async function lockActiveGrantForShare(
  trx: DatabaseTransaction,
  id: string
): Promise<boolean> {
  const grantRow = await trx
    .selectFrom("runtimeAuthorizationGrants")
    .select("id")
    .where("id", "=", id)
    .where("status", "=", "active")
    .forShare()
    .executeTakeFirst()
  return Boolean(grantRow)
}
