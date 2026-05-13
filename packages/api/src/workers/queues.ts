import { Queue } from "bullmq"
import { redis } from "../infrastructure/redis/index.js"
import { QUEUE_NAMES } from "@synapse/shared"

const connection = redis

export const sessionThinkingQueue = new Queue(QUEUE_NAMES.SESSION_THINKING, {
  connection,
})
export const automationSchedulerQueue = new Queue(
  QUEUE_NAMES.AUTOMATION_SCHEDULER,
  { connection }
)
export const automationExecutionQueue = new Queue(
  QUEUE_NAMES.AUTOMATION_EXECUTION,
  { connection }
)
export const imTransportDeliveryQueue = new Queue(
  QUEUE_NAMES.IM_TRANSPORT_DELIVERY,
  { connection }
)
export const memoryIndexingQueue = new Queue(QUEUE_NAMES.MEMORY_INDEXING, {
  connection,
})
export const fileParsingQueue = new Queue(QUEUE_NAMES.FILE_PARSING, {
  connection,
})

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

export async function enqueueTransportDeliveryJobs(linkIds: string[]) {
  const uniqueLinkIds = Array.from(
    new Set(linkIds.map((linkId) => linkId.trim()).filter(Boolean))
  )
  await Promise.all(
    uniqueLinkIds.map((linkId) =>
      imTransportDeliveryQueue.add(
        "deliver",
        { linkId },
        { jobId: `im-transport-delivery-${linkId}` }
      )
    )
  )
}

const queues = [
  sessionThinkingQueue,
  automationSchedulerQueue,
  automationExecutionQueue,
  imTransportDeliveryQueue,
  memoryIndexingQueue,
  fileParsingQueue,
]

export async function shutdownQueues() {
  await Promise.allSettled(queues.map((queue) => queue.close()))
}
