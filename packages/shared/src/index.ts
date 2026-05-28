export * from "./types/index.js"
export * from "./constants/index.js"
// Re-export only the bundle-safe matcher helpers (no zod, no node imports).
// The zod-backed Schema objects stay accessible via `@synapse/shared/schemas`.
export {
  filesystemPolicyAllows,
  commandlinePolicyAllows,
  cuaPolicyAllows,
  browserPolicyAllows,
  normalizePathPrefix,
  normalizeCommandText,
  hasCompoundShellOperators,
  commandPrefixMatches,
  pathWithinPrefix,
  normalizeFilesystemPolicy,
} from "./access/policies/matchers.js"
export * from "./utils/index.js"
export * from "./automation/index.js"
export * from "./access/index.js"
export * from "./chat-catalog/index.js"
export * from "./chat-queue/index.js"
// NOTE: ./schemas is NOT re-exported from the root barrel on purpose.
// schemas/* pulls in zod, and the chat service workers (web + mobile)
// transitively reach the root barrel via @synapse/shared / @shared
// imports. Including zod in the SW bundle would bloat each pre-built
// worker by ~150kB. Consumers that need the zod schemas import via the
// dedicated subpath: `@synapse/shared/schemas` (web) or
// `@shared/schemas` (mobile).
