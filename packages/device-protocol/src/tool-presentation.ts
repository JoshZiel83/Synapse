// Tool-call presentation descriptor — the declarative, serializable spec each
// tool ships so the UI can render a friendly title/detail/result instead of a
// raw tool name + JSON dump.
//
// Lives in @synapse/device-protocol (the base package with no @synapse deps) so
// every layer can import the TYPES without a circular dependency:
//   - device-runtime builtin *.presentation.ts files declare descriptor VALUES,
//   - the API renderer evaluates them,
//   - @synapse/shared re-exports the tiny FE-facing `PresentationString` so the
//     web/mobile clients (which only depend on @synapse/shared) can render the
//     pre-computed `fallback` string.
//
// IMPORTANT: this module is intentionally NOT re-exported from the package root
// barrel (src/index.ts). The root barrel pulls in browser-tools, which is
// inlined into the web/mobile chat service worker bundles; keeping presentation
// types on a dedicated subpath (`@synapse/device-protocol/tool-presentation`)
// guarantees descriptor copy/templates never bloat those bundles.
//
// This file is pure types + a no-op runtime helper — zero zod, zero node:*.

/**
 * Locale-agnostic display string produced by the server-side renderer.
 *
 * - `fallback` is ALWAYS present: the server renders the descriptor's ICU
 *   template into the project's default locale (Chinese) so any client can show
 *   something without an i18n runtime.
 * - `key` + `params` carry the structured i18n payload so a future FE i18n
 *   layer (react-intl / i18next-icu) can re-render in the viewer's locale with
 *   zero rework. `params` values are ALWAYS pre-redacted server-side.
 */
export interface PresentationString {
  key: string
  params: Record<string, string | number>
  fallback: string
}

/**
 * Pre-value-extraction domain transform that ICU MessageFormat cannot express.
 * Everything ICU CAN do (plural, number, select) stays in the template string.
 */
export type ArgPreprocess =
  | "basename" // node:path basename — "/a/b/foo.ts" -> "foo.ts"
  | "dirname" // node:path dirname
  | "length" // Array/string .length — drives ICU {count, plural}
  | "truncate60" // first 60 chars + ellipsis
  | "raw" // identity (default)

/** A reference into the args (request side) or result data (result side). */
export interface ArgRef {
  /**
   * Dot-path resolved with `dlv`. Request side: root is the tool's normalized
   * input. Result side: `meta.*` -> tool_results.metadata.toolMeta,
   * `task.*` -> tool_call_tasks.final_result_payload,
   * `error` -> error_message / final_error_payload.
   */
  path: string
  preprocess?: ArgPreprocess
  /** Literal fallback when the path resolves to undefined/null. */
  default?: string
}

/**
 * A renderable template: an ICU MessageFormat `message` plus the named args it
 * interpolates (each mapped to a dot-path + optional preprocess). `key` is the
 * i18n message key the FE will eventually use.
 */
export interface PresentationTemplate {
  key: string
  message: string
  args?: Record<string, ArgRef>
}

/** How the request (input) body is rendered into content blocks. */
export type RequestRenderMode =
  | "summary" // title/detail only, no body block
  | "args_table" // key/value table of (redacted) args
  | "code" // a single arg rendered as a code block
  | "diff" // an array of {old,new} objects rendered as a diff
  | "hidden" // no body block

/**
 * How the raw result body is rendered. Default `summary_then_raw` keeps the raw
 * (expandable) body alongside the friendly summary so the activity panel stays
 * usable for debugging — the summary supplements, never replaces, the raw body.
 */
export type ResultBodyMode =
  | "summary_then_raw"
  | "passthrough"
  | "json"
  | "image"
  | "hidden"

/**
 * Generic structure for the `diff` request mode: an array at `itemsPath` whose
 * items each carry an `oldField` and `newField` string. Keeps diff rendering
 * tool-agnostic (no per-tool branching in the renderer).
 */
export interface DiffSpec {
  itemsPath: string
  oldField: string
  newField: string
}

export interface ToolPresentationRequestSpec {
  mode: RequestRenderMode
  /** For mode "code": the arg to render as a code block. */
  codeArg?: ArgRef
  /** For mode "diff": how to find the {old,new} array. */
  diff?: DiffSpec
  /** Arg dot-paths whose values are forced to *** before any rendering. */
  secretArgs?: string[]
}

export interface ToolPresentationResultSpec {
  /** Friendly one-line summary; supplements the raw body. */
  summary?: PresentationTemplate
  /** Defaults to "summary_then_raw" when omitted. */
  bodyMode?: ResultBodyMode
  /** Result-data dot-paths forced to *** before rendering. */
  secretFields?: string[]
}

/**
 * The full per-tool presentation descriptor. Declared once next to each tool;
 * evaluated by the API renderer against the call's args + result data.
 */
export interface ToolPresentationDescriptor {
  /** Schema version for forward-compat. */
  v: 1
  /** Semantic icon name (mapped to a component per client, with a default). */
  icon: string
  title: PresentationTemplate
  detail?: PresentationTemplate
  request: ToolPresentationRequestSpec
  result?: ToolPresentationResultSpec
}

/**
 * FE-safe resolver: turn a PresentationString into the string to display.
 *
 * This pass renders the server-provided `fallback` (Chinese). A future FE i18n
 * layer will special-case `key`/`params`; until then this is the single place
 * the clients call, so adding i18n later touches one function.
 */
export function resolvePresentation(
  value: PresentationString | undefined
): string | undefined {
  return value?.fallback
}
