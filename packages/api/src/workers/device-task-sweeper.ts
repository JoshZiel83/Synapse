// Device-task TTL sweeper (task unification, design §3.6).
//
// device_tool tasks carry an `expires_at` deadline. If a device never sends a
// terminal `device.task.result` (crash, network partition that outlives the
// control-plane socket-close handler, etc.), the task would otherwise sit
// non-terminal forever and the waiting agent would hang. This worker
// periodically fails expired-but-still-pending device_tool tasks, which fires
// the normal terminal delivery (notice + session wakeup) so the agent resumes.
//
// The sweep is idempotent: completeToolCallTask's terminal guard makes a task
// that completed between the SELECT and the UPDATE a no-op.

import { sweepExpiredDeviceTasks } from "../modules/devices/control-plane-events.js"
import { createLogger } from "../infrastructure/logger/index.js"

const log = createLogger("device-task-sweeper")

const TICK_INTERVAL_MS = 30_000

interface WorkerHandle {
  stop(): Promise<void>
}

let active: WorkerHandle | null = null

export function startDeviceTaskSweeper(): WorkerHandle {
  if (active) return active
  let stopped = false
  let timer: ReturnType<typeof setInterval> | null = null

  const tick = async () => {
    if (stopped) return
    try {
      const swept = await sweepExpiredDeviceTasks()
      if (swept > 0) {
        log.info({ swept }, "failed expired device_tool tasks")
      }
    } catch (err) {
      log.warn({ err }, "device-task sweep tick failed")
    }
  }

  timer = setInterval(() => void tick(), TICK_INTERVAL_MS)
  timer.unref?.()
  void tick()

  const handle: WorkerHandle = {
    async stop() {
      stopped = true
      if (timer) {
        clearInterval(timer)
        timer = null
      }
    },
  }
  active = handle
  return handle
}

export async function stopDeviceTaskSweeper(): Promise<void> {
  if (!active) return
  await active.stop()
  active = null
}
