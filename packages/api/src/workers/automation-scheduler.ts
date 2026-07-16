import { tracedTickWorker, withRootTrace } from "./job-tracing.js"
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
import { createLogger } from "../infrastructure/logger/index.js"

const log = createLogger("automation-scheduler")

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
  // Tick worker (15s cadence): a no-op tick exports ZERO spans; a tick that
  // scheduled executions emits one backdated summary span (see tracedTickWorker).
  const worker = tracedTickWorker(
    QUEUE_NAMES.AUTOMATION_SCHEDULER,
    async () => {
      const scheduled = await scheduleDueAutomationExecutions()
      // Escape the tick's suppressed scope for the enqueues so each scheduled
      // execution becomes its OWN trace root — one tick schedules executions
      // across unrelated workspaces, and the backdated tick summary span does
      // not exist yet, so it cannot (and must not) parent them.
      await withRootTrace(() =>
        enqueueAutomationExecutionJobs(scheduled.scheduledExecutions)
      )
      return scheduled
    },
    {
      connection: redis,
      concurrency: 1,
    },
    {
      hasWork: (r) => r.scheduledExecutions.length > 0,
      workCount: (r) => r.scheduledExecutions.length,
    }
  )

  worker.on("failed", (job, err) => {
    log.error({ err }, `Automation scheduler job ${job?.id} failed`)
  })

  registerWorker(worker)
  return worker
}
