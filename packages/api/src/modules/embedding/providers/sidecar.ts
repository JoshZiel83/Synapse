// Shared HTTP-client embedding provider factory. The local bge-m3 sidecar and the
// generic openai-compatible cloud adapter both POST a batch of texts to an HTTP
// endpoint and get back a batch of vectors; they differ ONLY in the request body,
// the auth headers, and where the vectors live in the response. So the fetch +
// timeout + failure classification + never-reject guarantee live here ONCE, and
// each adapter is a small options object (mirrors modules/transcription/sidecar.ts).
//
// The authoritative shape/dimension/finite/norm validation is NOT here — it is
// enforced ONCE at the facade (index.ts) so a wrong-width vector can never reach
// `::vector`, regardless of provider. This factory only classifies transport-level
// success/failure and hands the raw extracted rows up.

import { parseJsonObject } from "@synapse/shared"
import type {
  EmbedInput,
  EmbeddingProvider,
  EmbeddingResult,
} from "../types.js"

type Logger = ReturnType<
  typeof import("../../../infrastructure/logger/index.js").createLogger
>

export interface HttpEmbeddingOptions {
  readonly key: string
  /** cache-key component + provenance/log field; encodes model + dim. */
  readonly engineVersion: string
  readonly model: string
  readonly dimension: number
  /** Per-request text cap the facade splits larger batches to (cloud vendors only;
   *  omit for the local sidecar). */
  readonly maxBatch?: number
  readonly log: Logger
  /** Endpoint path appended to the base URL, e.g. "embed" | "embeddings". */
  readonly path: string
  /** Read at call time so an unconfigured provider reports isConfigured()=false. */
  getUrl(): string
  getTimeoutMs(): number
  /** Provider-specific request JSON body. */
  buildBody(input: EmbedInput): unknown
  /** Provider-specific headers (e.g. Authorization). content-type is added here. */
  buildHeaders?(): Record<string, string>
  /** Whether the reach-env is present. Defaults to a non-empty URL. */
  isConfigured?(): boolean
  /** Extract the ordered rows from the parsed response. Return null when the
   *  response is malformed (→ terminal, not retryable). `count` is the number of
   *  input texts, for adapters that must re-order by index. */
  extractVectors(
    data: Record<string, unknown>,
    count: number
  ): number[][] | null
}

export function buildHttpEmbeddingProvider(
  opts: HttpEmbeddingOptions
): EmbeddingProvider {
  function base(partial: Partial<EmbeddingResult>): EmbeddingResult {
    return {
      ok: false,
      vectors: [],
      provider: opts.key,
      engineVersion: opts.engineVersion,
      ...partial,
    }
  }

  async function embed(input: EmbedInput): Promise<EmbeddingResult> {
    const url = opts.getUrl()
    if (!url) {
      return base({
        error: `${opts.key} embedding URL is not configured`,
        retryable: false,
      })
    }

    let endpoint: string
    try {
      endpoint = new URL(
        opts.path,
        url.endsWith("/") ? url : `${url}/`
      ).toString()
    } catch {
      return base({
        error: `invalid ${opts.key} embedding URL: ${url}`,
        retryable: false,
      })
    }

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(opts.buildHeaders?.() ?? {}),
        },
        body: JSON.stringify(opts.buildBody(input)),
        signal: AbortSignal.timeout(opts.getTimeoutMs()),
      })

      // 503 = the sidecar's bounded pool is saturated OR the model is still
      // loading; 429 = a cloud vendor rate-limit → retry later.
      if (response.status === 503 || response.status === 429) {
        return base({
          error: `${opts.key} embedding endpoint is busy/rate-limited (HTTP ${response.status})`,
          retryable: true,
        })
      }
      if (!response.ok) {
        // 5xx = server-side transient; 4xx = our request is wrong (terminal).
        return base({
          error: `${opts.key} embedding endpoint returned HTTP ${response.status}`,
          retryable: response.status >= 500,
        })
      }

      // Read as text + parse via the shared object-only decoder (never throws;
      // {} on malformed) rather than the unchecked response.json() the boundary
      // guard forbids.
      const data = parseJsonObject(await response.text())
      const vectors = opts.extractVectors(data, input.texts.length)
      if (!vectors) {
        return base({
          error: `${opts.key} embedding response had an unexpected shape`,
          retryable: false,
        })
      }
      return {
        ok: true,
        vectors,
        provider: opts.key,
        engineVersion: opts.engineVersion,
        model: opts.model,
      }
    } catch (err) {
      // Network error / timeout / abort → transient, retryable.
      const message = err instanceof Error ? err.message : String(err)
      opts.log.warn({ err }, `${opts.key} embedding request failed`)
      return base({
        error: `${opts.key} embedding request failed: ${message}`,
        retryable: true,
      })
    }
  }

  return {
    key: opts.key,
    engineVersion: opts.engineVersion,
    dimension: opts.dimension,
    maxBatch: opts.maxBatch,
    isConfigured: opts.isConfigured ?? (() => Boolean(opts.getUrl())),
    embed,
  }
}

/** Parse an unknown value into a rectangular number[][] of exactly `count` rows,
 *  or null (→ terminal) if it isn't a batch of NUMERIC arrays of the right length.
 *  Rejects any non-numeric / non-finite element rather than coercing it — a buggy
 *  self-host build that pads a correct-width row with null/true would otherwise be
 *  silently repaired to 0/1 and persisted as a corrupt vector. The facade still
 *  checks each row's WIDTH + norm. */
export function asVectorRows(value: unknown, count: number): number[][] | null {
  if (!Array.isArray(value) || value.length !== count) return null
  const rows: number[][] = []
  for (const row of value) {
    if (!Array.isArray(row)) return null
    const nums: number[] = []
    for (const n of row) {
      if (typeof n !== "number" || !Number.isFinite(n)) return null
      nums.push(n)
    }
    rows.push(nums)
  }
  return rows
}
