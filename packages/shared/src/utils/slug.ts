/**
 * ASCII slug helper. Lowercases, replaces runs of disallowed characters with a
 * separator, collapses repeats, trims leading/trailing separators, and
 * optionally caps the length.
 *
 * This consolidates ~7 near-identical hand-rolled slugifiers that had drifted
 * on separator (- vs .), length cap (64/96/120/none), and allowed character
 * class. It deliberately keeps the original ASCII-only behavior (non-ASCII,
 * including CJK, is stripped) rather than adopting a transliterating slug
 * library — changing the output would alter slugs already persisted in the DB.
 */
export interface SlugifyOptions {
  /** Separator between tokens. Default "-". */
  readonly separator?: string
  /** Max length of the result (applied after trimming). Default: no cap. */
  readonly maxLength?: number
  /** Returned when the slug would otherwise be empty. Default: "". */
  readonly fallback?: string
  /**
   * Whether to keep whitespace as a token boundary explicitly. Irrelevant for
   * correctness (whitespace is disallowed and becomes a separator anyway); kept
   * for parity with the previous implementations.
   */
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export function slugify(value: string, options: SlugifyOptions = {}): string {
  const separator = options.separator ?? "-"
  const sep = escapeRegExp(separator)
  // Allowed: a-z, 0-9, and the separator itself. Everything else → separator.
  // (Inside a char class the separator is escaped too; "-" must stay safe.)
  const disallowed = new RegExp(`[^a-z0-9${sep}]+`, "g")
  const repeated = new RegExp(`${sep}{2,}`, "g")
  const edges = new RegExp(`^${sep}+|${sep}+$`, "g")

  let slug = value
    .trim()
    .toLowerCase()
    .replace(disallowed, separator)
    .replace(repeated, separator)
    .replace(edges, "")

  if (options.maxLength !== undefined) {
    slug = slug.slice(0, options.maxLength).replace(edges, "")
  }

  return slug || options.fallback || ""
}
