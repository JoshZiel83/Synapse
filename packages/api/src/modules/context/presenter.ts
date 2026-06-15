import type {
  CanonicalArchiveChainScope,
  CanonicalArchiveFrame,
  CanonicalArchivePoint,
} from "@synapse/shared"
import { serializeInstant } from "../../infrastructure/datetime.js"

/**
 * Repo-normalized archive point record needed to present a
 * CanonicalArchivePoint. Kept structural (not a TableRow) so this presenter
 * stays free of generated/db imports and DB column names.
 */
export type ArchivePointRecord = {
  id: string
  chainScope: CanonicalArchiveChainScope
  conversationId: string
  sessionId: string | null
  parentArchivePointId: string | null
  coversUntilSequence: number | string | null
  metadata?: Record<string, unknown>
  createdAt: Date
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
    chainScope: record.chainScope,
    conversationId: record.conversationId,
    sessionId: record.sessionId || undefined,
    parentArchivePointId: record.parentArchivePointId || undefined,
    coversUntilSequence: Number(record.coversUntilSequence || 0),
    frames,
    metadata: record.metadata,
    createdAt: serializeInstant(record.createdAt),
  }
}
