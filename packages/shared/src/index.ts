export * from "./types/index.js"
export * from "./constants/index.js"
// Runtime helpers migrated out of types/index.ts (§2.2.1). types/* is now a
// pure type surface; these subpaths own the runtime and are re-exported here so
// existing `@synapse/shared` value imports keep working unchanged.
export * from "./content/index.js"
export * from "./actor/index.js"
export * from "./conversation/index.js"
export * from "./work-item/index.js"
// Re-export only the bundle-safe matcher helpers (no zod, no node imports).
// The zod-backed Schema objects stay accessible via `@synapse/shared/schemas`
// or `@synapse/shared/access/policies`.
export {
  filesystemPolicyAllows,
  commandlinePolicyAllows,
  cuaPolicyAllows,
  browserPolicyAllows,
  ptyPolicyAllows,
  normalizePathPrefix,
  normalizeCommandText,
  hasCompoundShellOperators,
  commandPrefixMatches,
  pathWithinPrefix,
  normalizeFilesystemPolicy,
} from "./access/policies/matchers.js"
export type {
  FilesystemPolicyShape,
  NormalizedFilesystemPolicy,
  CommandlinePolicyShape,
  CommandlineShellPolicyShape,
  CommandlineExecFilePolicyShape,
  CommandlineMatchRequest,
  NormalizedCommandlinePolicy,
  CuaPolicyShape,
  BrowserPolicyShape,
  PtyPolicyShape,
} from "./access/policies/matchers.js"
export {
  BUNDLE_ELIGIBLE_PROGRAMS,
  BUNDLE_PROGRAM_PLATFORMS,
  BUNDLE_PROGRAM_PLATFORM_KEYS,
  isBareCommandName,
  isBundleAvailableForPlatform,
  isBundleEligibleProgram,
  normalizeDevicePlatform,
  normalizeProgramName,
  programNameAliases,
} from "./access/policies/commandline-normalize.js"
export type { NormalizedDevicePlatform } from "./access/policies/commandline-normalize.js"
export * from "./utils/index.js"
export * from "./automation/index.js"
export * from "./access/index.js"
export {
  WORKSPACE_RESOURCE_KIND,
  WORKSPACE_RESOURCE_KINDS,
  WORKSPACE_RESOURCE_STATUS,
  WORKSPACE_RESOURCE_STATUSES,
  WORKSPACE_RESOURCE_GRANT_PERMISSION,
  WORKSPACE_RESOURCE_GRANT_PERMISSIONS,
  WORKSPACE_RESOURCE_GRANT_STATUS,
  WORKSPACE_RESOURCE_GRANT_STATUSES,
  WORKSPACE_RESOURCE_GRANT_SOURCE,
  WORKSPACE_RESOURCE_GRANT_SOURCES,
  WORKSPACE_RESOURCE_GRANT_REQUEST_STATUS,
  WORKSPACE_RESOURCE_GRANT_REQUEST_STATUSES,
  WORKSPACE_RESOURCE_GRANT_REQUEST_DIRECTION,
  WORKSPACE_RESOURCE_GRANT_REQUEST_DIRECTIONS,
} from "./access/enums.js"
export type {
  WorkspaceResourceGrantPermission,
  WorkspaceResourceGrantRequestDirection,
  WorkspaceResourceGrantRequestStatus,
  WorkspaceResourceGrantSource,
  WorkspaceResourceGrantStatus,
  WorkspaceResourceKind,
  WorkspaceResourceStatus,
} from "./access/enums.js"
export * from "./chat-catalog/index.js"
export * from "./chat-queue/index.js"
// Tool provenance & routing (Layer A/B primitives).
export * from "./tool-source/index.js"
// Tool-call presentation strings are part of the app-facing shared contract.
// Descriptor authoring/parsing remains owned by runtime/API descriptor code.
export {
  resolvePresentation,
  type PresentationString,
} from "./tool-presentation/index.js"
// NOTE: ./schemas is NOT re-exported from the root barrel on purpose.
// schemas/* pulls in zod, and the chat service workers (web + mobile)
// transitively reach the root barrel via @synapse/shared / @shared
// imports. Including zod in the SW bundle would bloat each pre-built
// worker by ~150kB. Consumers that need the zod schemas import via the
// dedicated subpath: `@synapse/shared/schemas` (web) or
// `@shared/schemas` (mobile).
