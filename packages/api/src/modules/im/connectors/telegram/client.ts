/**
 * Telegram Bot API client — lazy raw-fetch (NO top-level IO).
 *
 * Node 22 ships global `fetch` / `FormData` / `Blob`, so we call the Bot
 * API directly (no grammy/telegraf dependency — we follow their PATTERNS).
 *
 * Two call shapes:
 *   - `callMethod` — JSON body (`application/json`).
 *   - `callMethodMultipart` — `FormData` body for `InputFile` uploads
 *     (`sendPhoto`/`sendVoice`/… with attached file bytes + `attach://`).
 *
 * Both parse the envelope `{ok, result, error_code, description,
 * parameters.retry_after}` and throw a typed `TelegramApiError` on `ok:false`
 * so the outbound + poll layers can classify (retry vs permanent vs fatal).
 */

import { resolveApiRoot, type TelegramCredentials } from "./credentials.js"
import { telegramMethodUrl, type TelegramApiResponse } from "./types.js"

const DEFAULT_TIMEOUT_MS = 30_000

/**
 * Thrown when the Bot API returns `ok:false` (or a non-2xx HTTP status with
 * an unparseable body). Carries the wire `error_code`, `description`, and
 * the `retry_after` / `migrate_to_chat_id` hints from `parameters` so the
 * caller's taxonomy can branch without re-parsing.
 */
export class TelegramApiError extends Error {
  readonly errorCode: number
  readonly description: string
  readonly retryAfter?: number
  readonly migrateToChatId?: number
  constructor(input: {
    errorCode: number
    description: string
    retryAfter?: number
    migrateToChatId?: number
  }) {
    super(`telegram api error ${input.errorCode}: ${input.description}`)
    this.name = "TelegramApiError"
    this.errorCode = input.errorCode
    this.description = input.description
    this.retryAfter = input.retryAfter
    this.migrateToChatId = input.migrateToChatId
  }
}

function parseEnvelope<T>(
  status: number,
  json: TelegramApiResponse<T> | undefined
): T {
  if (json && json.ok && json.result !== undefined) {
    return json.result
  }
  // ok:false (well-formed) OR a non-2xx with a body we couldn't trust.
  throw new TelegramApiError({
    errorCode: json?.error_code ?? status,
    description: json?.description ?? `HTTP ${status}`,
    retryAfter: json?.parameters?.retry_after,
    migrateToChatId: json?.parameters?.migrate_to_chat_id,
  })
}

async function readJson<T>(
  res: Response
): Promise<TelegramApiResponse<T> | undefined> {
  try {
    return JSON.parse(await res.text()) as TelegramApiResponse<T>
  } catch {
    return undefined
  }
}

/** JSON-body Bot API call. Returns the unwrapped `result`. */
export async function callMethod<T>(
  creds: TelegramCredentials,
  method: string,
  params: Record<string, unknown>,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<T> {
  const url = telegramMethodUrl(resolveApiRoot(creds), creds.botToken, method)
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
    signal:
      opts.signal ?? AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  })
  return parseEnvelope<T>(res.status, await readJson<T>(res))
}

/**
 * Multipart Bot API call for `InputFile` uploads. `fields` carry the scalar
 * params (chat_id, caption, the `attach://<name>` references). `files` carry
 * the binary parts whose names are referenced by `attach://`.
 */
export async function callMethodMultipart<T>(
  creds: TelegramCredentials,
  method: string,
  fields: Record<string, string | number | boolean | undefined>,
  files: Array<{
    field: string
    filename: string
    buffer: Buffer
    contentType?: string
  }>,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<T> {
  const url = telegramMethodUrl(resolveApiRoot(creds), creds.botToken, method)
  const form = new FormData()
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue
    form.set(k, typeof v === "string" ? v : String(v))
  }
  for (const f of files) {
    const blob = new Blob([new Uint8Array(f.buffer)], {
      type: f.contentType || "application/octet-stream",
    })
    form.set(f.field, blob, f.filename)
  }
  const res = await fetch(url, {
    method: "POST",
    body: form,
    signal:
      opts.signal ?? AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  })
  return parseEnvelope<T>(res.status, await readJson<T>(res))
}
