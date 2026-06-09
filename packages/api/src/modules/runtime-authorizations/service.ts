import {
  normalizePathPrefix as sharedNormalizePathPrefix,
  pathWithinPrefix as sharedPathWithinPrefix,
  normalizeCommandText as sharedNormalizeCommandText,
  hasCompoundShellOperators as sharedHasCompoundShellOperators,
  commandPrefixMatches as sharedCommandPrefixMatches,
  filesystemPolicyAllows as sharedFilesystemPolicyAllows,
  commandlinePolicyAllows as sharedCommandlinePolicyAllows,
  cuaPolicyAllows as sharedCuaPolicyAllows,
  browserPolicyAllows as sharedBrowserPolicyAllows,
  parseJsonObject,
  SUBJECT_KIND,
  workspaceRef,
  workspaceMemberRef,
  actorRef,
  remoteAgentRef,
  conversationRef,
  type Timestamp,
  type SubjectRef,
} from "@synapse/shared"
import { serializeCommandlinePolicyToWire } from "@synapse/shared/access/policies"
import type {
  RuntimeAuthorizationGrantRetention,
  RuntimeAuthorizationGrantStatus,
  RuntimeAuthorizationRequestedAction,
  RuntimeAuthorizationPreset,
  SharedRuntimeAuthorizationGrantSpec,
} from "@synapse/shared/types"
import {
  GrantPolicySchema,
  validateGrantPolicyForCapability,
  type PolicyValidationFailure,
  type GrantPolicy,
} from "@synapse/shared/access/policies"
import { subjectScopeLabel } from "@synapse/shared"
import { sql, type Selectable } from "kysely"
import type { ZodIssue } from "zod"
import {
  db,
  runBuilder,
  takeFirstOn,
  type Executor,
  type KyselyDb,
  type TableInsert,
  type TableRow,
} from "../../infrastructure/database/kysely.js"
import {
  requireInstantDate,
  serializeInstant,
  serializeOptionalInstant,
} from "../../infrastructure/datetime.js"
import {
  BrowserGrantPolicyError,
  normalizeBrowserGrantPolicy,
} from "@synapse/shared/access/policies"
import { upsertAccessSubject } from "../access/subject-registry.js"
import {
  assertNoDeviceToolRevisionDrift,
  beginDeviceOperationOn,
  type BeginOperationInput,
  type BeginOperationResult,
} from "../devices/operations.js"
import type { RuntimePrincipalContext } from "../access/subject-resolution.js"

function normalizePathPrefix(value: unknown) {
  return sharedNormalizePathPrefix(value)
}

function normalizeCommandText(value: unknown) {
  return sharedNormalizeCommandText(value)
}
function normalizePathPrefixes(values: unknown) {
  if (!Array.isArray(values)) return []
  const result: string[] = []
  for (const value of values) {
    const normalized = normalizePathPrefix(value)
    if (normalized) result.push(normalized)
  }
  return result
}

// ============================================================================
// subject-scope-refactor: RuntimeAuthorizationGrantRecord — DB row hydrated
// with subject/scope SubjectRef pair + derived label. Extends the API-side
// camelCase policy spec so existing readers (auto-retry envelope, UI grant
// summary) continue to address `grant.filesystem`, `grant.browser`, etc.
// ============================================================================

export interface RuntimeAuthorizationGrantRecord extends SharedRuntimeAuthorizationGrantSpec {
  id: string
  workspaceId: string
  deviceId: string
  deviceCapabilityId: string
  deviceExposureId: string
  /** Authorization subject (workspace / workspace_member / actor / remote_agent / conversation). */
  subject: SubjectRef
  /** Optional runtime-context scope (workspace or conversation). */
  scope?: SubjectRef
  /**
   * Derived display label from subjectScopeLabel({subject, scope?}). Mirrors
   * the wire envelope's `grant_scope` field for UI / audit. Possible values
   * include: 'workspace' | 'workspace_member' | 'actor' | 'remote_agent' |
   * 'conversation' or scoped actor/remote_agent grants.
   */
  scopeLabel: string
  createdByWorkspaceMemberId?: string
  sourceTaskId?: string
  sourceRetryNonce?: string
  sourceRuntimeSessionId?: string
  sourceRequestArgs: Record<string, unknown>
  retention: RuntimeAuthorizationGrantRetention
  status: RuntimeAuthorizationGrantStatus
  createdAt: Timestamp
  updatedAt: Timestamp
  consumedAt?: Timestamp
  revokedAt?: Timestamp
  supersededAt?: Timestamp
}

/**
 * Candidate row pulled by the canonical helper's list step. Carries the raw
 * grant row + already-joined subject/scope SubjectRef + safe-parse result so
 * the matcher (three-state) can distinguish parse_error /
 * missing_branch_payload / schema_mismatch from no_match — without exception
 * propagation that would mask corrupt rows as silent fallbacks.
 */
export interface RuntimeAuthorizationGrantCandidate {
  rawRow: TableRow<"runtime_authorization_grants">
  rawPolicy: unknown
  policyValidationResult:
    | { ok: true; parsed: GrantPolicy }
    | { ok: false; failure: PolicyValidationFailure }
  subject: SubjectRef
  scope?: SubjectRef
  retention: RuntimeAuthorizationGrantRetention
  retryNonceOnRow?: string
  sourceTaskIdOnRow?: string
}

/**
 * Helper: hydrate a candidate row's joined access_subjects view into a typed
 * SubjectRef. Throws InvalidGrantSubjectRowError if the joined columns can't
 * be reconciled with the kind discriminator (data corruption case — should be
 * impossible under tg_runtime_authorization_grant_validate enforcement, but
 * guarded here for defense-in-depth).
 */
function subjectRowToRef(input: {
  kind: string
  workspaceId: string | null
  workspaceMemberId: string | null
  actorId: string | null
  remoteAgentId: string | null
  conversationId: string | null
}): SubjectRef {
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

// ============================================================================
// subject-scope-refactor: presetToOwnerScope — caller-side helper. Translates
// a wire-level RuntimeAuthorizationPreset + RuntimePrincipalContext into the
// (subject, scope?, retention) triple that createRuntimeAuthorizationGrant
// accepts. Enforces the input validity invariants up front so callers can't
// produce nonsense pairings (e.g. workspace preset without workspaceId, or
// actor preset under a remote_agent principal).
// ============================================================================

export function presetToOwnerScope(
  preset: RuntimeAuthorizationPreset,
  ctx: RuntimePrincipalContext,
  workspaceId: string
): {
  subject: SubjectRef
  scope?: SubjectRef
  retention: RuntimeAuthorizationGrantRetention
} {
  switch (preset) {
    case "once": {
      if (
        ctx.principal.kind !== SUBJECT_KIND.ACTOR &&
        ctx.principal.kind !== SUBJECT_KIND.REMOTE_AGENT
      ) {
        throw new InvalidPresetForPrincipalError(
          `'once' preset is only valid for actor/remote_agent principals (got ${ctx.principal.kind})`
        )
      }
      const subject = ctx.principal
      const scope =
        ctx.activeConversationSubjectId !== undefined &&
        ctx.runtimeConversationId
          ? conversationRef(ctx.runtimeConversationId)
          : undefined
      return { subject, scope, retention: "consume_once" }
    }
    case "actor": {
      if (ctx.principal.kind !== SUBJECT_KIND.ACTOR) {
        throw new InvalidPresetForPrincipalError(
          `'actor' preset is only valid for actor principals (got ${ctx.principal.kind})`
        )
      }
      const subject = ctx.principal
      const scope =
        ctx.activeConversationSubjectId !== undefined &&
        ctx.runtimeConversationId
          ? conversationRef(ctx.runtimeConversationId)
          : undefined
      return { subject, scope, retention: "until_revoked" }
    }
    case "remote_agent": {
      if (ctx.principal.kind !== SUBJECT_KIND.REMOTE_AGENT) {
        throw new InvalidPresetForPrincipalError(
          `'remote_agent' preset is only valid for remote_agent principals (got ${ctx.principal.kind})`
        )
      }
      const subject = ctx.principal
      const scope =
        ctx.activeConversationSubjectId !== undefined &&
        ctx.runtimeConversationId
          ? conversationRef(ctx.runtimeConversationId)
          : undefined
      return { subject, scope, retention: "until_revoked" }
    }
    case "conversation": {
      if (!ctx.runtimeConversationId) {
        throw new InvalidPresetForPrincipalError(
          "'conversation' preset requires ctx.runtimeConversationId to be set"
        )
      }
      return {
        subject: conversationRef(ctx.runtimeConversationId),
        retention: "until_revoked",
      }
    }
    case "workspace":
      return {
        subject: workspaceRef(workspaceId),
        retention: "until_revoked",
      }
  }
}

export class InvalidPresetForPrincipalError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "InvalidPresetForPrincipalError"
  }
}

// ============================================================================
// subject-scope-refactor: assertSupportedRuntimeGrantTarget — service-layer
// whitelist enforcement. Mirrors the DB trigger
// tg_runtime_authorization_grant_validate and the wire schema
// ScopedSubjectTargetWireSchema.superRefine. Three valid shapes:
//   (a) unscoped: subject ∈ {workspace, workspace_member, actor, remote_agent,
//       conversation};
//   (b) (subject=actor, scope=conversation);
//   (c) (subject=remote_agent, scope=conversation).
// Any other shape throws UnsupportedGrantTargetError BEFORE the INSERT, so
// callers don't see a generic DB exception.
// ============================================================================

export function assertSupportedRuntimeGrantTarget(
  subject: SubjectRef,
  scope?: SubjectRef
): void {
  if (!scope) {
    const allowedUnscoped = [
      SUBJECT_KIND.WORKSPACE,
      SUBJECT_KIND.WORKSPACE_MEMBER,
      SUBJECT_KIND.ACTOR,
      SUBJECT_KIND.REMOTE_AGENT,
      SUBJECT_KIND.CONVERSATION,
    ] as const
    if (!(allowedUnscoped as readonly string[]).includes(subject.kind)) {
      throw new UnsupportedGrantTargetError(
        `unscoped runtime authorization grant subject.kind=${subject.kind} is not allowed (only workspace/workspace_member/actor/remote_agent/conversation)`
      )
    }
    return
  }
  const allowedScoped =
    (subject.kind === SUBJECT_KIND.ACTOR ||
      subject.kind === SUBJECT_KIND.REMOTE_AGENT) &&
    scope.kind === SUBJECT_KIND.CONVERSATION
  if (!allowedScoped) {
    throw new UnsupportedGrantTargetError(
      `scoped runtime authorization grant (subject.kind=${subject.kind}, scope.kind=${scope.kind}) is not in whitelist (only actor+conversation, remote_agent+conversation)`
    )
  }
}

export class UnsupportedGrantTargetError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "UnsupportedGrantTargetError"
  }
}

// ============================================================================
// SELECT column projection
// ============================================================================

function runtimeAuthorizationGrantSelectColumns() {
  return [
    "g.id",
    "g.workspace_id",
    "g.device_id",
    "g.device_capability_id",
    "g.device_exposure_id",
    "g.subject_id",
    "g.scope_subject_id",
    "g.created_by_workspace_member_id",
    "g.source_task_id",
    "g.retention",
    "g.status",
    "g.policy",
    "g.source_retry_nonce",
    "g.source_runtime_session_id",
    "g.source_request_args",
    "g.consumed_at",
    "g.revoked_at",
    "g.superseded_at",
    "g.created_at",
    "g.updated_at",
    "subj.kind as subject_kind",
    "subj.workspace_id as subject_workspace_id",
    "subj.workspace_member_id as subject_workspace_member_id",
    "subj.actor_id as subject_actor_id",
    "subj.remote_agent_id as subject_remote_agent_id",
    "subj.conversation_id as subject_conversation_id",
    "scope_subj.kind as scope_kind",
    "scope_subj.workspace_id as scope_workspace_id",
    "scope_subj.conversation_id as scope_conversation_id",
  ] as const
}

// ============================================================================
// Mapping: candidate → record. Mapper is a pure function — caller must pass
// parsedPolicy from a successful validateGrantPolicyForCapability call. The
// canonical helper enforces this contract; sideways callers (dashboard list)
// produce a parallel "{ valid, corrupt }" split (Batch 7 dashboard API).
// ============================================================================

export function mapRuntimeAuthorizationGrantCandidate(
  candidate: RuntimeAuthorizationGrantCandidate,
  parsedPolicy: GrantPolicy
): RuntimeAuthorizationGrantRecord {
  const row = candidate.rawRow
  const scopeLabel = subjectScopeLabel({
    subject: candidate.subject,
    scope: candidate.scope,
  })
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    deviceId: row.device_id,
    deviceCapabilityId: row.device_capability_id,
    deviceExposureId: row.device_exposure_id,
    subject: candidate.subject,
    scope: candidate.scope,
    scopeLabel,
    createdByWorkspaceMemberId: row.created_by_workspace_member_id || undefined,
    sourceTaskId: row.source_task_id || undefined,
    sourceRetryNonce: row.source_retry_nonce || undefined,
    sourceRuntimeSessionId: row.source_runtime_session_id || undefined,
    sourceRequestArgs: parseJsonObject(row.source_request_args),
    retention: row.retention,
    status: row.status,
    ...(parsedPolicy as SharedRuntimeAuthorizationGrantSpec),
    createdAt: serializeInstant(
      requireInstantDate(
        row.created_at,
        `runtime_authorization_grants.${row.id}.created_at`
      )
    ),
    updatedAt: serializeInstant(
      requireInstantDate(
        row.updated_at,
        `runtime_authorization_grants.${row.id}.updated_at`
      )
    ),
    consumedAt: serializeOptionalInstant(row.consumed_at),
    revokedAt: serializeOptionalInstant(row.revoked_at),
    supersededAt: serializeOptionalInstant(row.superseded_at),
  }
}

function rowToCandidate(row: any): RuntimeAuthorizationGrantCandidate {
  const subject = subjectRowToRef({
    kind: row.subject_kind,
    workspaceId: row.subject_workspace_id,
    workspaceMemberId: row.subject_workspace_member_id,
    actorId: row.subject_actor_id,
    remoteAgentId: row.subject_remote_agent_id,
    conversationId: row.subject_conversation_id,
  })
  const scope = row.scope_kind
    ? subjectRowToRef({
        kind: row.scope_kind,
        workspaceId: row.scope_workspace_id,
        workspaceMemberId: null,
        actorId: null,
        remoteAgentId: null,
        conversationId: row.scope_conversation_id,
      })
    : undefined
  const rawPolicy = parseJsonObject(row.policy)
  const validationResult = validateGrantPolicyForCapability(rawPolicy)
  return {
    rawRow: row as TableRow<"runtime_authorization_grants">,
    rawPolicy,
    policyValidationResult: validationResult,
    subject,
    scope,
    retention: row.retention,
    retryNonceOnRow: row.source_retry_nonce || undefined,
    sourceTaskIdOnRow: row.source_task_id || undefined,
  }
}

// ============================================================================
// CRUD: create, get, revoke, supersede
// ============================================================================

export interface CreateRuntimeAuthorizationGrantParams {
  workspaceId: string
  deviceId: string
  deviceCapabilityId: string
  deviceExposureId: string
  subject: SubjectRef
  scope?: SubjectRef
  retention: RuntimeAuthorizationGrantRetention
  policy: SharedRuntimeAuthorizationGrantSpec
  createdByWorkspaceMemberId?: string
  sourceTaskId?: string
  sourceRetryNonce?: string
  sourceRuntimeSessionId?: string
  sourceRequestArgs?: Record<string, unknown>
}

function normalizeGrantSpecForInsert(
  grantSpec: SharedRuntimeAuthorizationGrantSpec
): SharedRuntimeAuthorizationGrantSpec {
  return {
    capability: grantSpec.capability,
    filesystem: grantSpec.filesystem
      ? {
          access: grantSpec.filesystem.access,
          pathPrefixes: normalizePathPrefixes(
            grantSpec.filesystem.pathPrefixes
          ),
        }
      : undefined,
    cua: grantSpec.cua ? { access: grantSpec.cua.access } : undefined,
    browser: grantSpec.browser
      ? {
          action: grantSpec.browser.action,
          scopeType: grantSpec.browser.scopeType,
          origin:
            typeof grantSpec.browser.origin === "string" &&
            grantSpec.browser.origin.trim()
              ? grantSpec.browser.origin.trim()
              : undefined,
          host:
            typeof grantSpec.browser.host === "string" &&
            grantSpec.browser.host.trim()
              ? grantSpec.browser.host.trim().toLowerCase()
              : undefined,
          registrableDomain:
            typeof grantSpec.browser.registrableDomain === "string" &&
            grantSpec.browser.registrableDomain.trim()
              ? grantSpec.browser.registrableDomain.trim().toLowerCase()
              : undefined,
          // v3.1: preserve operations; if a stale upstream caller sneaked in
          // a scopeSource, the surrounding object literal dropped it because
          // we only enumerate known keys. dedup + sort for stable JSONB.
          operations: Array.isArray(grantSpec.browser.operations)
            ? Array.from(new Set(grantSpec.browser.operations)).sort()
            : undefined,
        }
      : undefined,
    commandline: grantSpec.commandline
      ? normalizeCommandlineGrantSpec(grantSpec.commandline)
      : undefined,
  }
}

function normalizeCommandlineGrantSpec(
  grant: SharedRuntimeAuthorizationGrantSpec["commandline"]
): SharedRuntimeAuthorizationGrantSpec["commandline"] {
  if (!grant) return undefined
  if (grant.executor === "exec_file") {
    return {
      executor: "exec_file",
      commandMatchType: grant.commandMatchType,
      program: grant.program,
      argvPrefix: grant.argvPrefix,
      workingDirectory:
        normalizePathPrefix(grant.workingDirectory) || undefined,
      allowBundledToolchain: grant.allowBundledToolchain,
      allowedEnv: grant.allowedEnv,
    }
  }
  if (grant.executor === "sandbox") {
    return {
      executor: "sandbox",
      workingDirectory:
        normalizePathPrefix(grant.workingDirectory) || undefined,
      allowedEnv: grant.allowedEnv,
    }
  }
  return {
    executor: grant.executor,
    commandMatchType: grant.commandMatchType,
    commandText: normalizeCommandText(grant.commandText) || undefined,
    workingDirectory: normalizePathPrefix(grant.workingDirectory) || undefined,
    allowBundledToolchain: grant.allowBundledToolchain,
    allowedEnv: grant.allowedEnv,
  }
}

export async function createRuntimeAuthorizationGrant(
  params: CreateRuntimeAuthorizationGrantParams,
  executor?: Executor
): Promise<RuntimeAuthorizationGrantRecord> {
  // subject-scope-refactor: whitelist gate BEFORE any side effect, so callers
  // can't slip through nonsense combinations like workspace_member+conversation.
  assertSupportedRuntimeGrantTarget(params.subject, params.scope)

  // v3.1 §clarification #24: browser grants must pass
  // normalizeBrowserGrantPolicy unconditionally. This is the final defence
  // before the policy lands in JSONB — manual endpoint + approval path both
  // rely on this so neither can write a scope-less / dead grant. Throws
  // BrowserGrantPolicyError; callers map to HTTP 400 / task rejection.
  const parsedPolicy = GrantPolicySchema.parse(
    params.policy
  ) as SharedRuntimeAuthorizationGrantSpec
  if (parsedPolicy.browser) {
    parsedPolicy.browser = normalizeBrowserGrantPolicy(parsedPolicy.browser)
  }
  const grantSpec = normalizeGrantSpecForInsert(parsedPolicy)

  if (executor) {
    // Every production caller threads a Kysely executor (task approval runs
    // inside withDbTransaction → Transaction<Database>; the manual
    // endpoint passes none).
    return createGrantInKyselyTx(executor, params, grantSpec)
  }

  // No transaction: normalize to a fresh Kysely transaction so we still run
  // subject upsert + grant INSERT + refetch in the same transaction (no
  // partial state if an unrelated failure rolls back).
  return db
    .transaction()
    .execute((trx) => createGrantInKyselyTx(trx, params, grantSpec))
}

async function createGrantInKyselyTx(
  trx: Executor,
  params: CreateRuntimeAuthorizationGrantParams,
  grantSpec: SharedRuntimeAuthorizationGrantSpec
): Promise<RuntimeAuthorizationGrantRecord> {
  const subjectId = await upsertAccessSubject(trx, params.subject)
  const scopeSubjectId = params.scope
    ? await upsertAccessSubject(trx, params.scope)
    : null
  const inserted = await trx
    .insertInto("runtime_authorization_grants")
    .values({
      workspace_id: params.workspaceId,
      device_id: params.deviceId,
      device_capability_id: params.deviceCapabilityId,
      device_exposure_id: params.deviceExposureId,
      subject_id: subjectId,
      scope_subject_id: scopeSubjectId,
      created_by_workspace_member_id: params.createdByWorkspaceMemberId || null,
      source_task_id: params.sourceTaskId || null,
      retention: params.retention,
      status: "active",
      policy:
        grantSpec as unknown as TableInsert<"runtime_authorization_grants">["policy"],
      source_retry_nonce: params.sourceRetryNonce || null,
      source_runtime_session_id: params.sourceRuntimeSessionId || null,
      source_request_args: (params.sourceRequestArgs ||
        {}) as TableInsert<"runtime_authorization_grants">["source_request_args"],
    })
    .returning("id")
    .executeTakeFirst()
  if (!inserted) {
    throw new Error("Failed to create runtime authorization grant")
  }
  const row = await trx
    .selectFrom("runtime_authorization_grants as g")
    .innerJoin("access_subjects as subj", "subj.id", "g.subject_id")
    .leftJoin(
      "access_subjects as scope_subj",
      "scope_subj.id",
      "g.scope_subject_id"
    )
    .select(runtimeAuthorizationGrantSelectColumns() as unknown as any)
    .where("g.id", "=", inserted.id)
    .limit(1)
    .executeTakeFirst()
  if (!row) {
    throw new Error("Failed to re-fetch inserted runtime authorization grant")
  }
  const candidate = rowToCandidate(row)
  if (!candidate.policyValidationResult.ok) {
    throw new InvalidGrantSubjectRowError(
      `freshly-inserted grant ${inserted.id} fails policy validation: ${candidate.policyValidationResult.failure.kind}`
    )
  }
  return mapRuntimeAuthorizationGrantCandidate(
    candidate,
    candidate.policyValidationResult.parsed
  )
}

export async function getRuntimeAuthorizationGrant(
  id: string,
  queryable?: Executor
): Promise<RuntimeAuthorizationGrantRecord | null> {
  const statement = db
    .selectFrom("runtime_authorization_grants as g")
    .innerJoin("access_subjects as subj", "subj.id", "g.subject_id")
    .leftJoin(
      "access_subjects as scope_subj",
      "scope_subj.id",
      "g.scope_subject_id"
    )
    .select(runtimeAuthorizationGrantSelectColumns() as unknown as any)
    .where("g.id", "=", id)
    .limit(1)
  const row = queryable
    ? await takeFirstOn<any>(queryable, statement)
    : await statement.executeTakeFirst()
  if (!row) return null
  const candidate = rowToCandidate(row)
  if (!candidate.policyValidationResult.ok) {
    // Read path: surface as null rather than throw, so dashboard "valid"
    // listings don't break on a single corrupt row. Dashboard dual-stream
    // (Batch 7 lists) handles corrupt visibility separately.
    return null
  }
  return mapRuntimeAuthorizationGrantCandidate(
    candidate,
    candidate.policyValidationResult.parsed
  )
}

export async function revokeRuntimeAuthorizationGrant(
  id: string,
  queryable?: Executor
) {
  const statement = db
    .updateTable("runtime_authorization_grants")
    .set({
      status: "revoked",
      revoked_at: sql`NOW()`,
    })
    .where("id", "=", id)
    .where("status", "=", "active")
  if (queryable) {
    await runBuilder(queryable, statement)
    return
  }
  await statement.execute()
}

export async function supersedeRuntimeAuthorizationGrant(
  id: string,
  queryable?: Executor
) {
  const statement = db
    .updateTable("runtime_authorization_grants")
    .set({
      status: "superseded",
      superseded_at: sql`NOW()`,
    })
    .where("id", "=", id)
    .where("status", "=", "active")
  if (queryable) {
    await runBuilder(queryable, statement)
    return
  }
  await statement.execute()
}

// ============================================================================
// consumeRuntimeAuthorizationGrant: SKIP LOCKED, returns boolean (true = this
// caller actually flipped the row to 'consumed'; false = another concurrent
// dispatch won the race, or the row was already non-active). MUST only be
// called on `consume_once` retention candidates; until_revoked grants are
// validated separately via FOR SHARE (no state mutation).
// ============================================================================

export async function consumeRuntimeAuthorizationGrant(
  id: string,
  executor?: Executor
): Promise<boolean> {
  // Use raw SQL for SKIP LOCKED semantics — Kysely's updateTable doesn't yet
  // expose a clean way to nest a FOR UPDATE SKIP LOCKED sub-select.
  const statement = sql<{ id: string }>`
    UPDATE runtime_authorization_grants
    SET status = 'consumed', consumed_at = NOW()
    WHERE id = (
      SELECT id FROM runtime_authorization_grants
      WHERE id = ${id} AND status = 'active'
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id
  `
  const result = await statement.execute(executor ?? db)
  return result.rows.length > 0
}

// ============================================================================
// Policy matchers (unchanged from dev — capability-specific allow checks).
// ============================================================================

export function filesystemPolicyMatches(
  grant: SharedRuntimeAuthorizationGrantSpec,
  action: RuntimeAuthorizationRequestedAction
) {
  const granted = grant.filesystem
  const requested = action.filesystem
  if (!granted || !requested) return false
  // Scoped-pushdown tools (fs_search / fs_history_list / fs_index_task_status):
  // the projection set `scopeIsPushdown` because the tool itself doesn't
  // take a path argument and the device-side handler operates over the
  // caller's existing read prefixes. Match on access alone here; the
  // device-runtime still enforces the actual scope at dispatch time.
  if (requested.scopeIsPushdown === true) {
    if (granted.pathPrefixes.length === 0) return false
    // write covers read; an existing write grant satisfies a read pushdown.
    if (requested.access === "write" && granted.access !== "write") return false
    return true
  }
  if (
    granted.pathPrefixes.length === 0 ||
    requested.pathPrefixes.length === 0
  ) {
    return false
  }
  return requested.pathPrefixes.every((requestedPrefix) =>
    sharedFilesystemPolicyAllows(
      {
        access: granted.access,
        pathPrefixes: granted.pathPrefixes,
      },
      requested.access,
      requestedPrefix
    )
  )
}

export function browserPolicyMatches(
  grant: SharedRuntimeAuthorizationGrantSpec,
  action: RuntimeAuthorizationRequestedAction
) {
  const granted = grant.browser
  const requested = action.browser
  if (!granted || !requested) return false
  if (!granted.scopeType) return false
  // Apply write-covers-read to mirror the device-side check in
  // builtins/browser.ts; a navigate (write) grant should satisfy a
  // read_text (read) request on the same scope.
  //
  // v3.1: the shared matcher fail-closes when requested.operations is
  // populated but granted.operations is missing/empty — see
  // shared/access/policies/matchers.ts.
  return sharedBrowserPolicyAllows(
    {
      action: granted.action,
      scopeType: granted.scopeType,
      origin: granted.origin,
      host: granted.host,
      registrableDomain: granted.registrableDomain,
      operations: granted.operations,
    },
    {
      needed: requested.action,
      origin: requested.origin,
      host: requested.host,
      registrableDomain: requested.registrableDomain,
      neededOperations: requested.operations,
    }
  )
}

/**
 * True when the browser requested-action's effective scope was resolved by
 * the runtime (current page / page_id / all pages) rather than supplied as a
 * literal URL arg. For these the server has no origin to match, so the
 * grant match defers the URL check to the device via prefilterBrowserGrants.
 */
function isRuntimeResolvedBrowserTarget(
  action: RuntimeAuthorizationRequestedAction
): boolean {
  const src = action.browser?.scopeSource
  return (
    src === "runtime_active_page" ||
    src === "runtime_page_id" ||
    src === "runtime_all_pages"
  )
}

/**
 * v3.1 server-side prefilter for browser tools whose effective target is
 * NOT an argument_url (current_page / page_id / all_pages). In those cases
 * the server can't know the actual URL, so we filter candidate grants by
 * (capability + action + operation) only and ship every matching grant to
 * the device via envelope.grant_specs. The runtime then runs the full
 * shared matcher (action + operation + URL) with the discovered URL.
 *
 * Action coverage explicitly preserves write-covers-read so a `page.input`
 * grant also satisfies a read-only `take_snapshot` request on the same
 * page.
 *
 * Operation coverage fails closed: missing/empty `granted.operations`
 * never satisfies a request that names operations.
 */
export function prefilterBrowserGrants(
  grant: SharedRuntimeAuthorizationGrantSpec,
  action: RuntimeAuthorizationRequestedAction
): boolean {
  const granted = grant.browser
  const requested = action.browser
  if (grant.capability !== "browser" || !granted || !requested) return false
  if (requested.scopeSource === "unknown_tool") return false
  // action coverage (write covers read)
  if (requested.action === "write" && granted.action !== "write") return false
  // operation coverage (fail-closed)
  if (requested.operations && requested.operations.length > 0) {
    if (!Array.isArray(granted.operations) || granted.operations.length === 0) {
      return false
    }
    const grantedOps = new Set(granted.operations)
    for (const op of requested.operations) {
      if (!grantedOps.has(op)) return false
    }
  }
  // URL check is intentionally skipped — runtime does it after resolving
  // the active/page_id URL.
  return true
}

export function commandlinePolicyMatches(
  grant: SharedRuntimeAuthorizationGrantSpec,
  action: RuntimeAuthorizationRequestedAction,
  opts: { platform?: "win32" | "linux" | "darwin" } = {}
) {
  const granted = grant.commandline
  const requested = action.commandline
  if (!granted || !requested) return false

  // Sandbox grant: covers ANY requested command (bash / powershell / exec_file)
  // whose cwd resolves within the sandbox mount points. Isolation is the
  // boundary, so we do NOT require granted.executor === requested.executor; we
  // hand the sandbox policy + the requested command's cwd to the shared matcher,
  // which ignores command text and only checks the mount-point containment.
  if (granted.executor === "sandbox") {
    const requestedDir =
      requested.executor === "exec_file"
        ? requested.workingDirectory
        : requested.workingDirectory
    return Boolean(
      sharedCommandlinePolicyAllows(
        {
          executor: "sandbox",
          workingDirectory: granted.workingDirectory,
          allowedEnv: granted.allowedEnv,
        },
        requested.executor === "exec_file"
          ? {
              kind: "exec_file",
              program: requested.program,
              argv: requested.argvPrefix ?? [],
              workingDirectory: requestedDir,
              platform: opts.platform,
            }
          : {
              kind: "shell",
              executor: requested.executor,
              command: requested.commandText ?? "",
              workingDirectory: requestedDir,
              platform: opts.platform,
            }
      )
    )
  }

  if (granted.executor !== requested.executor) return false

  // exec_file branch: program + argv comparison via the canonical shared
  // matcher. Server and device read the same fields. Also threads
  // requiresBundled so an old non-bundled grant doesn't mask a dispatch
  // where the API just decided this call needs bundled fallback
  // (Windows / missing-toolchain story).
  if (granted.executor === "exec_file" && requested.executor === "exec_file") {
    return Boolean(
      sharedCommandlinePolicyAllows(
        {
          executor: "exec_file",
          commandMatchType: granted.commandMatchType,
          program: granted.program,
          argvPrefix: granted.argvPrefix,
          workingDirectory: granted.workingDirectory,
          allowBundledToolchain: granted.allowBundledToolchain,
          allowedEnv: granted.allowedEnv,
        },
        {
          kind: "exec_file",
          program: requested.program,
          argv: requested.argvPrefix ?? [],
          workingDirectory: requested.workingDirectory,
          platform: opts.platform,
          requiresBundled: requested.allowBundledToolchain === true,
        }
      )
    )
  }
  if (granted.executor === "exec_file" || requested.executor === "exec_file") {
    return false
  }
  const requestedText = sharedNormalizeCommandText(requested.commandText)
  if (!requestedText) return false
  return Boolean(
    sharedCommandlinePolicyAllows(
      {
        executor: granted.executor,
        commandMatchType: granted.commandMatchType,
        commandText: granted.commandText,
        workingDirectory: granted.workingDirectory,
        allowBundledToolchain: granted.allowBundledToolchain,
        allowedEnv: granted.allowedEnv,
      },
      {
        kind: "shell",
        executor: granted.executor,
        command: requestedText,
        workingDirectory: requested.workingDirectory,
        platform: opts.platform,
      }
    )
  )
}

export type MatcherResult = "match" | "no_match" | "corrupt"

/**
 * Shared capability-dispatch core for both the tri-state and the boolean
 * matcher. Given an already-hydrated grant spec (policy validation passed) and
 * a requested action of the SAME capability, returns whether the grant's
 * policy covers the action.
 *
 * Both `runtimeAuthorizationGrantMatchesTriState` and
 * `runtimeAuthorizationGrantMatches` route through here so the per-capability
 * allow logic lives in exactly ONE place — previously the two functions
 * duplicated this switch and could silently drift.
 *
 * The caller is responsible for the capability-equality guard before calling
 * (both wrappers short-circuit on `grant.capability !== action.capability`).
 */
function grantSpecCoversAction(
  grant: SharedRuntimeAuthorizationGrantSpec,
  requestedAction: RuntimeAuthorizationRequestedAction,
  opts: { platform?: "win32" | "linux" | "darwin" } = {}
): boolean {
  switch (grant.capability) {
    case "filesystem":
      return filesystemPolicyMatches(grant, requestedAction)
    case "cua":
      return Boolean(
        grant.cua &&
        requestedAction.cua &&
        sharedCuaPolicyAllows(
          { access: grant.cua.access },
          requestedAction.cua.access
        )
      )
    case "browser":
      // Runtime-resolved browser targets (current page / page_id / all pages)
      // have no origin at projection time — the device resolves the active
      // URL and does the scope check itself. For those we use
      // prefilterBrowserGrants (action + operation coverage, URL deferred);
      // for "args"-sourced targets we do the full origin/host/domain check.
      return isRuntimeResolvedBrowserTarget(requestedAction)
        ? prefilterBrowserGrants(grant, requestedAction)
        : browserPolicyMatches(grant, requestedAction)
    case "commandline":
      return commandlinePolicyMatches(grant, requestedAction, opts)
    default:
      return false
  }
}

/**
 * Three-state matcher: distinguishes "policy structurally valid but doesn't
 * cover this action" (no_match → skip candidate, try next) from "policy data
 * is corrupt" (corrupt → DENY immediately, do NOT fall back to wider grants).
 * Eliminates a class of silent fallback bugs where a narrower grant with a
 * broken policy payload would be treated as no_match and the matcher would
 * pick a coarser grant instead.
 */
export function runtimeAuthorizationGrantMatchesTriState(
  candidate: RuntimeAuthorizationGrantCandidate,
  requestedAction: RuntimeAuthorizationRequestedAction
): MatcherResult {
  if (!candidate.policyValidationResult.ok) return "corrupt"
  const grant = candidate.policyValidationResult
    .parsed as SharedRuntimeAuthorizationGrantSpec
  if (grant.capability !== requestedAction.capability) {
    return "no_match"
  }
  return grantSpecCoversAction(grant, requestedAction) ? "match" : "no_match"
}

// Kept for backward compat with auto-retry.ts (which uses the post-mapper
// record form). Returns boolean (not tri-state) — assumes the caller already
// hydrated the record (i.e., policy validation passed).
export function runtimeAuthorizationGrantMatches(
  grant: RuntimeAuthorizationGrantRecord,
  requestedAction: RuntimeAuthorizationRequestedAction,
  opts: { platform?: "win32" | "linux" | "darwin" } = {}
): boolean {
  if (grant.capability !== requestedAction.capability) {
    return false
  }
  return grantSpecCoversAction(grant, requestedAction, opts)
}

// ============================================================================
// specificityRank — TS-side stable sort key for candidate ordering.
// Lower = higher precedence. consume_once retention is always most precise.
// actor / remote_agent / workspace_member treated as the same precision tier
// (with scoped > unscoped); conversation > workspace.
// ============================================================================

export function specificityRank(
  subjectKind: string,
  scopePresent: boolean,
  retention: RuntimeAuthorizationGrantRetention
): number {
  if (retention === "consume_once") return 0
  const subjectTier =
    subjectKind === SUBJECT_KIND.ACTOR ||
    subjectKind === SUBJECT_KIND.REMOTE_AGENT ||
    subjectKind === SUBJECT_KIND.WORKSPACE_MEMBER
      ? 1
      : subjectKind === SUBJECT_KIND.CONVERSATION
        ? 3
        : subjectKind === SUBJECT_KIND.WORKSPACE
          ? 4
          : 5
  // Within actor/remote_agent/workspace_member, scoped > unscoped.
  return subjectTier === 1 ? (scopePresent ? 1 : 2) : subjectTier
}

// ============================================================================
// toRuntimeAuthorizationGrantWireSpec — single canonical adapter from the API
// camelCase RuntimeAuthorizationGrantRecord (extends SharedRuntimeAuthorizationGrantSpec)
// to the snake_case device-protocol wire spec carried in envelope.grant_specs.
// Required: dispatch (capability-projection) + auto-retry must NOT inline the
// camelCase→snake_case mapping; both call this helper so the wire shape stays
// in one place. Adding a new capability branch happens once here.
// ============================================================================

export function toRuntimeAuthorizationGrantWireSpec(
  record: RuntimeAuthorizationGrantRecord
): import("@synapse/device-protocol").RuntimeAuthorizationGrantSpec {
  return {
    capability: record.capability,
    filesystem: record.filesystem
      ? {
          access: record.filesystem.access,
          path_prefixes: record.filesystem.pathPrefixes ?? [],
        }
      : undefined,
    cua: record.cua ? { access: record.cua.access } : undefined,
    browser: record.browser
      ? {
          action: record.browser.action,
          scope_type: record.browser.scopeType,
          origin: record.browser.origin,
          host: record.browser.host,
          registrable_domain: record.browser.registrableDomain,
        }
      : undefined,
    commandline: record.commandline
      ? serializeCommandlinePolicyToWire(record.commandline)
      : undefined,
  }
}

// ============================================================================
// selectAndClaimRuntimeAuthorizationGrant — canonical helper. Used by
// dispatch (capability-projection), auto-retry, and conformance tests. Does
// the full list → match → prepare → atomic claim flow in a single Kysely
// transaction. preparedGrant is signed BEFORE the claim; signing failures
// surface as PrepareFailure 'signing_failed' without consuming the grant.
// ============================================================================

export interface PreparedDispatch {
  /** Already-signed final envelope; not re-signed after claim. */
  envelope: import("@synapse/device-protocol").OperationEnvelope
  beginInput: BeginOperationInput
  toolId: string
  toolRevisionId: string
}

export type PrepareFailure =
  | { kind: "signing_failed"; cause: unknown }
  | { kind: "revision_drift"; expected: string; latest: string }
  | { kind: "operator_config_missing"; cause: unknown }
  | { kind: "grant_data_corrupt"; grantId: string; reason: string }

export interface SelectAndClaimParams {
  workspaceId: string
  deviceId: string
  deviceCapabilityId: string
  deviceExposureId: string
  runtimeSubjectIds: string[]
  runtimeScopeSubjectIds: string[]
  retryNonce?: string
  sourceTaskId?: string
  requestedAction: RuntimeAuthorizationRequestedAction
  /** auto-retry path passes args.approvedGrant.id; dispatch leaves unset. */
  preferredGrantId?: string
  prepareGrant: (
    record: RuntimeAuthorizationGrantRecord
  ) => Promise<
    | { ok: true; prepared: PreparedDispatch }
    | { ok: false; failure: PrepareFailure }
  >
}

export type SelectAndClaimResult =
  | {
      kind: "matched"
      grant: RuntimeAuthorizationGrantRecord
      prepared: PreparedDispatch
      operation: BeginOperationResult
    }
  | { kind: "no_match" }
  | {
      kind: "race_lost"
      reason: "retry_limit_exceeded" | "candidates_exhausted"
      retryNonce?: string
    }
  | { kind: "lock_timeout" }
  | { kind: "denied"; reason: string; grantId?: string; details?: unknown }

const MAX_CONSUME_RETRIES = 3

export async function selectAndClaimRuntimeAuthorizationGrant(
  params: SelectAndClaimParams
): Promise<SelectAndClaimResult> {
  // Step 1: list candidates (no transaction yet; we want to retry across
  // independent transactions on consume race).
  const candidates = await listCandidatesForDispatch({
    workspaceId: params.workspaceId,
    deviceId: params.deviceId,
    deviceCapabilityId: params.deviceCapabilityId,
    deviceExposureId: params.deviceExposureId,
    runtimeSubjectIds: params.runtimeSubjectIds,
    runtimeScopeSubjectIds: params.runtimeScopeSubjectIds,
    retryNonce: params.retryNonce,
    sourceTaskId: params.sourceTaskId,
  })

  // Step 2: preferredGrantId filter (auto-retry path).
  let filtered = candidates
  if (params.preferredGrantId) {
    filtered = candidates.filter((c) => c.rawRow.id === params.preferredGrantId)
    if (filtered.length === 0) {
      return { kind: "denied", reason: "preferred_grant_not_active" }
    }
  }

  // Step 3: action match (three-state) + sort by specificity.
  type MatchedCandidate = {
    candidate: RuntimeAuthorizationGrantCandidate
    record: RuntimeAuthorizationGrantRecord
  }
  const matched: MatchedCandidate[] = []
  for (const candidate of filtered) {
    const match = runtimeAuthorizationGrantMatchesTriState(
      candidate,
      params.requestedAction
    )
    if (match === "corrupt") {
      return {
        kind: "denied",
        reason: "grant_data_corrupt",
        grantId: candidate.rawRow.id,
        details: candidate.policyValidationResult.ok
          ? undefined
          : candidate.policyValidationResult.failure,
      }
    }
    if (match === "match") {
      if (!candidate.policyValidationResult.ok) continue // unreachable
      const record = mapRuntimeAuthorizationGrantCandidate(
        candidate,
        candidate.policyValidationResult.parsed
      )
      matched.push({ candidate, record })
    }
  }
  if (matched.length === 0) return { kind: "no_match" }
  matched.sort((a, b) => {
    const ra = specificityRank(
      a.candidate.subject.kind,
      a.candidate.scope !== undefined,
      a.candidate.retention
    )
    const rb = specificityRank(
      b.candidate.subject.kind,
      b.candidate.scope !== undefined,
      b.candidate.retention
    )
    if (ra !== rb) return ra - rb
    return (b.record.createdAt || "").localeCompare(a.record.createdAt || "")
  })

  // Step 4: per-candidate prepareGrant → atomic claim transaction.
  let attempt = 0
  for (const { candidate, record } of matched) {
    const prepareResult = await params.prepareGrant(record)
    if (!prepareResult.ok) {
      // All prepare failures except `candidate_unusable` (which we don't have
      // anymore — preset, by design, is "no candidate-level skip path") are
      // dispatch-fatal: short-circuit deny WITHOUT consuming the grant.
      return {
        kind: "denied",
        reason: prepareResult.failure.kind,
        grantId: record.id,
        details: prepareResult.failure,
      }
    }
    const claimOutcome = await tryClaimAndBegin({
      record,
      prepared: prepareResult.prepared,
    })
    if (claimOutcome.kind === "ok" && claimOutcome.operation) {
      return {
        kind: "matched",
        grant: record,
        prepared: prepareResult.prepared,
        operation: claimOutcome.operation,
      }
    }
    if (claimOutcome.kind === "lock_timeout") {
      return { kind: "lock_timeout" }
    }
    if (claimOutcome.kind === "denied_drift") {
      // Drift discovered AFTER prepare: ROLLBACK + deny (NOT consume).
      return {
        kind: "denied",
        reason: "revision_drift_in_tx",
        grantId: record.id,
      }
    }
    // claimOutcome.kind === 'race_lost' → bounded retry, try next candidate.
    attempt += 1
    if (attempt >= MAX_CONSUME_RETRIES) {
      return {
        kind: "race_lost",
        reason: "retry_limit_exceeded",
        retryNonce: params.retryNonce,
      }
    }
  }
  return {
    kind: "race_lost",
    reason: "candidates_exhausted",
    retryNonce: params.retryNonce,
  }
}

interface TryClaimResult {
  kind: "ok" | "race_lost" | "lock_timeout" | "denied_drift"
  operation?: BeginOperationResult
}

async function tryClaimAndBegin(input: {
  record: RuntimeAuthorizationGrantRecord
  prepared: PreparedDispatch
}): Promise<TryClaimResult> {
  try {
    const result = await db.transaction().execute(async (trx) => {
      // Short lock timeout: a lock_timeout means another connection is
      // updating device_tools (e.g., catalog sync); abort and surface as a
      // transient runtime_constraint instead of waiting indefinitely.
      await sql`SET LOCAL lock_timeout = '500ms'`.execute(trx)
      // FOR SHARE: blocks catalog UPDATE without blocking other dispatch
      // share-lockers.
      const toolRow = await trx
        .selectFrom("device_tools")
        .select(["latest_revision_id"])
        .where("id", "=", input.prepared.toolId)
        .forShare()
        .executeTakeFirst()
      if (
        !toolRow ||
        (toolRow.latest_revision_id as string | null) !==
          input.prepared.toolRevisionId
      ) {
        return { kind: "denied_drift" as const }
      }
      if (input.record.retention === "consume_once") {
        const claimed = await consumeRuntimeAuthorizationGrant(
          input.record.id,
          trx
        )
        if (!claimed) {
          return { kind: "race_lost" as const }
        }
      } else {
        // until_revoked: FOR SHARE re-check of grant status. No state mutation.
        const grantRow = await trx
          .selectFrom("runtime_authorization_grants")
          .select("id")
          .where("id", "=", input.record.id)
          .where("status", "=", "active")
          .forShare()
          .executeTakeFirst()
        if (!grantRow) {
          return { kind: "race_lost" as const }
        }
      }
      const operation = await beginDeviceOperationOn(
        trx,
        input.prepared.beginInput
      )
      return { kind: "ok" as const, operation }
    })
    return result
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes("lock_timeout") || msg.includes("55P03")) {
      return { kind: "lock_timeout" }
    }
    throw err
  }
}

// ============================================================================
// listCandidatesForDispatch — internal SELECT used by the canonical helper.
// NOT exposed as a public API — callers use selectAndClaimRuntimeAuthorizationGrant.
// ============================================================================

async function listCandidatesForDispatch(params: {
  workspaceId: string
  deviceId: string
  deviceCapabilityId: string
  deviceExposureId: string
  runtimeSubjectIds: string[]
  runtimeScopeSubjectIds: string[]
  retryNonce?: string
  sourceTaskId?: string
}): Promise<RuntimeAuthorizationGrantCandidate[]> {
  if (params.runtimeSubjectIds.length === 0) return []
  const rows = await db
    .selectFrom("runtime_authorization_grants as g")
    .innerJoin("access_subjects as subj", "subj.id", "g.subject_id")
    .leftJoin(
      "access_subjects as scope_subj",
      "scope_subj.id",
      "g.scope_subject_id"
    )
    .select(runtimeAuthorizationGrantSelectColumns() as unknown as any)
    .where("g.workspace_id", "=", params.workspaceId)
    .where("g.device_id", "=", params.deviceId)
    .where("g.device_capability_id", "=", params.deviceCapabilityId)
    .where("g.device_exposure_id", "=", params.deviceExposureId)
    .where("g.status", "=", "active")
    .where("g.subject_id", "in", params.runtimeSubjectIds)
    .where((eb) =>
      eb.or([
        eb("g.scope_subject_id", "is", null),
        ...(params.runtimeScopeSubjectIds.length > 0
          ? [eb("g.scope_subject_id", "in", params.runtimeScopeSubjectIds)]
          : []),
      ])
    )
    .where((eb) => {
      const branches: any[] = [eb("g.retention", "=", "until_revoked")]
      if (params.retryNonce) {
        branches.push(
          eb.and([
            eb("g.retention", "=", "consume_once"),
            eb("g.source_retry_nonce", "=", params.retryNonce),
          ])
        )
      }
      if (params.sourceTaskId) {
        branches.push(
          eb.and([
            eb("g.retention", "=", "consume_once"),
            eb("g.source_task_id", "=", params.sourceTaskId),
          ])
        )
      }
      return eb.or(branches)
    })
    .orderBy("g.created_at", "desc")
    .execute()
  return rows
    .map((row: any) => {
      try {
        return rowToCandidate(row)
      } catch (err) {
        // Subject row corruption (would-be impossible under tg_runtime_..._validate
        // trigger). Skip rather than abort the whole list.
        return null
      }
    })
    .filter((c): c is RuntimeAuthorizationGrantCandidate => c !== null)
}

// ============================================================================
// listDeviceCapabilityRuntimeAuthorizationGrantsForDashboard — UI list path.
// Returns a dual stream: valid records + corrupt diagnostic rows. Never
// throws on per-row corruption.
// ============================================================================

export interface CorruptGrantRow {
  rowId: string
  capability?: unknown
  validatorFailure: PolicyValidationFailure
}

export interface DashboardGrantListResult {
  valid: RuntimeAuthorizationGrantRecord[]
  corrupt: CorruptGrantRow[]
}

export async function listDeviceCapabilityRuntimeAuthorizationGrantsForDashboard(input: {
  workspaceId: string
  deviceCapabilityId: string
  includeRevoked?: boolean
}): Promise<DashboardGrantListResult> {
  let query = db
    .selectFrom("runtime_authorization_grants as g")
    .innerJoin("access_subjects as subj", "subj.id", "g.subject_id")
    .leftJoin(
      "access_subjects as scope_subj",
      "scope_subj.id",
      "g.scope_subject_id"
    )
    .select(runtimeAuthorizationGrantSelectColumns() as unknown as any)
    .where("g.workspace_id", "=", input.workspaceId)
    .where("g.device_capability_id", "=", input.deviceCapabilityId)
    .orderBy("g.created_at", "desc")
  if (!input.includeRevoked) {
    query = query.where("g.status", "=", "active")
  }
  const rows = await query.execute()
  const valid: RuntimeAuthorizationGrantRecord[] = []
  const corrupt: CorruptGrantRow[] = []
  for (const row of rows as any[]) {
    let candidate: RuntimeAuthorizationGrantCandidate
    try {
      candidate = rowToCandidate(row)
    } catch (err) {
      // Subject row corruption case (rare, gated by trigger).
      corrupt.push({
        rowId: row.id,
        capability: row.policy?.capability,
        validatorFailure: {
          kind: "parse_error",
          issues: [
            {
              code: "custom" as any,
              message: err instanceof Error ? err.message : String(err),
              path: ["subject"],
            } as ZodIssue,
          ],
        },
      })
      continue
    }
    if (!candidate.policyValidationResult.ok) {
      corrupt.push({
        rowId: row.id,
        capability: (candidate.rawPolicy as any)?.capability,
        validatorFailure: candidate.policyValidationResult.failure,
      })
      continue
    }
    valid.push(
      mapRuntimeAuthorizationGrantCandidate(
        candidate,
        candidate.policyValidationResult.parsed
      )
    )
  }
  return { valid, corrupt }
}

// subject-scope-refactor: listActiveRuntimeAuthorizationGrantsForExposure
// DROPPED. The legacy "list every active grant for this capability, then
// filter in TS" path was the root cause of two P0 security bugs (cross-actor
// grant leakage + concurrent reuse of consume_once grants). The canonical
// helper selectAndClaimRuntimeAuthorizationGrant does SQL-side filtering
// by (subject, scope) and atomic claim in a single transaction. There is
// no longer a public "list grants" API on the dispatch path — dashboards
// use listDeviceCapabilityRuntimeAuthorizationGrantsForDashboard, which
// emits {valid, corrupt} for surfacing instead.

// subject-scope-refactor: RUNTIME_AUTHORIZATION_GRANT_SCOPE shim DROPPED.
// Callers were migrated off it during the canonical-helper cutover; envelope
// grant_scope values are derived strings via subjectScopeLabel({subject,
// scope?}) and retention is a separate ("consume_once" | "until_revoked")
// field. If you find yourself needing this constant, you almost certainly
// want either (a) `subject.kind === SUBJECT_KIND.X` to branch on subject
// shape, or (b) `grant.retention === "consume_once"` to gate once-only
// behavior — never the old preset-style enum.
