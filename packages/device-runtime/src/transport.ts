// TransportClient — Control Plane WSS lifecycle. Reconnects with exponential
// backoff + jitter. Sends device.hello on every (re)attach; relays
// notifications + tracks request/response correlation for blocking RPCs.

import WebSocket from "ws"
import { randomUUID } from "node:crypto"
import type {
  DeviceHelloParams,
  DeviceServiceKind,
  JsonRpcRequest,
  JsonRpcResponse,
} from "@synapse/device-protocol"
import type { RuntimeLogger, RuntimeStatus } from "./types.js"

const BACKOFF_MIN_MS = 500
const BACKOFF_MAX_MS = 30_000
const BACKOFF_JITTER = 0.25

export interface TransportClientOptions {
  controlPlaneUrl: string
  hello: () => Promise<DeviceHelloParams>
  onStatus(status: RuntimeStatus): void
  onMessage?(method: string, params: unknown): void
  logger: RuntimeLogger
}

export interface PendingRequest {
  resolve(result: unknown): void
  reject(err: Error): void
  timer: ReturnType<typeof setTimeout>
}

const REQUEST_TIMEOUT_MS = 15_000

export class TransportClient {
  private socket: WebSocket | null = null
  private stopped = false
  private attempt = 0
  private pending = new Map<string, PendingRequest>()

  constructor(private readonly opts: TransportClientOptions) {}

  start(): void {
    void this.connectLoop()
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.socket) {
      try {
        this.socket.close(1000)
      } catch {
        /* ignore */
      }
      this.socket = null
    }
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(new Error("transport stopped"))
    }
    this.pending.clear()
  }

  async request(method: string, params: unknown): Promise<unknown> {
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error(`transport not connected (method=${method})`)
    }
    const id = randomUUID()
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`request timed out: ${method}`))
        }
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timer })
      const frame: JsonRpcRequest = {
        jsonrpc: "2.0",
        id,
        method,
        params,
      }
      socket.send(JSON.stringify(frame), (err) => {
        if (err && this.pending.delete(id)) {
          clearTimeout(timer)
          reject(err)
        }
      })
    })
  }

  notify(method: string, params: unknown): void {
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) return
    const frame: JsonRpcRequest = { jsonrpc: "2.0", method, params }
    socket.send(JSON.stringify(frame))
  }

  private async connectLoop() {
    while (!this.stopped) {
      try {
        await this.connectAndServe()
        this.attempt = 0
      } catch (err) {
        this.attempt += 1
        const delay = this.computeBackoff()
        this.opts.logger.warn("control-plane disconnect; reconnecting", {
          attempt: this.attempt,
          delayMs: delay,
          error: (err as Error).message,
        })
        this.opts.onStatus("offline")
        await this.sleep(delay)
      }
    }
  }

  private computeBackoff(): number {
    const base = Math.min(
      BACKOFF_MIN_MS * 2 ** Math.min(this.attempt - 1, 10),
      BACKOFF_MAX_MS
    )
    const jitter = base * BACKOFF_JITTER * (Math.random() * 2 - 1)
    return Math.max(BACKOFF_MIN_MS, Math.floor(base + jitter))
  }

  private sleep(ms: number) {
    return new Promise<void>((r) => setTimeout(r, ms))
  }

  private async connectAndServe(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.opts.controlPlaneUrl)
      this.socket = socket
      this.opts.onStatus("starting")
      socket.on("open", async () => {
        try {
          const hello = await this.opts.hello()
          const ack = await this.request("device.hello", hello)
          this.opts.logger.info("control-plane hello acknowledged", {
            ack,
          })
          this.opts.onStatus("online")
        } catch (err) {
          this.opts.logger.error("control-plane hello failed", {
            error: (err as Error).message,
          })
          socket.close()
        }
      })
      socket.on("message", (raw) => {
        const text = raw.toString()
        let parsed: JsonRpcResponse | JsonRpcRequest
        try {
          parsed = JSON.parse(text)
        } catch {
          return
        }
        if (
          typeof (parsed as JsonRpcResponse).id !== "undefined" &&
          ("result" in parsed || "error" in parsed)
        ) {
          const resp = parsed as JsonRpcResponse
          const id = String(resp.id)
          const pending = this.pending.get(id)
          if (pending) {
            clearTimeout(pending.timer)
            this.pending.delete(id)
            if (resp.error) {
              pending.reject(
                new Error(`rpc error ${resp.error.code}: ${resp.error.message}`)
              )
            } else {
              pending.resolve(resp.result)
            }
          }
          return
        }
        const req = parsed as JsonRpcRequest
        if (this.opts.onMessage && typeof req.method === "string") {
          this.opts.onMessage(req.method, req.params)
        }
      })
      socket.on("error", (err) => {
        if (this.socket === socket) this.socket = null
        reject(err)
      })
      socket.on("close", () => {
        if (this.socket === socket) this.socket = null
        resolve()
      })
    })
  }
}

export type { DeviceServiceKind }
