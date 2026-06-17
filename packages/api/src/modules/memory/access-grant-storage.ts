/**
 * Compatibility facade for memory access-grant storage.
 *
 * SQL construction lives in repo-access-grants.ts; this file keeps existing
 * imports stable while staying outside the DB boundary.
 */
export {
  insertMemoryAccessGrant,
  listActiveMemoryAccessGrants,
  listSpaceLevelGrantSpaceIds,
  memoryGrantMatches,
  revokeMemoryAccessGrant,
} from "./repo-access-grants.js"
export type {
  InsertMemoryAccessGrantInput,
  MemoryAccessGrantRow,
} from "./repo-access-grants.js"
