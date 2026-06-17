/**
 * Shared helpers for the IM service layer.
 *
 * Extracted from service.ts as part of the per-domain split. Service.ts
 * keeps imports stable by re-exporting any of these that the public API
 * touched; service/<domain>.ts files import them directly.
 *
 * No business logic — only cross-cutting string helpers used by multiple
 * domain groups.
 *
 * Row normalizers (DB row → shared/types shape) live in ./repo.ts and are
 * re-exported here so existing importers keep working unchanged.
 */

export {
  normalizeAccountRow,
  normalizeEndpointRow,
  normalizeBindingRow,
  normalizeTransportSessionRow,
  normalizeTransportExternalUserRow,
  normalizeTransportMessageLinkRow,
} from "./repo.js"

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
