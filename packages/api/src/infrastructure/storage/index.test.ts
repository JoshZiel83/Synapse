import test from "node:test"
import assert from "node:assert/strict"
import { createServer, type Server } from "node:http"
import { downloadToBuffer, downloadToBufferWithLimit } from "./index.js"

async function withServer(
  handler: (
    req: import("http").IncomingMessage,
    res: import("http").ServerResponse
  ) => void,
  body: (baseUrl: string) => Promise<void>
): Promise<void> {
  const server: Server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const addr = server.address()
  if (!addr || typeof addr === "string") throw new Error("no addr")
  const baseUrl = `http://127.0.0.1:${addr.port}`
  try {
    await body(baseUrl)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

test("downloadToBufferWithLimit: rejects when maxBytes <= 0", async () => {
  await assert.rejects(
    () => downloadToBufferWithLimit({ url: "http://x/", maxBytes: 0 }),
    /maxBytes/
  )
})

test("downloadToBufferWithLimit: enforces Content-Length precheck", async () => {
  await withServer(
    (_req, res) => {
      res.statusCode = 200
      res.setHeader("Content-Type", "application/octet-stream")
      res.setHeader("Content-Length", "1000")
      res.end(Buffer.alloc(1000))
    },
    async (baseUrl) => {
      await assert.rejects(
        () =>
          downloadToBufferWithLimit({
            url: `${baseUrl}/big`,
            maxBytes: 500,
            allowPrivateHosts: true,
          }),
        /declared size/
      )
    }
  )
})

test("downloadToBufferWithLimit: streams + aborts when body exceeds maxBytes (no Content-Length)", async () => {
  await withServer(
    (_req, res) => {
      res.statusCode = 200
      res.setHeader("Content-Type", "application/octet-stream")
      // Chunked transfer-encoding: no content-length
      res.write(Buffer.alloc(400))
      // Delay second chunk to ensure reader started
      setTimeout(() => {
        res.write(Buffer.alloc(400))
        res.end()
      }, 10)
    },
    async (baseUrl) => {
      await assert.rejects(
        () =>
          downloadToBufferWithLimit({
            url: `${baseUrl}/stream`,
            maxBytes: 500,
            allowPrivateHosts: true,
          }),
        /exceeded maxBytes/
      )
    }
  )
})

test("downloadToBufferWithLimit: succeeds when body fits", async () => {
  await withServer(
    (_req, res) => {
      res.statusCode = 200
      res.setHeader("Content-Type", "text/plain")
      res.end("hello")
    },
    async (baseUrl) => {
      const result = await downloadToBufferWithLimit({
        url: `${baseUrl}/ok`,
        maxBytes: 100,
        allowPrivateHosts: true,
      })
      assert.equal(result.buffer.toString(), "hello")
      assert.equal(result.sizeBytes, 5)
    }
  )
})

test("downloadToBufferWithLimit: allowedHosts enforces initial URL host", async () => {
  await assert.rejects(
    () =>
      downloadToBufferWithLimit({
        url: "http://evil.example.com/x",
        maxBytes: 1000,
        allowedHosts: ["cdn.qq.example"],
      }),
    /not in allowedHosts/
  )
})

test("downloadToBufferWithLimit: allowedHosts re-validates after redirect", async () => {
  // Set up two servers: redirector and target
  let target: Server | undefined
  let redirector: Server | undefined
  try {
    // Target server (will respond with body)
    target = createServer((_req, res) => {
      res.statusCode = 200
      res.end("ok")
    })
    await new Promise<void>((resolve) =>
      target!.listen(0, "127.0.0.1", resolve)
    )
    const targetAddr = target.address()
    if (!targetAddr || typeof targetAddr === "string")
      throw new Error("no addr")
    const targetUrl = `http://127.0.0.1:${targetAddr.port}/final`

    // Redirector — sends 302 to target
    redirector = createServer((_req, res) => {
      res.statusCode = 302
      res.setHeader("Location", targetUrl)
      res.end()
    })
    await new Promise<void>((resolve) =>
      redirector!.listen(0, "127.0.0.1", resolve)
    )
    const redirAddr = redirector.address()
    if (!redirAddr || typeof redirAddr === "string") throw new Error("no addr")

    // Whitelist only the redirector host → after redirect, target host
    // (with different port) should not be allowed.
    await assert.rejects(
      () =>
        downloadToBufferWithLimit({
          url: `http://127.0.0.1:${redirAddr.port}/r`,
          maxBytes: 1000,
          allowedHosts: ["evil.example.com"],
          allowPrivateHosts: true,
        }),
      /not in allowedHosts/
    )
  } finally {
    if (target) await new Promise<void>((r) => target!.close(() => r()))
    if (redirector) await new Promise<void>((r) => redirector!.close(() => r()))
  }
})

test("downloadToBufferWithLimit: aborts on timeout", async () => {
  await withServer(
    (_req, _res) => {
      // never respond
    },
    async (baseUrl) => {
      await assert.rejects(
        () =>
          downloadToBufferWithLimit({
            url: `${baseUrl}/hang`,
            maxBytes: 1000,
            timeoutMs: 80,
            allowPrivateHosts: true,
          }),
        // node-fetch / undici raise an AbortError on signal abort
        (err: Error) => /abort|timeout|operation/i.test(err.message)
      )
    }
  )
})

test("downloadToBufferWithLimit: blocks a private/loopback host by default (SSRF)", async () => {
  await withServer(
    (_req, res) => {
      res.statusCode = 200
      res.end("should-never-be-read")
    },
    async (baseUrl) => {
      // No allowPrivateHosts → the loopback target must be rejected before any
      // request is made.
      await assert.rejects(
        () =>
          downloadToBufferWithLimit({ url: `${baseUrl}/x`, maxBytes: 1000 }),
        /non-public address/
      )
    }
  )
})

test("downloadToBuffer (general entry) enforces SSRF by default", async () => {
  await withServer(
    (_req, res) => {
      res.statusCode = 200
      res.end("nope")
    },
    async (baseUrl) => {
      // baseUrl is 127.0.0.1 — the generic entry must reject it (it now
      // delegates to the hardened path with the SSRF check always on).
      await assert.rejects(
        () => downloadToBuffer(`${baseUrl}/x`),
        /non-public address/
      )
    }
  )
})

test("SSRF pin: a hostname resolving to loopback is blocked at connect", async () => {
  await withServer(
    (_req, res) => {
      res.statusCode = 200
      res.end("nope")
    },
    async (baseUrl) => {
      // Use the hostname form "localhost" (resolves to 127.0.0.1). Even though
      // the URL string isn't a literal IP, the connect-time lookup validation
      // (and the pre-flight check) must reject it.
      const port = new URL(baseUrl).port
      await assert.rejects(
        () =>
          downloadToBufferWithLimit({
            url: `http://localhost:${port}/x`,
            maxBytes: 1000,
          }),
        /non-public|SSRF/
      )
    }
  )
})
