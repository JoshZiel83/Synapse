// Tiny HTTP server used by integration tests to:
//  - serve mock images for the image-url MCP variant (saveFromUrl path)
//  - mock remote endpoints for callable plugin tests
//
// All responses are scripted by the test via the `routes` map.

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http"
import { AddressInfo } from "node:net"

export type MockResponse = {
  status?: number
  headers?: Record<string, string>
  body: Buffer | string
}

export type MockRouteHandler = (
  req: IncomingMessage,
  body: Buffer
) => Promise<MockResponse> | MockResponse

export interface MockHttpHandle {
  server: Server
  port: number
  baseUrl: string
  setRoute: (pathOrPattern: string, handler: MockRouteHandler) => void
  stop: () => Promise<void>
}

export async function startMockHttp(
  opts: { port?: number } = {}
): Promise<MockHttpHandle> {
  const routes = new Map<string, MockRouteHandler>()

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://localhost")
    const handler = routes.get(url.pathname)
    if (!handler) {
      res.statusCode = 404
      res.setHeader("content-type", "text/plain")
      res.end("Not Found\n")
      return
    }

    const chunks: Buffer[] = []
    for await (const chunk of req) {
      chunks.push(chunk as Buffer)
    }
    const body = Buffer.concat(chunks)

    try {
      const response = await handler(req, body)
      res.statusCode = response.status ?? 200
      for (const [k, v] of Object.entries(response.headers || {})) {
        res.setHeader(k, v)
      }
      res.end(response.body)
    } catch (err) {
      res.statusCode = 500
      res.setHeader("content-type", "text/plain")
      res.end(`Mock route error: ${(err as Error).message}\n`)
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(opts.port ?? 0, "127.0.0.1", () => {
      server.removeListener("error", reject)
      resolve()
    })
  })

  const port = (server.address() as AddressInfo).port

  return {
    server,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    setRoute: (path, handler) => routes.set(path, handler),
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
      }),
  }
}
