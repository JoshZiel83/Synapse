/**
 * Shared fetch for all AI-SDK provider instances.
 *
 * This is the ONE seam where outbound LLM traffic can be routed through a
 * self-hosted reverse proxy. When HTTPS_PROXY / HTTP_PROXY is set, requests go
 * through an undici ProxyAgent; otherwise a keep-alive Agent is used so the four
 * provider instances share warm connections.
 *
 * The proxy must preserve the full path (incl. /v1, /paas/v4/chat/completions)
 * and query string — we pass the URL through untouched and only swap the
 * dispatcher.
 */
import { Agent, ProxyAgent, fetch as undiciFetch } from "undici"
import type { FetchFunction } from "@ai-sdk/provider-utils"

const PROXY_URL =
  process.env.LLM_HTTPS_PROXY ||
  process.env.HTTPS_PROXY ||
  process.env.https_proxy ||
  process.env.HTTP_PROXY ||
  process.env.http_proxy ||
  ""

// One dispatcher process-wide. ProxyAgent when a proxy is configured, else a
// keep-alive Agent shared across providers.
const dispatcher = PROXY_URL
  ? new ProxyAgent({ uri: PROXY_URL, keepAliveTimeout: 30_000 })
  : new Agent({ keepAliveTimeout: 30_000, keepAliveMaxTimeout: 60_000 })

/**
 * A FetchFunction (typeof globalThis.fetch) the AI-SDK providers accept. We
 * delegate to undici's fetch with our dispatcher. The cast is required because
 * undici's fetch/RequestInit are structurally compatible but nominally distinct
 * from the DOM lib types the SDK's FetchFunction references.
 */
export const proxyFetch: FetchFunction = ((input: any, init?: any) =>
  undiciFetch(input, {
    ...(init ?? {}),
    dispatcher,
  } as any)) as unknown as FetchFunction
