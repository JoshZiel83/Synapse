// Boot-time embedding-space consistency guard. The "one active embedding space"
// invariant (all stored vectors share model + dimension + cosine + normalization)
// is not enforceable by the type system, so we fail LOUD at startup rather than let
// a misconfigured deploy silently corrupt recall.
//
// Lives in the memory module (memory owns the vector columns; memory → embedding is
// the correct dependency direction) and reads the DB through the memory repo layer.
// Two checks, only when a real provider is selected (skipped for "none"):
//   1. BOTH fixed-width vector columns' pgvector typmod === provider.dimension. A
//      DDL/config drift (e.g. an un-migrated vector(384) column vs a 1024-d
//      provider) would otherwise let every embed pass and then fail the facade
//      shape-check → permanently lexical with no boot failure.
//   2. No foreign-space rows: existing memory indexed by a DIFFERENT engineVersion
//      (a same-dimension model swap) would mix geometrically incomparable vectors
//      in the one HNSW graph and return garbage while reporting healthy.

import { resolveEmbeddingProvider } from "../embedding/index.js"
import {
  findForeignEmbeddingSpaceModel,
  loadMemoryVectorColumnDimensions,
} from "./repo.js"

const RUNBOOK = "docs/embedding-abstraction-layer-plan-2026-07-02.md §5"

export async function assertEmbeddingSpaceConsistent(): Promise<void> {
  const provider = resolveEmbeddingProvider()
  if (provider.key === "none") return

  const dimension = provider.dimension

  const columns = await loadMemoryVectorColumnDimensions()
  for (const column of columns) {
    if (column.typmod !== dimension) {
      const actual = column.typmod < 0 ? "unconstrained" : String(column.typmod)
      throw new Error(
        `[embedding] dimension mismatch: ${column.tableName}.embedding is vector(${actual}) ` +
          `but EMBEDDING_PROVIDER=${provider.key} emits ${dimension}-d vectors. ` +
          `Run the re-embed migration (${RUNBOOK}) before booting.`
      )
    }
  }

  const foreign = await findForeignEmbeddingSpaceModel(provider.engineVersion)
  if (foreign) {
    throw new Error(
      `[embedding] space mismatch: existing memory was indexed by "${foreign}" ` +
        `but the active provider yields "${provider.engineVersion}". Re-embed ` +
        `(${RUNBOOK}) or restore the prior provider before booting — mixing spaces ` +
        `silently corrupts recall.`
    )
  }
}
