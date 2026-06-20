// Tool-call presentation RENDERER (API-only).
//
// Pure + synchronous: evaluates a ToolPresentationDescriptor against a call's
// args (request side) and result data (result side) into structured content
// blocks + i18n-ready PresentationStrings. Lives in @synapse/api (not shared)
// because it uses node:path and is paired with the secretlint redactor — neither
// belongs in the FE/SW bundle.
//
// Redaction is NOT done here: the caller (runtime display path) runs a single
// deep secretlint pass over the rendered output before it reaches the redis
// snapshot, so EVERY string leaf (fallback/title/params/block text) is covered
// uniformly. `secretArgs`/`secretFields` ARE masked here (cheap, structural,
// and avoids feeding known secrets to the scanner at all).

import path from "node:path"
import dlv from "dlv"
import { IntlMessageFormat } from "intl-messageformat"
import { textBlock, type CanonicalContentBlock } from "@synapse/shared"
import type {
  ArgRef,
  PresentationString,
  PresentationTemplate,
  ToolPresentationDescriptor,
} from "@synapse/shared/tool-presentation"
import { diffLines } from "diff"

// Project default locale for the server-rendered `fallback`. The structured
// {key, params} ride alongside so a future FE i18n layer can re-render.
const FALLBACK_LOCALE = "zh-CN"
const SECRET_MASK = "[redacted]"
const TRUNCATE_LEN = 60

// IntlMessageFormat compiles its AST per message string; cache by message so the
// hot path (350ms-debounced snapshot) doesn't recompile identical templates.
const icuCache = new Map<string, IntlMessageFormat>()
function formatIcu(message: string, params: Record<string, string | number>) {
  let fmt = icuCache.get(message)
  if (!fmt) {
    fmt = new IntlMessageFormat(message, FALLBACK_LOCALE)
    icuCache.set(message, fmt)
  }
  const out = fmt.format(params)
  return typeof out === "string" ? out : String(out)
}

function applyPreprocess(
  value: unknown,
  pre: ArgRef["preprocess"]
): string | number {
  switch (pre) {
    case "basename":
      return typeof value === "string"
        ? path.basename(value)
        : String(value ?? "")
    case "dirname":
      return typeof value === "string"
        ? path.dirname(value)
        : String(value ?? "")
    case "length":
      if (Array.isArray(value) || typeof value === "string") return value.length
      return 0
    case "truncate60": {
      const s = typeof value === "string" ? value : String(value ?? "")
      return s.length > TRUNCATE_LEN ? `${s.slice(0, TRUNCATE_LEN)}…` : s
    }
    case "raw":
    case undefined:
    default:
      if (typeof value === "number") return value
      return typeof value === "string" ? value : String(value ?? "")
  }
}

function resolveArg(
  root: unknown,
  ref: ArgRef,
  secretPaths: ReadonlySet<string>
): string | number {
  if (secretPaths.has(ref.path)) return SECRET_MASK
  const raw = dlv(root as object, ref.path)
  if (raw === undefined || raw === null) {
    return ref.default ?? ""
  }
  return applyPreprocess(raw, ref.preprocess)
}

function renderTemplate(
  tpl: PresentationTemplate,
  root: unknown,
  secretPaths: ReadonlySet<string>
): PresentationString {
  const params: Record<string, string | number> = {}
  for (const [name, ref] of Object.entries(tpl.args ?? {})) {
    params[name] = resolveArg(root, ref, secretPaths)
  }
  let fallback: string
  try {
    fallback = formatIcu(tpl.message, params)
  } catch {
    // A malformed ICU template must never crash the snapshot; degrade to the
    // raw message string.
    fallback = tpl.message
  }
  return { key: tpl.key, params, fallback }
}

// ── Request rendering ───────────────────────────────────────────────────────

export interface RenderedToolRequest {
  icon: string
  title: PresentationString
  detail?: PresentationString
  requestBlocks: CanonicalContentBlock[]
}

function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {}, null, 2)
  } catch {
    return String(value ?? "")
  }
}

function buildRequestBlocks(
  descriptor: ToolPresentationDescriptor,
  args: Record<string, unknown>,
  secretPaths: ReadonlySet<string>
): CanonicalContentBlock[] {
  const spec = descriptor.request
  switch (spec.mode) {
    case "summary":
    case "hidden":
      return []
    case "code": {
      if (!spec.codeArg) return []
      const v = resolveArg(args, spec.codeArg, secretPaths)
      return v === "" ? [] : [textBlock(String(v))]
    }
    case "diff": {
      if (!spec.diff) return []
      const items = dlv(args, spec.diff.itemsPath)
      if (!Array.isArray(items) || items.length === 0) return []
      const chunks: string[] = []
      for (const item of items) {
        const oldText = String(dlv(item, spec.diff.oldField) ?? "")
        const newText = String(dlv(item, spec.diff.newField) ?? "")
        for (const part of diffLines(oldText, newText)) {
          let prefix: string
          if (part.added) {
            prefix = "+ "
          } else if (part.removed) {
            prefix = "- "
          } else {
            prefix = "  "
          }
          chunks.push(
            part.value
              .split("\n")
              .filter((line, i, arr) => !(i === arr.length - 1 && line === ""))
              .map((line) => prefix + line)
              .join("\n")
          )
        }
      }
      return chunks.length ? [textBlock(chunks.join("\n"))] : []
    }
    case "args_table":
    default: {
      // Generic key/value dump (secret-masked). The deep redact pass still runs
      // downstream, but masking declared secrets here avoids scanning them.
      const safe: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(args)) {
        safe[k] = secretPaths.has(k) ? SECRET_MASK : v
      }
      return [textBlock(prettyJson(safe))]
    }
  }
}

export function renderToolRequest(
  descriptor: ToolPresentationDescriptor,
  args: Record<string, unknown>
): RenderedToolRequest {
  const secretPaths = new Set(descriptor.request.secretArgs ?? [])
  return {
    icon: descriptor.icon,
    title: renderTemplate(descriptor.title, args, secretPaths),
    detail: descriptor.detail
      ? renderTemplate(descriptor.detail, args, secretPaths)
      : undefined,
    requestBlocks: buildRequestBlocks(descriptor, args, secretPaths),
  }
}

// ── Result rendering ────────────────────────────────────────────────────────

/**
 * Result data assembled by the caller (API) from already-loaded rows:
 *   - meta:  tool_results.metadata.toolMeta (device _meta / MCP structuredContent
 *            / callable res.metadata — normalized by Phase 2)
 *   - task:  tool_call_tasks.final_result_payload
 *   - error: error_message / final_error_payload
 *   - bodyBlocks: the raw result content blocks (from the API parts→blocks
 *            adapter + output chunks), used by passthrough/summary_then_raw.
 */
export interface ToolResultData {
  meta?: unknown
  task?: unknown
  error?: string
  bodyBlocks: CanonicalContentBlock[]
}

export interface RenderedToolResult {
  resultSummary?: PresentationString
  resultBlocks: CanonicalContentBlock[]
}

export function renderToolResult(
  descriptor: ToolPresentationDescriptor,
  data: ToolResultData
): RenderedToolResult {
  const spec = descriptor.result
  if (!spec) {
    return { resultBlocks: data.bodyBlocks }
  }
  const secretPaths = new Set(spec.secretFields ?? [])
  // Result-side ref root: `meta.*`, `task.*`, `error`.
  const resultRoot = { meta: data.meta, task: data.task, error: data.error }
  const resultSummary = spec.summary
    ? renderTemplate(spec.summary, resultRoot, secretPaths)
    : undefined

  const bodyMode = spec.bodyMode ?? "summary_then_raw"
  let resultBlocks: CanonicalContentBlock[]
  switch (bodyMode) {
    case "hidden":
      resultBlocks = []
      break
    case "json":
      resultBlocks = [textBlock(prettyJson(data.task ?? data.meta ?? {}))]
      break
    case "image":
      // Prefer file_ref blocks (chrome screenshots ingested to CAS); fall back
      // to whatever body blocks exist.
      resultBlocks = data.bodyBlocks.filter((b) => b.type === "file_ref")
      if (resultBlocks.length === 0) resultBlocks = data.bodyBlocks
      break
    case "passthrough":
    case "summary_then_raw":
    default:
      resultBlocks = data.bodyBlocks
      break
  }
  return { resultSummary, resultBlocks }
}

// Generic fallback descriptor for tools with no registered presentation
// (unknown MCP, soft-deleted source, etc.). Title = the stableKey leaf.
export function genericDescriptor(
  stableKey: string
): ToolPresentationDescriptor {
  const leaf = stableKey.split("/").filter(Boolean).pop() || stableKey
  return {
    v: 1,
    icon: "wrench",
    title: { key: "tool.generic.title", message: leaf, args: {} },
    request: { mode: "args_table" },
    result: { bodyMode: "summary_then_raw" },
  }
}
