import type { TransportAccountSummary } from "@synapse/shared/types"
import { emitEvent } from "../../infrastructure/events/index.js"
import { createLogger } from "../../infrastructure/logger/index.js"
import { redis } from "../../infrastructure/redis/index.js"
import { tryGetConnector } from "./connectors/registry.js"
import {
  accountFingerprint,
  runtimeHandles,
  type RuntimeHandle,
} from "./runtime/handle.js"
import {
  acquireTransportRuntimeLease,
  releaseTransportRuntimeLease,
  renewTransportRuntimeLease,
} from "./runtime/lease.js"
import { ingestInboundEnvelope } from "./service/ingest.js"
import { listActiveTransportAccounts } from "./service.js"
import { withImInboundSpan } from "./tracing.js"

const RUNTIME_RECONCILE_INTERVAL_MS = 15_000
let reconcileTimer: NodeJS.Timeout | null = null
let reconcilePromise: Promise<void> | null = null

const log = createLogger("im.runtime")

function waitForAbort(signal: AbortSignal) {
  if (signal.aborted) {
    return Promise.resolve()
  }
  return new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true })
  })
}

async function startRuntimeForAccount(
  account: TransportAccountSummary,
  leaseToken: string
) {
  const abortController = new AbortController()
  const fingerprint = accountFingerprint(account)

  const run = async () => {
    const connector = tryGetConnector(account.transportKind)
    if (connector) {
      const running = await connector.startAccount({
        account,
        signal: abortController.signal,
        emitInbound: async (envelope) => {
          // Fresh-root `process ${transportKind}` CONSUMER span — the single
          // socket-mode ingest seam (plan §4.I change 6). This is what
          // populates session_wakeups.origin_traceparent for IM turns.
          await withImInboundSpan(account, () =>
            ingestInboundEnvelope({ account, envelope })
          )
        },
        logger: {
          debug: () => {},
          info: (msg, fields) =>
            log.info(fields ?? {}, `[im:${account.transportKind}] ${msg}`),
          warn: (msg, fields) =>
            log.warn(fields ?? {}, `[im:${account.transportKind}] ${msg}`),
          error: (msg, err, fields) =>
            log.error(
              { err, ...(fields ?? {}) },
              `[im:${account.transportKind}] ${msg}`
            ),
        },
      })
      try {
        await waitForAbort(abortController.signal)
      } finally {
        await running.stop().catch(() => undefined)
      }
      return
    }

    // No connector registered — log and exit. Reached only if a new
    // TRANSPORT_KIND lands in the enum without a corresponding connector.
    log.warn(
      `[im] no TransportConnector for transport_kind=${account.transportKind}`
    )
  }

  const promise = run()
    .catch((error) => {
      if (!abortController.signal.aborted) {
        log.error(
          { err: error },
          `[im] Transport runtime crashed for account ${account.id}`
        )
      }
    })
    .finally(async () => {
      const current = runtimeHandles.get(account.id)
      if (current?.fingerprint === fingerprint) {
        runtimeHandles.delete(account.id)
      }
      // Release the lease whenever `run()` exits — covers both the
      // normal stop() path (handle.stop already releases too, but
      // the call is token-guarded so a double-release is a no-op)
      // AND the startup-failure path where startAccount throws
      // (auth timeout, subscribe failure, etc). Without this, a
      // failed startup would leave the lease held until its 30s TTL
      // elapses, blocking the next reconcile from re-trying after
      // the operator fixes the bad credential / config.
      await releaseTransportRuntimeLease(account.id, leaseToken).catch(
        () => undefined
      )
    })

  runtimeHandles.set(account.id, {
    accountId: account.id,
    fingerprint,
    leaseToken,
    stop: async () => {
      abortController.abort()
      await promise
      await releaseTransportRuntimeLease(account.id, leaseToken).catch(
        () => undefined
      )
    },
  })
}

async function reconcileTransportRuntimesOnce() {
  const desiredAccounts = await listActiveTransportAccounts({
    connectionMode: "long_connection",
  })
  const desiredById = new Map(
    desiredAccounts.map((account) => [account.id, account])
  )

  for (const [accountId, handle] of runtimeHandles.entries()) {
    const desired = desiredById.get(accountId)
    const shouldStop =
      !desired ||
      handle.fingerprint !== accountFingerprint(desired) ||
      !(await renewTransportRuntimeLease(accountId, handle.leaseToken))
    if (shouldStop) {
      await handle.stop().catch((error) => {
        log.error(
          { err: error },
          `[im] Failed to stop runtime for account ${accountId}`
        )
      })
    }
  }

  for (const account of desiredAccounts) {
    if (runtimeHandles.has(account.id)) continue
    const leaseToken = await acquireTransportRuntimeLease(account.id)
    if (!leaseToken) continue
    await startRuntimeForAccount(account, leaseToken)
  }
}

async function reconcileTransportRuntimes() {
  if (reconcilePromise) {
    await reconcilePromise
    return
  }

  reconcilePromise = reconcileTransportRuntimesOnce().finally(() => {
    reconcilePromise = null
  })
  await reconcilePromise
}

export async function refreshTransportRuntimeManager() {
  await reconcileTransportRuntimes()
}

export async function startTransportRuntimeManager() {
  await reconcileTransportRuntimes()
  if (reconcileTimer) return
  reconcileTimer = setInterval(() => {
    void reconcileTransportRuntimes().catch((error) => {
      log.error({ err: error }, "[im] Transport runtime reconcile failed")
    })
  }, RUNTIME_RECONCILE_INTERVAL_MS)
  reconcileTimer.unref()
}

export async function stopTransportRuntimeManager() {
  if (reconcileTimer) {
    clearInterval(reconcileTimer)
    reconcileTimer = null
  }
  const handles = Array.from(runtimeHandles.values())
  runtimeHandles.clear()
  await Promise.allSettled(handles.map((handle) => handle.stop()))
}
