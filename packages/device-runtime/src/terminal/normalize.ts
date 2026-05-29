// Program-name normalization + alias helpers. Zod-free so they can move into
// @synapse/shared without forcing the root barrel to import zod (see plan
// §Phase 3: the shared file is `access/policies/commandline-normalize.ts`).
// During Commit 2 we host the implementation here; Commit 6 swaps this file
// for a re-export of the shared module without touching callers.

const ALIASES: Record<string, readonly string[]> = {
  python: ["python", "python3"],
  node: ["node", "nodejs"],
}

const REVERSE_ALIASES: Record<string, string> = {
  python3: "python",
  nodejs: "node",
}

export function normalizeProgramName(name: string): string {
  return REVERSE_ALIASES[name] ?? name
}

export function programNameAliases(normalizedName: string): readonly string[] {
  return ALIASES[normalizedName] ?? [normalizedName]
}

export function isBareCommandName(program: string): boolean {
  if (!program) return false
  if (program.startsWith("~")) return false
  if (program.includes("/") || program.includes("\\")) return false
  if (program.includes("..")) return false
  return true
}

export type NormalizedDevicePlatform = "win32" | "linux" | "darwin"

export function normalizeDevicePlatform(
  raw: string | null | undefined
): NormalizedDevicePlatform | undefined {
  if (!raw) return undefined
  const lowered = raw.toLowerCase()
  if (lowered === "win32" || lowered === "windows") return "win32"
  if (lowered === "darwin" || lowered === "mac" || lowered === "macos") {
    return "darwin"
  }
  if (lowered === "linux") return "linux"
  // freebsd / openbsd / sunos / aix etc -> treated as unknown, callers
  // should not run Windows-specific guards.
  return undefined
}
