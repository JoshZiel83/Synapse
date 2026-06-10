/**
 * Shared helpers for the IM service layer.
 *
 * Extracted from service.ts as part of the per-domain split. Service.ts
 * keeps imports stable by re-exporting any of these that the public API
 * touched; service/<domain>.ts files import them directly.
 *
 * No business logic — only:
 *   - JSON / string parsing
 *   - cross-cutting assertions used by multiple domain groups
 *
 * Row normalizers (DB row → shared/types shape) live in ./repo.ts and are
 * re-exported here so existing importers keep working unchanged.
 */

import { parseJsonObject } from "@synapse/shared"

export { parseJsonObject }

export {
  normalizeAccountRow,
  normalizeEndpointRow,
  normalizeBindingRow,
  normalizeTransportSessionRow,
  normalizeTransportExternalUserRow,
  normalizeTransportMessageLinkRow,
} from "./repo.js"

export function parseJsonArray<T>(value: unknown): T[] {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown
      return Array.isArray(parsed) ? (parsed as T[]) : []
    } catch {
      return []
    }
  }
  return Array.isArray(value) ? (value as T[]) : []
}

export function readTrimmedString(
  value: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const entry = value[key]
    if (typeof entry === "string" && entry.trim()) {
      return entry.trim()
    }
  }
  return undefined
}
