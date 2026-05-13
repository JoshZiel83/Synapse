import { mkdir } from "node:fs/promises"
import { Worker } from "node:worker_threads"
import { config } from "../../config/index.js"

type RuntimeState = "idle" | "warming" | "ready" | "error"

type WorkerRequest =
  | {
      id: number
      type: "warmup"
    }
  | {
      id: number
      type: "embed"
      texts: string[]
      inputType: "query" | "passage"
    }

type WorkerCallRequest =
  | {
      type: "warmup"
    }
  | {
      type: "embed"
      texts: string[]
      inputType: "query" | "passage"
    }

type WorkerResponse =
  | {
      id: number
      ok: true
      modelId: string
      dimension: number
      embeddings?: number[][]
    }
  | {
      id: number
      ok: false
      error: string
    }

type PendingRequest = {
  resolve: (value: WorkerResponse) => void
  reject: (error: Error) => void
}

type WarmupOptions = {
  allowRemoteModels?: boolean
}

class MemoryEmbeddingRuntime {
  private worker: Worker | null = null

  private state: RuntimeState = "idle"

  private lastError: string | null = null

  private warmupPromise: Promise<void> | null = null

  private requestId = 0

  private pending = new Map<number, PendingRequest>()

  private allowRemoteModels = config.memory.allowRuntimeModelDownload

  async ensureModelCacheDir() {
    await mkdir(config.memory.modelCacheDir, { recursive: true })
  }

  private buildWorker() {
    const sourceExt = import.meta.url.endsWith(".ts") ? "ts" : "js"
    const workerUrl = new URL(
      `./embedding-worker.${sourceExt}`,
      import.meta.url
    )
    const worker = new Worker(workerUrl, {
      workerData: {
        modelId: config.memory.modelId,
        modelCacheDir: config.memory.modelCacheDir,
        allowRemoteModels: this.allowRemoteModels,
      },
      execArgv:
        sourceExt === "ts"
          ? process.execArgv.length > 0
            ? process.execArgv
            : ["--import", "tsx"]
          : undefined,
    })

    worker.on("message", (response: WorkerResponse) => {
      const pending = this.pending.get(response.id)
      if (!pending) return
      this.pending.delete(response.id)
      if (!response.ok) {
        pending.reject(new Error(response.error))
        return
      }
      pending.resolve(response)
    })

    worker.on("error", (error) => {
      const workerError =
        error instanceof Error ? error : new Error(String(error))
      this.state = "error"
      this.lastError = workerError.message
      for (const pending of this.pending.values()) {
        pending.reject(workerError)
      }
      this.pending.clear()
    })

    worker.on("exit", (code) => {
      this.worker = null
      if (code !== 0) {
        this.state = "error"
        this.lastError = `memory embedding worker exited with code ${code}`
      }
    })

    this.worker = worker
  }

  private async callWorker(request: WorkerCallRequest) {
    if (!this.worker) {
      this.buildWorker()
    }
    const id = ++this.requestId
    const message = { ...request, id } as WorkerRequest
    return new Promise<WorkerResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.worker!.postMessage(message)
    })
  }

  async warmup(options?: WarmupOptions) {
    if (this.state === "ready") return
    if (this.warmupPromise) {
      await this.warmupPromise
      return
    }

    this.warmupPromise = (async () => {
      try {
        await this.ensureModelCacheDir()
        this.state = "warming"
        this.lastError = null
        this.allowRemoteModels =
          options?.allowRemoteModels ?? config.memory.allowRuntimeModelDownload
        if (options?.allowRemoteModels !== undefined && this.worker) {
          await this.worker.terminate()
          this.worker = null
        }
        const response = await this.callWorker({ type: "warmup" })
        if (!response.ok) {
          throw new Error(response.error)
        }
        this.state = "ready"
      } catch (error) {
        this.state = "error"
        this.lastError = error instanceof Error ? error.message : String(error)
        throw error
      } finally {
        this.warmupPromise = null
      }
    })()

    await this.warmupPromise
  }

  async embedTexts(texts: string[], inputType: "query" | "passage") {
    if (texts.length === 0) return []

    try {
      await this.warmup()
      const response = await this.callWorker({
        type: "embed",
        texts,
        inputType,
      })
      if (!response.ok) {
        throw new Error(response.error)
      }
      return response.embeddings || []
    } catch (error) {
      this.state = "error"
      this.lastError = error instanceof Error ? error.message : String(error)
      throw error
    }
  }

  async embedQuery(text: string) {
    const [embedding] = await this.embedTexts([text], "query")
    return embedding || null
  }

  async embedPassages(texts: string[]) {
    return this.embedTexts(texts, "passage")
  }

  getHealth() {
    return {
      state: this.state,
      ready: this.state === "ready",
      modelId: config.memory.modelId,
      modelCacheDir: config.memory.modelCacheDir,
      lastError: this.lastError,
    }
  }

  async shutdown() {
    const worker = this.worker
    this.worker = null
    if (worker) {
      await worker.terminate()
    }
    this.state = "idle"
    this.lastError = null
    this.warmupPromise = null
    for (const pending of this.pending.values()) {
      pending.reject(new Error("memory embedding runtime shut down"))
    }
    this.pending.clear()
  }
}

const runtime = new MemoryEmbeddingRuntime()

export function getMemoryEmbeddingRuntimeHealth() {
  return runtime.getHealth()
}

export async function warmMemoryEmbeddingRuntime(options?: WarmupOptions) {
  await runtime.warmup({
    allowRemoteModels:
      options?.allowRemoteModels ?? config.memory.allowRuntimeModelDownload,
  })
}

export async function embedMemoryQuery(text: string) {
  return runtime.embedQuery(text)
}

export async function embedMemoryPassages(texts: string[]) {
  return runtime.embedPassages(texts)
}

export async function shutdownMemoryEmbeddingRuntime() {
  await runtime.shutdown()
}
