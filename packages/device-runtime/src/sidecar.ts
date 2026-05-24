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

export function startSidecar(opts: SidecarOptions): SidecarHandle {
  const spawnImpl = opts.spawnImpl ?? spawn
  const child: ChildProcess = spawnImpl(opts.binaryPath, opts.args ?? [], {
    env: opts.env ?? process.env,
    stdio: ["pipe", "pipe", "pipe"],
  })
  const emitter = new EventEmitter() as SidecarHandle
  const pending = new Map<string, PendingRequest>()
  let nextId = 1

  if (child.stdout) {
    const rl = createInterface({ input: child.stdout })
    rl.on("line", (line) => {
      if (!line.trim()) return
      let frame: {
        id?: string
        result?: unknown
        error?: { code: number; message: string }
      }
      try {
        frame = JSON.parse(line)
      } catch {
        return
      }
      if (!frame.id) return
      const p = pending.get(String(frame.id))
      if (!p) return
      pending.delete(String(frame.id))
      if (frame.error) {
        p.reject(new Error(`${frame.error.code}: ${frame.error.message}`))
      } else {
        p.resolve(frame.result)
      }
    })
  }

  child.on("exit", (code) => emitter.emit("exit", code))

  emitter.request = (method, params) =>
    new Promise<unknown>((resolve, reject) => {
      const id = String(nextId++)
      pending.set(id, { resolve, reject })
      const frame = { jsonrpc: "2.0", id, method, params }
      child.stdin?.write(JSON.stringify(frame) + "\n")
    })
  emitter.notify = (method, params) => {
    const frame = { jsonrpc: "2.0", method, params }
    child.stdin?.write(JSON.stringify(frame) + "\n")
  }
  emitter.stop = async () => {
    try {
      child.stdin?.end()
      child.kill("SIGTERM")
    } catch {
      /* ignore */
    }
  }
  return emitter
}
