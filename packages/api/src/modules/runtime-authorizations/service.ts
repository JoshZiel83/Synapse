import {
  normalizePathPrefix as sharedNormalizePathPrefix,
  pathWithinPrefix as sharedPathWithinPrefix,
  normalizeCommandText as sharedNormalizeCommandText,
  hasCompoundShellOperators as sharedHasCompoundShellOperators,
  commandPrefixMatches as sharedCommandPrefixMatches,
  filesystemPolicyAllows as sharedFilesystemPolicyAllows,
  commandlinePolicyAllows as sharedCommandlinePolicyAllows,
  cuaPolicyAllows as sharedCuaPolicyAllows,
  ptyPolicyAllows as sharedPtyPolicyAllows,
  browserPolicyAllows as sharedBrowserPolicyAllows,
  SUBJECT_KIND,
  workspaceRef,
  conversationRef,
  type SubjectRef,
} from "@synapse/shared"
import { serializeCommandlinePolicyToWire } from "@synapse/shared/access/policies"
import type {
  RuntimeAuthorizationGrantRetention,
  RuntimeAuthorizationRequestedAction,
  RuntimeAuthorizationPreset,
  SharedRuntimeAuthorizationGrantSpec,
} from "@synapse/shared/types"
import {
  GrantPolicySchema,
  type PolicyValidationFailure,
} from "@synapse/shared/access/policies"
import type { Executor } from "../../infrastructure/database/kysely.js"
import {
  consumeRuntimeAuthorizationGrantRow,
  getRuntimeAuthorizationGrantRow,
  InvalidGrantSubjectRowError,
  insertRuntimeAuthorizationGrantRow,
  selectExposureAvailableCliEntryPoints,
  listCandidateRowsForDispatch,
  listDashboardGrantRows,
  lockActiveGrantForShare,
  lockRuntimeToolLatestRevisionForShare,
  runtimeAuthorizationGrantPolicyCapability,
  runtimeAuthorizationGrantRowToCandidate as rowToCandidate,
  runtimeAuthorizationGrantSubjectFailure,
  runRuntimeAuthorizationGrantTransaction,
  setLocalLockTimeout,
} from "./repo.js"
import {
  BrowserGrantPolicyError,
  normalizeBrowserGrantPolicy,
  normalizeProgramName,
} from "@synapse/shared/access/policies"
import { upsertAccessSubject } from "../access/subject-registry.js"
import {
  beginRuntimeOperationOn,
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
// subject-scope-refactor: RuntimeAuthorizationGrantRecord is the API-side
// camelCase projection of a grant row. Its definition lives in repo.types.ts
// (the module's row/projection type owner) so the presenter that builds it
// depends on the repo layer, not on service. Re-exported here so the module
// barrel (index.ts `export * from "./service.js"`) keeps exposing it to
// existing importers (auto-retry, capability-projection, tasks).
// ============================================================================

/**
 * Candidate row + candidate row-with-joins types live in repo.types.ts (the
 * DB-row layer that may reference Kysely TableRow). Re-exported here so the
 * module barrel (index.ts `export * from "./service.js"`) keeps exposing
 * RuntimeAuthorizationGrantCandidate to existing importers.
 */
export type {
  RuntimeAuthorizationGrantRecord,
  RuntimeAuthorizationGrantCandidate,
} from "./repo.types.js"
import type {
  RuntimeAuthorizationGrantRecord,
  RuntimeAuthorizationGrantCandidate,
  RuntimeAuthorizationGrantPolicyInsert,
  RuntimeAuthorizationGrantSourceRequestArgsInsert,
} from "./repo.types.js"
import { mapRuntimeAuthorizationGrantCandidate } from "./presenter.js"

// mapRuntimeAuthorizationGrantCandidate moved to presenter.ts (it calls
// serializeInstant — banned in service by guard r3). Re-exported here so the
// module barrel keeps exposing it to existing importers.
export { mapRuntimeAuthorizationGrantCandidate }

export { InvalidGrantSubjectRowError }

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
// Mapping: candidate → record. Candidate hydration and grant-policy business
// JSON validation live in repo.ts; mapRuntimeAuthorizationGrantCandidate lives
// in presenter.ts (it shapes the DTO + serializes instants).
// ============================================================================

// ============================================================================
// CRUD: create, get, revoke, supersede
// ============================================================================

export interface CreateRuntimeAuthorizationGrantParams {
  workspaceId: string
  runtimeId: string
  runtimeCapabilityId: string
  runtimeExposureId: string
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

/**
 * A `program_only` commandline grant was requested for a program that is NOT in
 * the device exposure's reported availableClis (plan §5.C). The bundle-safe
 * matcher cannot see the catalog, so this server-side mint gate is the real
 * control that prevents an over-broad any-argv grant for an unvetted program.
 */
export class ProgramOnlyGrantNotAllowedError extends Error {
  constructor(
    readonly program: string,
    readonly runtimeExposureId: string
  ) {
    super(
      `program_only grant rejected: '${program}' is not in device exposure ${runtimeExposureId} availableClis`
    )
    this.name = "ProgramOnlyGrantNotAllowedError"
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
  // partial state if an unrelated failure rolls back). The transaction-open
  // lives in repo.ts (the designated db-client layer); the service threads the
  // in-flight trx into both the cross-module upsert and the repo row fns.
  return runRuntimeAuthorizationGrantTransaction((trx) =>
    createGrantInKyselyTx(trx, params, grantSpec)
  )
}

async function createGrantInKyselyTx(
  trx: Executor,
  params: CreateRuntimeAuthorizationGrantParams,
  grantSpec: SharedRuntimeAuthorizationGrantSpec
): Promise<RuntimeAuthorizationGrantRecord> {
  // program_only allow-list gate (plan §5.C). The shared matcher is bundle-safe
  // and cannot read the catalog, so a program_only grant is allowed ONLY for a
  // program in the device exposure's reported availableClis. program == entry_point;
  // availableClis is keyed by entry_point. Runs before any side effect. Placed
  // here so BOTH the transactional and manual-grants.controller callers hit it.
  const commandline = grantSpec.commandline
  if (
    commandline?.executor === "exec_file" &&
    commandline.commandMatchType === "program_only"
  ) {
    const allowed = await selectExposureAvailableCliEntryPoints(
      params.runtimeExposureId,
      trx
    )
    const normalizedAllowed = new Set(
      Array.from(allowed, (p) => normalizeProgramName(p))
    )
    if (!normalizedAllowed.has(normalizeProgramName(commandline.program))) {
      throw new ProgramOnlyGrantNotAllowedError(
        commandline.program,
        params.runtimeExposureId
      )
    }
  }
  const subjectId = await upsertAccessSubject(trx, params.subject)
  const scopeSubjectId = params.scope
    ? await upsertAccessSubject(trx, params.scope)
    : null
  const inserted = await insertRuntimeAuthorizationGrantRow(trx, {
    workspaceId: params.workspaceId,
    runtimeId: params.runtimeId,
    runtimeCapabilityId: params.runtimeCapabilityId,
    runtimeExposureId: params.runtimeExposureId,
    subjectId: subjectId,
    scopeSubjectId: scopeSubjectId,
    createdByWorkspaceMemberId: params.createdByWorkspaceMemberId || null,
    sourceTaskId: params.sourceTaskId || null,
    retention: params.retention,
    policy: grantSpec as unknown as RuntimeAuthorizationGrantPolicyInsert,
    sourceRetryNonce: params.sourceRetryNonce || null,
    sourceRuntimeSessionId: params.sourceRuntimeSessionId || null,
    sourceRequestArgs: (params.sourceRequestArgs ||
      {}) as RuntimeAuthorizationGrantSourceRequestArgsInsert,
  })
  if (!inserted) {
    throw new Error("Failed to create runtime authorization grant")
  }
  const row = await getRuntimeAuthorizationGrantRow(inserted.id, trx)
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

// (getRuntimeAuthorizationGrant / revoke / supersede / consumeRuntimeAuthorizationGrant
// service wrappers removed — dead: zero callers repo-wide; the live paths call the
// *Row repo functions directly, e.g. consumeRuntimeAuthorizationGrantRow at dispatch.)

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
    case "pty":
      // pty (P4a S8): cwd/isolation-ONLY match — the pty policy carries no
      // command/argv/byte matcher, so a `pty.open` action is covered iff its cwd
      // resolves within the sandbox mount points (and the grant's optional
      // narrower workingDirectory cap). `pty.write`/resize/signal/stream/close
      // reference the open session id and are NEVER re-matched. The
      // capability-equality guard above already prevents a commandline/sandbox
      // grant from reaching this case, so pty bytes can never be gated by (and
      // thus widen) a command-text grant — the fail-open class this closes.
      return Boolean(
        grant.pty &&
        requestedAction.pty &&
        sharedPtyPolicyAllows(
          { workingDirectory: grant.pty.workingDirectory },
          {
            cwd: requestedAction.pty.workingDirectory,
            platform: opts.platform,
          }
        )
      )
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
  const subjectTier = subjectTierOf(subjectKind)
  // Within actor/remote_agent/workspace_member, scoped > unscoped.
  if (subjectTier === 1) {
    return scopePresent ? 1 : 2
  }
  return subjectTier
}

function subjectTierOf(subjectKind: string): number {
  switch (subjectKind) {
    case SUBJECT_KIND.ACTOR:
    case SUBJECT_KIND.REMOTE_AGENT:
    case SUBJECT_KIND.WORKSPACE_MEMBER:
      return 1
    case SUBJECT_KIND.CONVERSATION:
      return 3
    case SUBJECT_KIND.WORKSPACE:
      return 4
    default:
      return 5
  }
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
): import("@synapse/device-protocol").RuntimeAuthorizationGrantWireSpec {
  // pty is a bare-plane-only, TEST-ONLY capability in P4a (F-D): there is no
  // production pty exposure, no device-runtime pty builtin, and the device
  // wire-envelope grant schema (RuntimeAuthorizationGrantSpecSchema) has no pty
  // branch — a pty grant is never dispatched over the wire. Guard here so a pty
  // record can never be silently serialized into an envelope, and so the
  // capability union narrows to the 4 wire-valid kinds below.
  if (record.capability === "pty") {
    throw new Error(
      "pty grants are not wire-serializable in P4a (bare-plane test-only capability)"
    )
  }
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
  runtimeId: string
  runtimeCapabilityId: string
  runtimeExposureId: string
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
    runtimeId: params.runtimeId,
    runtimeCapabilityId: params.runtimeCapabilityId,
    runtimeExposureId: params.runtimeExposureId,
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
    const result =
      await runRuntimeAuthorizationGrantTransaction<TryClaimResult>(
        async (trx) => {
          // Short lock timeout: a lock_timeout means another connection is
          // updating runtime_tools (e.g., catalog sync); abort and surface as a
          // transient runtime_constraint instead of waiting indefinitely.
          await setLocalLockTimeout(trx)
          // FOR SHARE: blocks catalog UPDATE without blocking other dispatch
          // share-lockers.
          const toolRow = await lockRuntimeToolLatestRevisionForShare(
            trx,
            input.prepared.toolId
          )
          if (
            !toolRow ||
            toolRow.latestRevisionId !== input.prepared.toolRevisionId
          ) {
            return { kind: "denied_drift" as const }
          }
          if (input.record.retention === "consume_once") {
            const claimed = await consumeRuntimeAuthorizationGrantRow(
              input.record.id,
              trx
            )
            if (!claimed) {
              return { kind: "race_lost" as const }
            }
          } else {
            // until_revoked: FOR SHARE re-check of grant status. No state mutation.
            const stillActive = await lockActiveGrantForShare(
              trx,
              input.record.id
            )
            if (!stillActive) {
              return { kind: "race_lost" as const }
            }
          }
          const operation = await beginRuntimeOperationOn(
            trx,
            input.prepared.beginInput
          )
          return { kind: "ok" as const, operation }
        }
      )
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
  runtimeId: string
  runtimeCapabilityId: string
  runtimeExposureId: string
  runtimeSubjectIds: string[]
  runtimeScopeSubjectIds: string[]
  retryNonce?: string
  sourceTaskId?: string
}): Promise<RuntimeAuthorizationGrantCandidate[]> {
  if (params.runtimeSubjectIds.length === 0) return []
  const rows = await listCandidateRowsForDispatch({
    workspaceId: params.workspaceId,
    runtimeId: params.runtimeId,
    runtimeCapabilityId: params.runtimeCapabilityId,
    runtimeExposureId: params.runtimeExposureId,
    runtimeSubjectIds: params.runtimeSubjectIds,
    runtimeScopeSubjectIds: params.runtimeScopeSubjectIds,
    retryNonce: params.retryNonce,
    sourceTaskId: params.sourceTaskId,
  })
  return rows
    .map((row) => {
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
// listRuntimeAuthorizationGrantsForDashboard — UI list path.
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

export async function listRuntimeAuthorizationGrantsForDashboard(input: {
  workspaceId: string
  runtimeCapabilityId: string
  includeRevoked?: boolean
}): Promise<DashboardGrantListResult> {
  const rows = await listDashboardGrantRows({
    workspaceId: input.workspaceId,
    runtimeCapabilityId: input.runtimeCapabilityId,
    includeRevoked: input.includeRevoked,
  })
  const valid: RuntimeAuthorizationGrantRecord[] = []
  const corrupt: CorruptGrantRow[] = []
  for (const row of rows) {
    let candidate: RuntimeAuthorizationGrantCandidate
    try {
      candidate = rowToCandidate(row)
    } catch (err) {
      // Subject row corruption case (rare, gated by trigger).
      corrupt.push({
        rowId: row.id,
        capability: runtimeAuthorizationGrantPolicyCapability(row.policy),
        validatorFailure: runtimeAuthorizationGrantSubjectFailure(err),
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
// use listRuntimeAuthorizationGrantsForDashboard, which
// emits {valid, corrupt} for surfacing instead.

// subject-scope-refactor: RUNTIME_AUTHORIZATION_GRANT_SCOPE shim DROPPED.
// Callers were migrated off it during the canonical-helper cutover; envelope
// grant_scope values are derived strings via subjectScopeLabel({subject,
// scope?}) and retention is a separate ("consume_once" | "until_revoked")
// field. If you find yourself needing this constant, you almost certainly
// want either (a) `subject.kind === SUBJECT_KIND.X` to branch on subject
// shape, or (b) `grant.retention === "consume_once"` to gate once-only
// behavior — never the old preset-style enum.
