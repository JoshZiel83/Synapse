// SidecarSupervisor — manages the synapse-device-cua-helper subprocess.
// Supervisor abstraction lets tests inject a fake child via the spawn
// override. v3.0 implementation: start/stop + line-delimited JSON-RPC.

import { spawn, type ChildProcess } from "node:child_process"
import { EventEmitter } from "node:events"
import { createInterface } from "node:readline"
import { parseSidecarResponseFrame } from "./sidecar-codec.js"
import { createDeviceLogger } from "./logger.js"
import { getTraceparent } from "./trace-context.js"

const sidecarLog = createDeviceLogger("sidecar")

export interface SidecarOptions {
  /** Absolute path to the synapse-device-cua-helper binary. */
  binaryPath: string
  args?: string[]
  env?: NodeJS.ProcessEnv
  /** Spawn override (tests). */
  spawnImpl?: typeof spawn
}

export interface SidecarHandle extends EventEmitter {
  request(method: string, params?: unknown): Promise<unknown>
  notify(method: string, params?: unknown): void
  stop(): Promise<void>
  on(event: "exit", listener: (code: number | null) => void): this
}

interface PendingRequest {
  resolve(v: unknown): void
  reject(e: Error): void
}

export function startSidecar(opts: SidecarOptions): SidecarHandle {
  const spawnImpl = opts.spawnImpl ?? spawn
  const child: ChildProcess = spawnImpl(opts.binaryPath, opts.args ?? [], {
    env: opts.env ?? process.env,
    stdio: ["pipe", "pipe", "pipe"],
  })
  const emitter = new EventEmitter() as SidecarHandle
  const pending = new Map<string, PendingRequest>()
  let nextId = 1
  let exited = false

  if (child.stdout) {
    const rl = createInterface({ input: child.stdout })
    rl.on("line", (line) => {
      if (!line.trim()) return
      const frame = parseSidecarResponseFrame(line)
      if (!frame) return
      const p = pending.get(frame.id)
      if (!p) return
      pending.delete(frame.id)
      if (frame.error) {
        // Surface the full JSON-RPC error so callers can inspect the
        // structured `data` payload (e.g. cua sidecar's diagnostic block
        // with backend / fallback / cua_error / synapse_code). Without
        // this the cua builtin would only see the integer code + message
        // string, which loses every diagnostic the device helper
        // attaches.
        const err = new Error(
          `${frame.error.code}: ${frame.error.message}`
        ) as Error & { jsonRpcCode?: number; jsonRpcData?: unknown }
        err.jsonRpcCode = frame.error.code
        err.jsonRpcData = frame.error.data
        p.reject(err)
      } else {
        p.resolve(frame.result)
      }
    })
  }

  // Drain the child's stderr. REQUIRED: stderr is piped, and an undrained pipe
  // deadlocks the child via OS pipe backpressure the moment it writes anything
  // (the cua/fs-helper helpers log diagnostics there). Each line is forwarded
  // into the device-runtime log stream. Also expose the stream on the handle so
  // callers (e.g. fs-helper-client's helper_log_tail) can observe it too.
  if (child.stderr) {
    const errRl = createInterface({ input: child.stderr })
    errRl.on("line", (line) => {
      if (!line.trim()) return
      sidecarLog.error("sidecar stderr", { line, binary: opts.binaryPath })
    })
  }
  ;(emitter as unknown as { stderr?: NodeJS.ReadableStream }).stderr =
    child.stderr ?? undefined

  child.on("exit", (code) => {
    exited = true
    // Fail every in-flight request so callers don't hang forever when the
    // sidecar dies mid-call (e.g. helper crash, host shutdown).
    for (const [, p] of pending) {
      p.reject(new Error(`sidecar exited (code=${code ?? "null"})`))
    }
    pending.clear()
    emitter.emit("exit", code)
  })

  emitter.request = (method, params) =>
    new Promise<unknown>((resolve, reject) => {
      if (exited) {
        reject(new Error("sidecar already exited"))
        return
      }
      const id = String(nextId++)
      pending.set(id, { resolve, reject })
      // Stamp the active dispatch traceparent (P7) so the sidecar can continue
      // the same trace for this RPC.
      const traceparent = getTraceparent()
      const frame = traceparent
        ? { jsonrpc: "2.0", id, method, params, traceparent }
        : { jsonrpc: "2.0", id, method, params }
      child.stdin?.write(`${JSON.stringify(frame)}\n`)
    })
  emitter.notify = (method, params) => {
    if (exited) return
    const traceparent = getTraceparent()
    const frame = traceparent
      ? { jsonrpc: "2.0", method, params, traceparent }
      : { jsonrpc: "2.0", method, params }
    child.stdin?.write(`${JSON.stringify(frame)}\n`)
  }
  emitter.stop = async () => {
    try {
      child.stdin?.end()
    } catch {
      /* ignore */
    }
    if (exited) return
    try {
      child.kill("SIGTERM")
    } catch {
      /* ignore */
    }
    // Wait for the child to actually exit so the caller can be sure no more
    // tool calls are in flight.
    if (child.exitCode === null) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          try {
            child.kill("SIGKILL")
          } catch {
            /* ignore */
          }
          resolve()
        }, 2_000)
        child.once("exit", () => {
          clearTimeout(t)
          resolve()
        })
      })
    }
  }
  return emitter
}
