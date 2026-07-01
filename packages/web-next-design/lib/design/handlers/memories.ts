import {
  MemoryListViewSchema,
  MemoryItemEnvelopeViewSchema,
  MemoryMoveResultViewSchema,
} from "@synapse/shared/schemas"
import { mock } from "../faker-setup"
import type { DesignHandlers } from "./_types"

// Memory items: list / detail / create / update / move. These feed the memory
// space pages. `deleteMemory` returns the raw fetch Response (no view DTO), so
// it is left to the Proxy catch-all.
export const memoriesHandlers = {
  getMemories: async () => mock(MemoryListViewSchema),
  getMemory: async () => mock(MemoryItemEnvelopeViewSchema),
  createMemory: async () => mock(MemoryItemEnvelopeViewSchema),
  updateMemory: async () => mock(MemoryItemEnvelopeViewSchema),
  moveMemory: async () => mock(MemoryMoveResultViewSchema),
} satisfies DesignHandlers
