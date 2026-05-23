import type { TransportAccountSummary } from "@synapse/shared/types"
import { emitEvent } from "../../infrastructure/events/index.js"
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
import {
  getTransportAccountByKindAndId,
  listActiveTransportAccounts,
} from "./service.js"

const RUNTIME_RECONCILE_INTERVAL_MS = 15_000
let reconcileTimer: NodeJS.Timeout | null = null
let reconcilePromise: Promise<void> | null = null

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
          await ingestInboundEnvelope({ account, envelope })
        },
        logger: {
          debug: () => {},
          info: (msg, fields) =>
            console.log(`[im:${account.transportKind}] ${msg}`, fields || ""),
          warn: (msg, fields) =>
            console.warn(`[im:${account.transportKind}] ${msg}`, fields || ""),
          error: (msg, err, fields) =>
            console.error(
              `[im:${account.transportKind}] ${msg}`,
              err,
              fields || ""
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
    console.warn(
      `[im] no TransportConnector for transport_kind=${account.transportKind}`
    )
  }

  const promise = run()
    .catch((error) => {
      if (!abortController.signal.aborted) {
        console.error(
          `[im] Transport runtime crashed for account ${account.id}:`,
          error
        )
      }
    })
    .finally(() => {
      const current = runtimeHandles.get(account.id)
      if (current?.fingerprint === fingerprint) {
        runtimeHandles.delete(account.id)
      }
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
        console.error(
          `[im] Failed to stop runtime for account ${accountId}:`,
          error
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
      console.error("[im] Transport runtime reconcile failed:", error)
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

export async function handleFeishuWebhookRequest(params: {
  accountId: string
  headers: Record<string, unknown>
  body: unknown
}) {
  // Legacy route. Delegates to the new connector.handleWebhook path so the
  // logic lives in exactly one place. Public-controller.ts also has a
  // generic /api/v1/im/webhooks/:transportKind/:accountId entry — new
  // deployments should point Feishu at that one.
  const account = await getTransportAccountByKindAndId({
    accountId: params.accountId,
    transportKind: "feishu",
  })
  if (!account || account.status !== "active") {
    return {
      statusCode: 404,
      body: { error: "Transport account not found" },
    }
  }
  if (account.connectionMode !== "webhook") {
    return {
      statusCode: 409,
      body: { error: "Transport account is not configured for webhook mode" },
    }
  }
  const connector = tryGetConnector("feishu")
  if (!connector || !connector.handleWebhook) {
    return {
      statusCode: 503,
      body: { error: "feishu connector not registered" },
    }
  }
  return connector.handleWebhook({
    account,
    headers: params.headers,
    body: params.body,
    emitInbound: async (envelope) => {
      await ingestInboundEnvelope({ account, envelope })
    },
  })
}
