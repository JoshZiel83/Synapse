import { z } from "zod"
import { getCarrier } from "./trace-context.js"

export const RemoteAgentTaskCreateResponseSchema = z.strictObject({
  task: z.strictObject({
    id: z.string().min(1),
  }),
})

export const RemoteAgentFailDeliveriesResponseSchema = z.strictObject({
  rescheduled: z.number().int().nonnegative(),
})

export async function requestJson<S extends z.ZodType>(
  serverUrl: string,
  machineKey: string,
  pathname: string,
  init: RequestInit | undefined,
  schema: S,
  fetchImpl: typeof fetch = fetch
): Promise<z.output<S>> {
  const url = new URL(pathname, serverUrl)
  const headers = new Headers(init?.headers)
  headers.set("authorization", `Bearer ${machineKey}`)
  if (init?.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json")
  }
  // Continue the current turn's distributed trace on the daemon→api callback.
  // serverUrl is always the daemon's own first-party api (config.serverUrl), so
  // the W3C carrier (random ids + vendor list members, no PII) never leaks to
  // a third party. Note: a deployment's PUBLIC-edge nginx strips `tracestate`
  // by design (accepted — Tempo never consumes it; `traceparent` survives).
  const carrier = getCarrier()
  if (carrier) {
    headers.set("traceparent", carrier.traceparent)
    if (carrier.tracestate) headers.set("tracestate", carrier.tracestate)
  }
  const response = await fetchImpl(url, { ...init, headers })
  if (!response.ok) {
    const bodyText = await response.text().catch(() => "")
    throw new Error(
      `Remote-agent request failed (${response.status} ${response.statusText})${bodyText ? `: ${bodyText}` : ""}`
    )
  }

  const text = await response.text()
  let payload: unknown
  try {
    payload = text.trim() ? JSON.parse(text) : undefined
  } catch (err) {
    throw new Error("Remote-agent response returned malformed JSON", {
      cause: err,
    })
  }

  const parsed = schema.safeParse(payload)
  if (!parsed.success) {
    throw new Error("Remote-agent response shape invalid", {
      cause: parsed.error,
    })
  }
  return parsed.data
}
