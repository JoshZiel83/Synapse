// Argv parser for the synapse-device CLI. Pulled out of bin.ts so unit
// tests can exercise the parsing rules without triggering bin.ts's
// top-level `main()` call.
//
// Contract:
//   * `--flag=value`          → flags.set("flag", "value")
//   * `--flag value`          → flags.set("flag", "value")   (next token consumed)
//   * `--flag --other`        → flags.set("flag", "true")    (bare boolean; next
//                                                              token starts with
//                                                              `--`, so we don't
//                                                              swallow it)
//   * `--flag` (last token)   → flags.set("flag", "true")    (bare boolean)
//
// Downstream code checks bare boolean flags via
// `getFlag(flags, "name") === "true"` (see e.g. install-bundles'
// --strict, --force, --require-prestaged handling). The earlier shape
// unconditionally consumed argv[++i] as the value, which swallowed the
// next flag in the canonical `--require-prestaged --bundled-toolchain-
// dir /tmp/x` form documented in the bundles/archives README.

export interface CliArgs {
  cmd: string
  flags: Map<string, string>
  /** Repeatable flags (currently --browser-mcp-arg) collected as arrays. */
  repeatableFlags: Map<string, string[]>
}

/**
 * Flags that may be supplied multiple times and should be collected as an
 * array. Anything not in this set defaults to single-value semantics with
 * last-write-wins.
 */
const REPEATABLE_FLAGS = new Set(["browser-mcp-arg"])

export function parseArgs(argv: string[]): CliArgs {
  const cmd = argv[0] ?? "run"
  const flags = new Map<string, string>()
  const repeatableFlags = new Map<string, string[]>()
  for (let i = 1; i < argv.length; i++) {
    const tok = argv[i]
    if (!tok.startsWith("--")) continue
    const eq = tok.indexOf("=")
    let name: string
    let value: string
    if (eq > 0) {
      name = tok.slice(2, eq)
      value = tok.slice(eq + 1)
    } else {
      name = tok.slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith("--")) {
        value = "true"
      } else {
        value = next
        i++
      }
    }
    if (REPEATABLE_FLAGS.has(name)) {
      const arr = repeatableFlags.get(name) ?? []
      arr.push(value)
      repeatableFlags.set(name, arr)
    } else {
      flags.set(name, value)
    }
  }
  return { cmd, flags, repeatableFlags }
}

export function getFlag(
  flags: Map<string, string>,
  name: string,
  fallback?: string
): string | undefined {
  const v = flags.get(name)
  if (v !== undefined) return v
  return fallback
}
