// Spawn the API in-process by tsx, listening on a worktree-private port.
// The API picks up env vars at startup; we wait for /api/v1/health.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
const WORKTREE_ROOT = join(__dirname, "../../../../..")

export const TEST_API_PORT = 38091
export const TEST_API_HOST = "127.0.0.1"
export const TEST_API_BASE_URL = `http://${TEST_API_HOST}:${TEST_API_PORT}`

export interface ApiHandle {
  proc: ChildProcessWithoutNullStreams
  port: number
  baseUrl: string
  storageDir: string
  stop: () => Promise<void>
}

async function isPortFree(port: number): Promise<boolean> {
  const { createConnection } = await import("node:net")
  return new Promise<boolean>((resolve) => {
    const sock = createConnection({ port, host: TEST_API_HOST })
    let done = false
    sock.once("connect", () => {
      if (done) return
      done = true
      sock.destroy()
      resolve(false)
    })
    sock.once("error", () => {
      if (done) return
      done = true
      resolve(true)
    })
    setTimeout(() => {
      if (done) return
      done = true
      sock.destroy()
      resolve(true)
    }, 500)
  })
}

async function waitForHealth(
  baseUrl: string,
  timeoutMs = 60_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/v1/health`)
      if (res.status === 200) {
        await res.text()
        return
      }
    } catch {
      // ignore, retry
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(
    `API did not become healthy at ${baseUrl} within ${timeoutMs}ms`
  )
}

export async function spawnApi(
  opts: {
    databaseUrl: string
    redisUrl: string
    extraEnv?: Record<string, string>
    silent?: boolean
  } = { databaseUrl: "", redisUrl: "" }
): Promise<ApiHandle> {
  if (!(await isPortFree(TEST_API_PORT))) {
    throw new Error(
      `Port ${TEST_API_PORT} is already in use. Likely another integration test or worktree is running.`
    )
  }

  const storageDir = mkdtempSync(join(tmpdir(), "synapse-int-test-storage-"))
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(TEST_API_PORT),
    HOST: TEST_API_HOST,
    NODE_ENV: "test",
    DATABASE_URL: opts.databaseUrl,
    REDIS_URL: opts.redisUrl,
    STORAGE_DIR: join(storageDir, "files"),
    BASE_URL: TEST_API_BASE_URL,
    APP_BASE_URL: TEST_API_BASE_URL,
    JWT_SECRET: "int_test_jwt_secret",
    JWT_REFRESH_SECRET: "int_test_jwt_refresh_secret",
    PLATFORM_ADMIN_EMAILS: "int-test@synapse.dev",
    MEMORY_ALLOW_RUNTIME_MODEL_DOWNLOAD: "false",
    ...(opts.extraEnv || {}),
  }

  const proc = spawn("npx", ["tsx", "src/index.ts"], {
    cwd: join(WORKTREE_ROOT, "packages/api"),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  })

  let exited = false
  proc.on("exit", () => {
    exited = true
  })

  if (!opts.silent) {
    proc.stdout.on("data", (b) => process.stderr.write(`[api stdout] ${b}`))
    proc.stderr.on("data", (b) => process.stderr.write(`[api stderr] ${b}`))
  }

  try {
    await waitForHealth(TEST_API_BASE_URL)
  } catch (err) {
    if (exited) {
      throw new Error(
        "API process exited before becoming healthy. Check logs above."
      )
    }
    proc.kill("SIGKILL")
    throw err
  }

  return {
    proc,
    port: TEST_API_PORT,
    baseUrl: TEST_API_BASE_URL,
    storageDir,
    stop: async () => {
      if (!exited) {
        proc.kill("SIGTERM")
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(() => {
            try {
              proc.kill("SIGKILL")
            } catch {}
            resolve()
          }, 5000)
          proc.once("exit", () => {
            clearTimeout(timeout)
            resolve()
          })
        })
      }
      try {
        proc.stdout?.destroy()
      } catch {}
      try {
        proc.stderr?.destroy()
      } catch {}
      try {
        rmSync(storageDir, { recursive: true, force: true })
      } catch {}
    },
  }
}
