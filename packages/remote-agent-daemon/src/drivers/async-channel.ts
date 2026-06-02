import { execSync } from "node:child_process"

/**
 * Single-producer / single-consumer async channel: push() values, consume them
 * via the async iterator, close() to end the iteration.
 *
 * Both the Claude and Codex drivers had a byte-for-byte copy of this. It is a
 * textbook async-iterable channel; extracted here (one daemon-internal module,
 * no new dependency) rather than pulled from npm — the only defect was the
 * duplication.
 *
 * On close(), the iterator finishes (the consumer's for-await ends). Pending
 * waiters receive `null`, which the iterator treats as end-of-stream.
 */
export class EventQueue<T> {
  private readonly queued: T[] = []
  private readonly waiters: Array<(value: T | null) => void> = []
  private closed = false

  push(value: T) {
    if (this.closed) return
    const waiter = this.waiters.shift()
    if (waiter) {
      waiter(value)
      return
    }
    this.queued.push(value)
  }

  close() {
    if (this.closed) return
    this.closed = true
    for (const waiter of this.waiters) waiter(null)
    this.waiters.length = 0
  }

  async *iterator(): AsyncGenerator<T> {
    while (true) {
      const queued = this.queued.shift()
      if (queued !== undefined) {
        yield queued
        continue
      }
      if (this.closed) return
      const next = await new Promise<T | null>((resolve) => {
        this.waiters.push(resolve)
      })
      if (next === null) return
      yield next
    }
  }
}

/**
 * Cross-platform "find an executable on PATH". Resolves via `which`/`where`.
 * Returns the first match, or undefined if not found.
 *
 * NOTE: `binary` is interpolated into a shell command, so callers MUST pass a
 * trusted literal (today only "claude"/"codex"). Do not pass user input here.
 */
export function whichBinary(binary: string): string | undefined {
  try {
    const command = process.platform === "win32" ? "where" : "which"
    const output = execSync(`${command} ${binary}`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean)
  } catch {
    return undefined
  }
}
