import { tracedWorker } from "./job-tracing.js"
import { QUEUE_NAMES } from "@synapse/shared"
import { redis } from "../infrastructure/redis/index.js"
import { createLogger } from "../infrastructure/logger/index.js"
import { processAutomationExecution } from "../modules/automation/service.js"
import { registerWorker } from "./registry.js"

const log = createLogger("automation-execution")

export function startAutomationExecutionWorker() {
  const worker = tracedWorker(
    QUEUE_NAMES.AUTOMATION_EXECUTION,
    async (job) => {
      const { executionId } = job.data as { executionId?: string }
      if (!executionId) {
        return { success: false, reason: "missing executionId" }
      }
      return processAutomationExecution(executionId)
    },
    {
      connection: redis,
      concurrency: 5,
    }
  )

  worker.on("failed", (job, err) => {
    log.error({ err }, `Automation execution job ${job?.id} failed`)
  })

  registerWorker(worker)
  return worker
}
