// SidecarSupervisor — manages the synapse-device-cua-helper subprocess.
// Supervisor abstraction lets tests inject a fake child via the spawn
// override. v3.0 implementation: start/stop + line-delimited JSON-RPC.

import { spawn, type ChildProcess } from "node:child_process"
import { EventEmitter } from "node:events"
import { createInterface } from "node:readline"

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

interface SidecarResponseFrame {
  id: string
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

function parseSidecarResponseFrame(line: string): SidecarResponseFrame | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null
  }
  const frame = parsed as {
    id?: unknown
    result?: unknown
    error?: unknown
  }
  if (typeof frame.id !== "string" && typeof frame.id !== "number") {
    return null
  }
  if (frame.error !== undefined) {
    if (!frame.error || typeof frame.error !== "object") {
      return null
    }
    const error = frame.error as {
      code?: unknown
      message?: unknown
      data?: unknown
    }
    if (typeof error.code !== "number" || typeof error.message !== "string") {
      return null
    }
    return {
      id: String(frame.id),
      error: {
        code: error.code,
        message: error.message,
        data: error.data,
      },
    }
  }
  return { id: String(frame.id), result: frame.result }
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
      const frame = { jsonrpc: "2.0", id, method, params }
      child.stdin?.write(JSON.stringify(frame) + "\n")
    })
  emitter.notify = (method, params) => {
    if (exited) return
    const frame = { jsonrpc: "2.0", method, params }
    child.stdin?.write(JSON.stringify(frame) + "\n")
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
