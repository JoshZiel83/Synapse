import type {
  CanonicalArchiveChainScope,
  CanonicalArchiveFrame,
  CanonicalArchivePoint,
} from "@synapse/shared"
import { serializeInstant } from "../../infrastructure/datetime.js"

/**
 * Structural shape of a context_archive_points row needed to present a
 * CanonicalArchivePoint. Kept structural (not a TableRow) so this presenter
 * stays free of generated/db imports.
 */
export type ArchivePointRecord = {
  id: string
  chain_scope: CanonicalArchiveChainScope
  conversation_id: string
  session_id: string | null
  parent_archive_point_id: string | null
  covers_until_sequence: number | string | null
  metadata?: Record<string, unknown>
  created_at: Date
}

/**
 * Shapes a persisted archive-point record plus its already-built frames into
 * the wire/canonical CanonicalArchivePoint DTO.
 */
export function presentArchivePoint(
  record: ArchivePointRecord,
  frames: CanonicalArchiveFrame[]
): CanonicalArchivePoint {
  return {
    archivePointId: record.id,
    chainScope: record.chain_scope,
    conversationId: record.conversation_id,
    sessionId: record.session_id || undefined,
    parentArchivePointId: record.parent_archive_point_id || undefined,
    coversUntilSequence: Number(record.covers_until_sequence || 0),
    frames,
    metadata: record.metadata,
    createdAt: serializeInstant(record.created_at),
  }
}
