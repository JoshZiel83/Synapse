import { Queue } from "bullmq"
import { redis } from "../infrastructure/redis/index.js"
import { QUEUE_NAMES } from "@synapse/shared"
import { injectTraceContext } from "./job-tracing.js"

// Queues are constructed lazily. BullMQ's Queue constructor immediately
// touches the connection (uses it to set up listeners) which, with the
// lazy redis proxy, materializes the underlying ioredis instance and
// opens a TCP connection. Constructing Queues at module load would mean
// every module that transitively imports queues.js pays for a Redis
// connection — including unit tests that don't need it. Materializing on
// first use keeps eager-mode behavior at runtime (the API enqueues a
// job before anything else useful happens) while letting test-only code
// paths skip the connection entirely.
type LazyQueue = {
  get: () => Queue
  isMaterialized: () => boolean
}

function lazyQueue(
  name: string,
  defaultJobOptions?: Queue["defaultJobOptions"]
): LazyQueue {
  let queue: Queue | null = null
  return {
    get: () => {
      if (!queue) {
        queue = new Queue(name, { connection: redis, defaultJobOptions })
      }
      return queue
    },
    isMaterialized: () => queue !== null,
  }
}

/**
 * Retry policy for session-thinking jobs. These jobs are the ONLY driver for a
 * session's pending wakeups (user messages, follow-ups). Without attempts a
 * transient Redis/BullMQ failure on the worker — or on a lock-contended
 * re-enqueue — would drop the only future driver and strand the wakeups until
 * an external recovery sweep. With attempts, a failed run is retried with
 * backoff. The handler is idempotent w.r.t. re-runs: it re-claims the session
 * lock and re-reads pending wakeups, so a retry simply re-drives whatever is
 * still pending. Applied as the queue's defaultJobOptions so every enqueue
 * (initial, lock-contended retry, finally requeue) inherits it.
 */
export const SESSION_THINKING_JOB_DEFAULTS = {
  attempts: 5,
  backoff: { type: "exponential" as const, delay: 2_000 },
  removeOnComplete: { age: 3_600, count: 1_000 },
  removeOnFail: { age: 86_400, count: 1_000 },
} as const

/**
 * Retry policy for file-parse jobs. Without it BullMQ runs each parse exactly
 * once, so a transient OCR sidecar outage would permanently fail the image with
 * no recovery. The handler (processFileParseRun) rethrows ONLY transient
 * (retryable) failures — terminal failures (no text found, corrupt input) are
 * recorded and swallowed — so these attempts are burned only on genuinely
 * transient errors, not on deterministic ones.
 */
export const FILE_PARSING_JOB_DEFAULTS = {
  attempts: 3,
  backoff: { type: "exponential" as const, delay: 5_000 },
  removeOnComplete: { age: 3_600, count: 1_000 },
  removeOnFail: { age: 86_400, count: 1_000 },
} as const

const sessionThinkingLazy = lazyQueue(
  QUEUE_NAMES.SESSION_THINKING,
  SESSION_THINKING_JOB_DEFAULTS
)
const automationSchedulerLazy = lazyQueue(QUEUE_NAMES.AUTOMATION_SCHEDULER)
const automationExecutionLazy = lazyQueue(QUEUE_NAMES.AUTOMATION_EXECUTION)
const imTransportDeliveryLazy = lazyQueue(QUEUE_NAMES.IM_TRANSPORT_DELIVERY)
const memoryIndexingLazy = lazyQueue(QUEUE_NAMES.MEMORY_INDEXING)
const fileParsingLazy = lazyQueue(
  QUEUE_NAMES.FILE_PARSING,
  FILE_PARSING_JOB_DEFAULTS
)
const remoteAgentDeliveryRetryLazy = lazyQueue(
  QUEUE_NAMES.REMOTE_AGENT_DELIVERY_RETRY
)

function lazyQueueProxy(handle: LazyQueue): Queue {
  return new Proxy({} as Queue, {
    get(_target, prop) {
      const queue = handle.get()
      // Inject the active trace context into job data on EVERY enqueue so the
      // worker can continue the trace across the Redis boundary (see
      // job-tracing.ts). Centralizing here covers all `.add` callers.
      if (prop === "add") {
        return (name: string, data: unknown, opts?: unknown) => {
          // Do NOT inject a one-shot trace context into a repeatable/cron job
          // template — BullMQ clones the template for every tick, so each future
          // run would "continue" one long-dead trace.
          const isRepeatable =
            !!opts && typeof opts === "object" && "repeat" in opts
          return (
            queue.add as unknown as (
              n: string,
              d: unknown,
              o?: unknown
            ) => unknown
          )(name, isRepeatable ? data : injectTraceContext(data), opts)
        }
      }
      const value = (queue as unknown as Record<PropertyKey, unknown>)[
        prop as string
      ]
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(queue)
        : value
    },
  }) as Queue
}

export const sessionThinkingQueue = lazyQueueProxy(sessionThinkingLazy)
export const automationSchedulerQueue = lazyQueueProxy(automationSchedulerLazy)
export const automationExecutionQueue = lazyQueueProxy(automationExecutionLazy)
export const imTransportDeliveryQueue = lazyQueueProxy(imTransportDeliveryLazy)
export const memoryIndexingQueue = lazyQueueProxy(memoryIndexingLazy)
export const fileParsingQueue = lazyQueueProxy(fileParsingLazy)
export const remoteAgentDeliveryRetryQueue = lazyQueueProxy(
  remoteAgentDeliveryRetryLazy
)

export async function enqueueAutomationExecutionJobs(executionIds: string[]) {
  const uniqueExecutionIds = Array.from(
    new Set(
      executionIds.map((executionId) => executionId.trim()).filter(Boolean)
    )
  )
  await Promise.all(
    uniqueExecutionIds.map((executionId) =>
      automationExecutionQueue.add(
        "execute",
        { executionId },
        { jobId: `automation-execution-${executionId}` }
      )
    )
  )
}

/**
 * BullMQ retry policy for IM transport delivery jobs. Without
 * explicit attempts/backoff, BullMQ runs the job exactly once —
 * meaning a transient network blip, expired access token, or 5xx
 * from the platform turns into a permanent send failure. The
 * outbound worker only sees `attemptNumber = 0` on every invocation
 * and the `RetryableTransportError` machinery is dead.
 *
 * Defaults: 5 total attempts, exponential backoff capped by BullMQ's
 * 30s default. Connectors that need different behavior should still
 * throw `PermanentTransportError` to short-circuit, or
 * `RetryableTransportError` to participate.
 */
export const IM_TRANSPORT_DELIVERY_JOB_DEFAULTS = {
  attempts: 5,
  backoff: {
    type: "exponential" as const,
    delay: 5_000,
  },
  removeOnComplete: { age: 3_600, count: 1_000 },
  removeOnFail: { age: 86_400, count: 1_000 },
} as const

/**
 * Single source of truth for the BullMQ jobId of an IM transport
 * delivery attempt. Both the initial enqueue
 * (`enqueueTransportDeliveryJobs`) and the outbox sweeper's
 * `getJob(...)` dedup lookup MUST use this exact function — if they
 * drift apart the sweeper would fail to recognize the original job
 * and produce a duplicate enqueue, breaking BullMQ's jobId-based
 * dedup contract.
 *
 * The format `im-transport-delivery-<linkId>` is part of the
 * persisted Redis key; do not change it without a coordinated
 * migration plan for in-flight links.
 */
export function canonicalTransportDeliveryJobId(linkId: string): string {
  return `im-transport-delivery-${linkId}`
}

export async function enqueueTransportDeliveryJobs(linkIds: string[]) {
  const uniqueLinkIds = Array.from(
    new Set(linkIds.map((linkId) => linkId.trim()).filter(Boolean))
  )
  await Promise.all(
    uniqueLinkIds.map((linkId) =>
      imTransportDeliveryQueue.add(
        "deliver",
        { linkId },
        {
          jobId: canonicalTransportDeliveryJobId(linkId),
          ...IM_TRANSPORT_DELIVERY_JOB_DEFAULTS,
        }
      )
    )
  )
}

const lazyHandles = [
  sessionThinkingLazy,
  automationSchedulerLazy,
  automationExecutionLazy,
  imTransportDeliveryLazy,
  memoryIndexingLazy,
  fileParsingLazy,
  remoteAgentDeliveryRetryLazy,
]

export async function shutdownQueues() {
  await Promise.allSettled(
    lazyHandles
      .filter((handle) => handle.isMaterialized())
      .map((handle) => handle.get().close())
  )
}
