// Pure ${ENV_VAR} interpolation for the model-groups config document.
//
// Design constraints (deliberate):
//   - PURE: never reads files, never throws on missing vars, never calls
//     process.exit. It collects the names of unresolved variables and returns
//     them; the CALLER decides how to fail. This keeps it unit-testable and lets
//     both the CLI and the rebuild hook aggregate-and-report in their own voice.
//   - `$$` is a literal-dollar escape. It is handled by TOKENIZATION rather than
//     a sentinel character: each segment is split on "$$", each piece has its
//     `${VAR}` references resolved, then the pieces are rejoined with a literal
//     "$". This means `$$` never participates in env matching and we never inject
//     a magic placeholder char that could collide with a user's real value.

/** Matches a single ${NAME} reference where NAME is a valid env identifier. */
const ENV_VAR_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g

export interface InterpolateResult<T> {
  /** The input with every ${VAR} replaced by its env value (deep clone). */
  value: T
  /** Sorted, de-duplicated names of variables that were missing or empty. */
  missing: string[]
}

function interpolateString(
  input: string,
  env: NodeJS.ProcessEnv,
  missing: Set<string>
): string {
  // Split on the `$$` escape first so escaped dollars never reach ${} matching.
  const segments = input.split("$$")
  const resolvedSegments = segments.map((segment) =>
    segment.replace(ENV_VAR_PATTERN, (_match, name: string) => {
      const raw = env[name]
      // Treat missing OR whitespace-only as unresolved — an env var that exists
      // but is blank must not silently produce an empty config field.
      if (raw === undefined || raw.trim() === "") {
        missing.add(name)
        return ""
      }
      return raw
    })
  )
  // Rejoin escaped segments with a literal single dollar.
  return resolvedSegments.join("$")
}

function interpolateValue(
  value: unknown,
  env: NodeJS.ProcessEnv,
  missing: Set<string>
): unknown {
  if (typeof value === "string") {
    return interpolateString(value, env, missing)
  }
  if (Array.isArray(value)) {
    return value.map((item) => interpolateValue(item, env, missing))
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(value)) {
      out[key] = interpolateValue(val, env, missing)
    }
    return out
  }
  // numbers, booleans, null, undefined pass through untouched
  return value
}

/**
 * Recursively replace every `${VAR}` reference in all string leaves of `input`
 * with the corresponding value from `env` (defaults to process.env). Returns a
 * deep-cloned value plus the list of variables that could not be resolved.
 * Never throws and never exits.
 */
export function interpolateEnv<T>(
  input: T,
  env: NodeJS.ProcessEnv = process.env
): InterpolateResult<T> {
  const missing = new Set<string>()
  const value = interpolateValue(input, env, missing) as T
  return { value, missing: [...missing].sort() }
}
