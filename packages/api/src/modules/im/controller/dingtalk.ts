/**
 * DingTalk-specific HTTP endpoints — Device Flow registration + manual
 * AppKey/AppSecret entry, plus the generic-route interception that keeps
 * DingTalk accounts from being created/updated through the generic
 * /im/accounts plumbing (which would bypass account_key=clientId and the
 * persist helper's merge semantics).
 *
 * Mounted as a Fastify plugin from controller.ts under the same
 * auth+workspace middleware as the rest of the IM routes.
 *
 * All response shapes follow the typed contracts in @synapse/shared so
 * the frontend can use a single typed wrapper.
 */

import type { FastifyInstance } from "fastify"
import { z } from "zod"
import {
  serializeInstant,
  serializeNowInstant,
} from "../../../infrastructure/datetime.js"
import type {
  DingtalkDeviceFlowPollResponse,
  DingtalkDeviceFlowSessionSummary,
  DingtalkDeviceFlowStartResponse,
  TransportAccountSummary,
} from "@synapse/shared/types"
import { getTransportAccountById } from "../service.js"
import { persistDingtalkAccountFromRegistration } from "../connectors/dingtalk/persist.js"
import {
  createOpenclawProvider,
  resolveProviderMode,
  RegistrationBusinessError,
  RegistrationTransientError,
  type RegistrationPollResult,
  type RegistrationProvider,
} from "../connectors/dingtalk/device-registration.js"
import {
  deleteDingtalkRegistrationSession,
  getDingtalkRegistrationSession,
  setDingtalkRegistrationSession,
  withDeviceCodeRedacted,
  type DingtalkRegistrationSession,
  type RegistrationSessionStatus,
} from "../connectors/dingtalk/registration-session-store.js"
import {
  requireWorkspaceAction,
  transportAccountInboundActorCreateShape,
  transportAccountOwnerCreateShape,
  validateTransportAccountInboundActorCreate,
  validateTransportAccountOwnerCreate,
} from "./_shared.js"

// Number of consecutive provider transient failures we tolerate before
// flipping the session to `fail`. Five matches the plan; the 1-4 fall
// through as HTTP 502, the 5th returns HTTP 200 with status: fail so
// the UI can switch to manual entry without waiting an extra `intervalSeconds`.
const TRANSIENT_FAILURE_LIMIT = 5

// ───────────────────────── schemas ─────────────────────────

const accountOwnerInboundShape = {
  ...transportAccountOwnerCreateShape,
  ...transportAccountInboundActorCreateShape,
}

const deviceFlowStartSchema = z
  .object({
    displayName: z.string().trim().min(1).max(255),
    ...accountOwnerInboundShape,
  })
  .superRefine(validateTransportAccountOwnerCreate)
  .superRefine(validateTransportAccountInboundActorCreate)

const manualAccountSchema = z
  .object({
    clientId: z.string().trim().min(8).max(255),
    clientSecret: z.string().trim().min(8).max(255),
    displayName: z.string().trim().min(1).max(255),
    ...accountOwnerInboundShape,
  })
  .superRefine(validateTransportAccountOwnerCreate)
  .superRefine(validateTransportAccountInboundActorCreate)

// ───────────────────────── helpers ─────────────────────────

function nowMs(): number {
  return Date.now()
}

function nowIso(): string {
  return serializeNowInstant()
}

async function buildSummary(
  session: DingtalkRegistrationSession,
  getAccountById: (
    id: string
  ) => Promise<TransportAccountSummary | null> = getTransportAccountById
): Promise<DingtalkDeviceFlowSessionSummary> {
  let transportAccount: TransportAccountSummary | undefined
  if (session.transportAccountId) {
    const account = await getAccountById(session.transportAccountId)
    transportAccount = account ?? undefined
  }
  return {
    sessionId: session.sessionId,
    workspaceId: session.workspaceId,
    status: session.status,
    message: session.message,
    verificationUriComplete: session.verificationUriComplete,
    verificationUri: session.verificationUri,
    userCode: session.userCode,
    expiresInSeconds: session.expiresInSeconds,
    intervalSeconds: session.intervalSeconds,
    createdAt: serializeInstant(new Date(session.createdAt)),
    updatedAt: serializeInstant(new Date(session.updatedAt)),
    expiresAt: serializeInstant(new Date(session.expiresAt)),
    transportAccount,
  }
}

function getActiveProvider(): RegistrationProvider | null {
  const mode = resolveProviderMode()
  if (mode === "disabled") return null
  return createOpenclawProvider()
}

/**
 * Wraps store.set so that terminal-status sessions (success/fail/expired)
 * land in Redis with their `deviceCode` cleared. The Redis key itself
 * still lives until its TTL so polls can read the terminal summary, but
 * the auth secret isn't kept around any longer than necessary.
 */
async function persistSession(
  store: SessionStore,
  session: DingtalkRegistrationSession
): Promise<void> {
  if (session.status === "waiting") {
    await store.set(session)
    return
  }
  await store.set(withDeviceCodeRedacted(session))
}

// ───────────────────────── start route handler ─────────────────────────

interface StartRouteDeps {
  provider: RegistrationProvider | null
  /** Allows tests to skip session-id randomness. */
  nowMs?: () => number
  /** Allows tests to inject a deterministic sessionId. */
  generateSessionId?: () => string
  /** Allows tests to bypass the DB. */
  getAccountById?: (id: string) => Promise<TransportAccountSummary | null>
  /** Allows tests to inject an in-memory session store. */
  sessionStore?: SessionStore
}

interface SessionStore {
  get(
    workspaceId: string,
    sessionId: string
  ): Promise<DingtalkRegistrationSession | null>
  set(session: DingtalkRegistrationSession): Promise<void>
}

const defaultSessionStore: SessionStore = {
  get: getDingtalkRegistrationSession,
  set: setDingtalkRegistrationSession,
}

async function handleStartDeviceFlow(
  workspaceId: string,
  input: z.infer<typeof deviceFlowStartSchema>,
  deps: StartRouteDeps
): Promise<DingtalkDeviceFlowStartResponse> {
  const provider = deps.provider
  if (!provider) {
    return {
      providerStartFailed: true,
      error:
        "DingTalk Device Flow is disabled (DINGTALK_REGISTRATION_PROVIDER=disabled); use the manual route",
    }
  }
  let nonce: string
  let begin: Awaited<ReturnType<RegistrationProvider["begin"]>>
  try {
    const initResult = await provider.init()
    nonce = initResult.nonce
    begin = await provider.begin({ nonce })
  } catch (err: unknown) {
    if (
      err instanceof RegistrationBusinessError ||
      err instanceof RegistrationTransientError
    ) {
      return {
        providerStartFailed: true,
        error: err.message,
      }
    }
    throw err
  }
  const sessionId = deps.generateSessionId
    ? deps.generateSessionId()
    : crypto.randomUUID()
  const now = (deps.nowMs ?? nowMs)()
  const session: DingtalkRegistrationSession = {
    sessionId,
    workspaceId,
    deviceCode: begin.deviceCode,
    userCode: begin.userCode,
    verificationUri: begin.verificationUri,
    verificationUriComplete: begin.verificationUriComplete,
    expiresInSeconds: begin.expiresInSeconds,
    intervalSeconds: begin.intervalSeconds,
    expiresAt: now + begin.expiresInSeconds * 1000,
    createdAt: now,
    updatedAt: now,
    status: "waiting",
    providerFailureCount: 0,
    message: "Scan the QR code with the DingTalk mobile app to continue.",
    // pendingForm carries the caller's display/owner/inboundActor choices
    // until the success branch persists the account. Never surfaces in the
    // public summary (buildSummary picks only public fields).
    pendingForm: {
      displayName: input.displayName,
      ownerScope: input.ownerScope,
      ownerWorkspaceMemberId: input.ownerWorkspaceMemberId ?? null,
      inboundActorMode: input.inboundActorMode ?? "none",
      inboundActorId: input.inboundActorId ?? null,
    },
  }
  const store = deps.sessionStore ?? defaultSessionStore
  await persistSession(store, session)
  const summary = await buildSummary(session, deps.getAccountById)
  return { providerStartFailed: false, session: summary }
}

// ───────────────────────── poll route handler ─────────────────────────

interface PollRouteDeps {
  provider: RegistrationProvider | null
  nowMs?: () => number
  /** Allows tests to inject a fake account lookup + persist. */
  getAccountById?: (id: string) => Promise<TransportAccountSummary | null>
  persistAccount?: typeof persistDingtalkAccountFromRegistration
  /** Allows tests to inject an in-memory session store. */
  sessionStore?: SessionStore
}

interface PollOutcome {
  status: number
  body: DingtalkDeviceFlowPollResponse | { error: string }
}

async function handlePollDeviceFlow(
  workspaceId: string,
  sessionId: string,
  deps: PollRouteDeps
): Promise<PollOutcome> {
  const store = deps.sessionStore ?? defaultSessionStore
  const existing = await store.get(workspaceId, sessionId)
  if (!existing) {
    return {
      status: 404,
      body: { error: "DingTalk registration session not found" },
    }
  }
  const now = (deps.nowMs ?? nowMs)()
  const persist = deps.persistAccount ?? persistDingtalkAccountFromRegistration
  const getAccount = deps.getAccountById

  // Terminal-state short-circuit — return summary without re-polling provider
  // or re-running persist. Defends against polling/refresh after success.
  if (existing.status !== "waiting") {
    // Special case: status="waiting" in store but past expiry → flip to
    // expired in the grace window before Redis evicts the key.
    return {
      status: 200,
      body: { session: await buildSummary(existing, getAccount) },
    }
  }
  if (existing.expiresAt <= now) {
    const expired: DingtalkRegistrationSession = {
      ...existing,
      status: "expired",
      message: "Device code expired; please restart the registration flow.",
      updatedAt: now,
    }
    await persistSession(store, expired)
    return {
      status: 200,
      body: { session: await buildSummary(expired, getAccount) },
    }
  }

  const provider = deps.provider
  if (!provider) {
    // Provider was disabled mid-session — degrade to fail so the UI can
    // re-route to manual.
    const failed: DingtalkRegistrationSession = {
      ...existing,
      status: "fail",
      message:
        "DingTalk Device Flow is currently disabled; use the manual route",
      updatedAt: now,
    }
    await persistSession(store, failed)
    return {
      status: 200,
      body: { session: await buildSummary(failed, getAccount) },
    }
  }

  let pollResult: RegistrationPollResult
  try {
    pollResult = await provider.poll({ deviceCode: existing.deviceCode })
  } catch (err: unknown) {
    if (err instanceof RegistrationBusinessError) {
      const failed: DingtalkRegistrationSession = {
        ...existing,
        status: "fail",
        message: err.message,
        updatedAt: now,
        providerFailureCount: 0,
      }
      await persistSession(store, failed)
      return {
        status: 200,
        body: { session: await buildSummary(failed, getAccount) },
      }
    }
    if (err instanceof RegistrationTransientError) {
      const nextCount = (existing.providerFailureCount ?? 0) + 1
      if (nextCount >= TRANSIENT_FAILURE_LIMIT) {
        const failed: DingtalkRegistrationSession = {
          ...existing,
          status: "fail",
          message: "provider unreachable",
          updatedAt: now,
          providerFailureCount: 0,
          lastProviderError: err.message,
          lastProviderErrorAt: nowIso(),
        }
        await persistSession(store, failed)
        return {
          status: 200,
          body: { session: await buildSummary(failed, getAccount) },
        }
      }
      const stillWaiting: DingtalkRegistrationSession = {
        ...existing,
        updatedAt: now,
        providerFailureCount: nextCount,
        lastProviderError: err.message,
        lastProviderErrorAt: nowIso(),
      }
      await persistSession(store, stillWaiting)
      return { status: 502, body: { error: err.message } }
    }
    throw err
  }

  // Reset transient counter on any successful poll
  const baseUpdate: Partial<DingtalkRegistrationSession> = {
    providerFailureCount: 0,
  }

  switch (pollResult.status) {
    case "waiting": {
      const next: DingtalkRegistrationSession = {
        ...existing,
        ...baseUpdate,
        updatedAt: now,
      }
      await persistSession(store, next)
      return {
        status: 200,
        body: { session: await buildSummary(next, getAccount) },
      }
    }
    case "fail":
    case "expired": {
      const next: DingtalkRegistrationSession = {
        ...existing,
        ...baseUpdate,
        status: pollResult.status,
        message: pollResult.message,
        updatedAt: now,
      }
      await persistSession(store, next)
      return {
        status: 200,
        body: { session: await buildSummary(next, getAccount) },
      }
    }
    case "success": {
      if (!pollResult.clientId || !pollResult.clientSecret) {
        const failed: DingtalkRegistrationSession = {
          ...existing,
          ...baseUpdate,
          status: "fail",
          message: "provider reported success but did not include credentials",
          updatedAt: now,
        }
        await persistSession(store, failed)
        return {
          status: 200,
          body: { session: await buildSummary(failed, getAccount) },
        }
      }
      const pending = existing.pendingForm
      const account = await persist({
        workspaceId,
        clientId: pollResult.clientId,
        clientSecret: pollResult.clientSecret,
        displayName: pending?.displayName ?? "DingTalk Bot",
        ownerScope: pending?.ownerScope ?? "workspace",
        ownerWorkspaceMemberId: pending?.ownerWorkspaceMemberId ?? null,
        inboundActorMode: pending?.inboundActorMode ?? "none",
        inboundActorId: pending?.inboundActorId ?? null,
        metadataPatch: {
          dingtalkRegistrationSource: "device_flow",
          dingtalkRegistrationCompletedAt: nowIso(),
        },
      })
      const next: DingtalkRegistrationSession = {
        ...existing,
        ...baseUpdate,
        status: "success",
        message: "DingTalk account connected.",
        transportAccountId: account.id,
        updatedAt: now,
      }
      await persistSession(store, next)
      return {
        status: 200,
        body: { session: await buildSummary(next, getAccount) },
      }
    }
    default: {
      const failed: DingtalkRegistrationSession = {
        ...existing,
        ...baseUpdate,
        status: "fail",
        message:
          "registration provider returned unrecognized status; please retry or fall back to manual",
        updatedAt: now,
      }
      await persistSession(store, failed)
      return {
        status: 200,
        body: { session: await buildSummary(failed, getAccount) },
      }
    }
  }
}

// ───────────────────────── generic-route interception ─────────────────────────

/**
 * Hook installed on the parent app via `onRequest`. Rejects POST/PUT to
 * the generic /im/accounts routes when the operation would touch a
 * DingTalk account (by transport_kind in the body for POST, or by the
 * existing row's transport_kind for PUT). Returns 400 with a pointer to
 * the dedicated DingTalk endpoints so callers can't bypass the persist
 * helper's clientId-as-account_key + config/metadata merge semantics.
 *
 * PUT is only blocked when the body would change credentials/config/
 * metadata/connectionMode — non-conflicting updates like displayName,
 * ownerScope, or inboundActor* are allowed through the generic route.
 */
const DINGTALK_GENERIC_GUARD_KEY = "dingtalkGenericGuardInstalled"

function installGenericRouteGuard(app: FastifyInstance): void {
  if (app.hasDecorator(DINGTALK_GENERIC_GUARD_KEY)) return
  app.decorate(DINGTALK_GENERIC_GUARD_KEY, true)

  // Match the generic IM account create + update routes (anything under
  // /im/accounts that isn't a transport-specific sub-path).
  const POST_RE = /^\/api\/v1\/workspaces\/[^/]+\/im\/accounts\/?$/
  const PUT_RE = /^\/api\/v1\/workspaces\/[^/]+\/im\/accounts\/[^/]+\/?$/

  app.addHook("preHandler", async (request, reply) => {
    const url = request.url.split("?")[0]
    if (request.method === "POST" && POST_RE.test(url)) {
      const body = (request.body ?? {}) as Record<string, unknown>
      if (body.transportKind === "dingtalk") {
        await reply.status(400).send({
          error:
            "Use POST /im/accounts/dingtalk/manual or /im/accounts/dingtalk/device-registration/start for DingTalk accounts",
        })
        return reply
      }
      return
    }
    if (request.method === "PUT" && PUT_RE.test(url)) {
      // Cheap body-shape check first — if the caller isn't touching any
      // conflicting field, skip the DB round-trip entirely.
      const body = (request.body ?? {}) as Record<string, unknown>
      const hasConflict =
        "credentials" in body ||
        "config" in body ||
        "metadata" in body ||
        "connectionMode" in body
      if (!hasConflict) return
      const params = request.params as {
        accountId?: string
        workspaceId?: string
      }
      if (!params.accountId || !params.workspaceId) return
      const existing = await getTransportAccountById(params.accountId)
      if (!existing || existing.transportKind !== "dingtalk") return
      await reply.status(400).send({
        error:
          "Use POST /im/accounts/dingtalk/manual for DingTalk credential/config/metadata changes",
      })
      return reply
    }
  })
}

// ───────────────────────── plugin entry ─────────────────────────

export default async function imDingtalkController(
  app: FastifyInstance
): Promise<void> {
  installGenericRouteGuard(app)

  app.post<{
    Params: { workspaceId: string }
    Body: unknown
  }>(
    "/api/v1/workspaces/:workspaceId/im/accounts/dingtalk/device-registration/start",
    async (request, reply) => {
      const allowed = await requireWorkspaceAction(
        request,
        reply,
        "workspace.manage",
        "Not allowed to manage IM accounts in this workspace"
      )
      if (!allowed) return
      const body = deviceFlowStartSchema.parse(request.body)
      const provider = getActiveProvider()
      const result = await handleStartDeviceFlow(
        request.params.workspaceId,
        body,
        { provider }
      )
      return reply.status(200).send(result)
    }
  )

  app.get<{
    Params: { workspaceId: string; sessionId: string }
  }>(
    "/api/v1/workspaces/:workspaceId/im/accounts/dingtalk/device-registration/:sessionId",
    async (request, reply) => {
      // workspace.manage (not view) — the SUCCESS branch of poll calls
      // persistDingtalkAccountFromRegistration, which writes credentials
      // and refreshes the runtime. Read-only access would be a privilege
      // escalation: a `view`-only caller would be able to provision a
      // bound IM account by polling someone else's session. Matches the
      // Weixin QR poll's `workspace.manage` requirement.
      const allowed = await requireWorkspaceAction(
        request,
        reply,
        "workspace.manage",
        "Not allowed to manage IM accounts in this workspace"
      )
      if (!allowed) return
      const provider = getActiveProvider()
      const outcome = await handlePollDeviceFlow(
        request.params.workspaceId,
        request.params.sessionId,
        { provider }
      )
      return reply.status(outcome.status).send(outcome.body)
    }
  )

  app.delete<{
    Params: { workspaceId: string; sessionId: string }
  }>(
    "/api/v1/workspaces/:workspaceId/im/accounts/dingtalk/device-registration/:sessionId",
    async (request, reply) => {
      const allowed = await requireWorkspaceAction(
        request,
        reply,
        "workspace.manage",
        "Not allowed to manage IM accounts in this workspace"
      )
      if (!allowed) return
      await deleteDingtalkRegistrationSession(
        request.params.workspaceId,
        request.params.sessionId
      )
      return reply.status(204).send()
    }
  )

  app.post<{
    Params: { workspaceId: string }
    Body: unknown
  }>(
    "/api/v1/workspaces/:workspaceId/im/accounts/dingtalk/manual",
    async (request, reply) => {
      const allowed = await requireWorkspaceAction(
        request,
        reply,
        "workspace.manage",
        "Not allowed to manage IM accounts in this workspace"
      )
      if (!allowed) return
      const body = manualAccountSchema.parse(request.body)
      const account = await persistDingtalkAccountFromRegistration({
        workspaceId: request.params.workspaceId,
        clientId: body.clientId,
        clientSecret: body.clientSecret,
        displayName: body.displayName,
        ownerScope: body.ownerScope,
        ownerWorkspaceMemberId: body.ownerWorkspaceMemberId ?? null,
        inboundActorMode: body.inboundActorMode ?? "none",
        inboundActorId: body.inboundActorId ?? null,
        metadataPatch: {
          dingtalkRegistrationSource: "manual",
          dingtalkRegistrationCompletedAt: nowIso(),
        },
      })
      return reply.status(201).send({ account })
    }
  )
}

// Exposed for unit tests — the route handlers are pure given their
// dependencies, so we test the handlers directly instead of spinning up
// a Fastify instance.
export const __test = {
  handleStartDeviceFlow,
  handlePollDeviceFlow,
  TRANSIENT_FAILURE_LIMIT,
}

// Used by the test for status type-check that doesn't pull provider state.
export type { RegistrationSessionStatus }
