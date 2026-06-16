import type { FastifyRequest } from "fastify"

type JsonBodyParserDone = (error: Error | null, body?: unknown) => void

export type RawBodyRequest = FastifyRequest & {
  rawBody?: unknown
}

export function parseJsonBodyWithRawCapture(
  request: FastifyRequest,
  body: string,
  done: JsonBodyParserDone
): void {
  try {
    ;(request as RawBodyRequest).rawBody = body
    const trimmed = typeof body === "string" ? body.trim() : ""
    done(null, trimmed ? JSON.parse(trimmed) : {})
  } catch (error) {
    done(error as Error, undefined)
  }
}
