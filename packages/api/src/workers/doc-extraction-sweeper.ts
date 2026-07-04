// Document-extraction async reconciliation sweeper.
//
// Async (submit-and-release) document runs advance via a self-perpetuating poll
// job. If that chain dies — a poll tick's DB write exhausts its BullMQ attempts,
// the delayed poll job is lost across a restart / redis flush, or the process
// crashes before the first poll is enqueued — the run would otherwise sit at
// status='running' forever. This sweep makes the DURABLE vendor token (persisted to
// file_parse_runs.metadata) the real recovery anchor: it periodically re-drives
// overdue chains and fails runs past their deadline.
//
// Idempotent: reconcileStrandedAsyncParses re-enqueues polls that
// processFileParsePoll then no-ops if the run already completed, and the terminal
// writes are status-conditional. Harmless (and a near-empty query) when no async
// provider is configured — no run ever carries a jobToken.

import { reconcileStrandedAsyncParses } from "../modules/files/parse-service.js"
import { createLogger } from "../infrastructure/logger/index.js"

const log = createLogger("documents.reconciler")

const TICK_INTERVAL_MS = 30_000

interface WorkerHandle {
  stop(): Promise<void>
}

let active: WorkerHandle | null = null

export function startDocExtractionSweeper(): WorkerHandle {
  if (active) return active
  let stopped = false
  let timer: ReturnType<typeof setInterval> | null = null

  const tick = async () => {
    if (stopped) return
    try {
      const acted = await reconcileStrandedAsyncParses()
      if (acted > 0) {
        log.info({ acted }, "reconciled stranded async document runs")
      }
    } catch (err) {
      log.warn({ err }, "doc-extraction reconcile tick failed")
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

export async function stopDocExtractionSweeper(): Promise<void> {
  if (!active) return
  await active.stop()
  active = null
}
