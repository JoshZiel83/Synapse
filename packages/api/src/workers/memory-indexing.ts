import { tracedWorker } from "./job-tracing.js"
import { QUEUE_NAMES } from "@synapse/shared"
import { config } from "../config/index.js"
import { redis } from "../infrastructure/redis/index.js"
import { registerWorker } from "./registry.js"
import { reindexMemoryItemEmbeddings } from "../modules/memory/indexing.js"
import { createLogger } from "../infrastructure/logger/index.js"

const log = createLogger("memory-indexing")

export function startMemoryIndexingWorker() {
  const worker = tracedWorker(
    QUEUE_NAMES.MEMORY_INDEXING,
    async (job) => {
      const memoryItemId =
        typeof job.data?.memoryItemId === "string" ? job.data.memoryItemId : ""
      const indexVersion =
        typeof job.data?.indexVersion === "number"
          ? job.data.indexVersion
          : undefined
      if (!memoryItemId) {
        return
      }

      const result = await reindexMemoryItemEmbeddings(
        memoryItemId,
        indexVersion
      )
      if (result.status === "failed") {
        throw new Error(result.error)
      }
    },
    {
      connection: redis,
      concurrency: Math.max(1, config.memory.indexQueueConcurrency),
    }
  )

  worker.on("failed", (job, err) => {
    log.error({ err }, `Memory indexing job ${job?.id} failed`)
  })

  registerWorker(worker)
}
