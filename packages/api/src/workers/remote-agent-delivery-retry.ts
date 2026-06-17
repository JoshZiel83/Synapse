import { tracedWorker } from "./job-tracing.js"
import { QUEUE_NAMES } from "@synapse/shared"
import { redis } from "../infrastructure/redis/index.js"
import { runDueRemoteAgentDeliveryRetries } from "../modules/remote-agents/service.js"
import { remoteAgentDeliveryRetryQueue } from "./queues.js"
import { registerWorker } from "./registry.js"
import { createLogger } from "../infrastructure/logger/index.js"

const log = createLogger("remote-agent-delivery-retry")

const REMOTE_AGENT_DELIVERY_RETRY_TICK_MS = 10_000

export async function ensureRemoteAgentDeliveryRetryJob() {
  await remoteAgentDeliveryRetryQueue.add(
    "tick",
    {},
    {
      repeat: { every: REMOTE_AGENT_DELIVERY_RETRY_TICK_MS },
      jobId: "remote-agent-delivery-retry-tick",
    }
  )
}

export function startRemoteAgentDeliveryRetryWorker() {
  const worker = tracedWorker(
    QUEUE_NAMES.REMOTE_AGENT_DELIVERY_RETRY,
    async () => {
      return runDueRemoteAgentDeliveryRetries()
    },
    {
      connection: redis,
      concurrency: 1,
    }
  )

  worker.on("failed", (job, err) => {
    log.error({ err }, `Remote agent delivery retry job ${job?.id} failed`)
  })

  registerWorker(worker)
  return worker
}
