import { Worker } from "bullmq"
import { QUEUE_NAMES } from "@synapse/shared"
import { redis } from "../infrastructure/redis/index.js"
import {
  scheduleDueAutomationExecutions,
  getAutomationSchedulerIntervalMs,
} from "../modules/automation/service.js"
import {
  automationSchedulerQueue,
  enqueueAutomationExecutionJobs,
} from "./queues.js"
import { registerWorker } from "./registry.js"

export async function ensureAutomationSchedulerJob() {
  await automationSchedulerQueue.add(
    "tick",
    {},
    {
      repeat: { every: getAutomationSchedulerIntervalMs() },
      jobId: "automation-scheduler-tick",
    }
  )
}

export function startAutomationSchedulerWorker() {
  const worker = new Worker(
    QUEUE_NAMES.AUTOMATION_SCHEDULER,
    async () => {
      const scheduled = await scheduleDueAutomationExecutions()
      await enqueueAutomationExecutionJobs(scheduled.scheduledExecutions)
      return scheduled
    },
    {
      connection: redis,
      concurrency: 1,
    }
  )

  worker.on("failed", (job, err) => {
    console.error(`Automation scheduler job ${job?.id} failed:`, err.message)
  })

  registerWorker(worker)
  return worker
}
