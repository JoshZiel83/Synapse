/**
 * Compile-time parity assertions: hand-written `*View` types (types/index.ts)
 * vs their independently-defined response zod schemas.
 *
 * These pairs are maintained SEPARATELY — the schema is the wire boundary
 * (sendData → schema.parse), the hand-written type is what web/mobile import —
 * so they can silently drift. That drift caused real client-facing bugs (a
 * response could carry a value the client type forbade); see the 2026-06-25
 * contract-drift fix. Runtime presenter→parse tests cannot catch a type≡schema
 * mismatch, so we assert it at the type level here.
 *
 * This file is COMPILED by tsconfig.build.json (it is NOT a *.test.ts, which the
 * build excludes), so any future drift turns `Expect<false>` into a type error
 * and fails `npm run build:shared` — and therefore every downstream typecheck.
 *
 * To extend: add a pair whenever a hand-written View type pairs with a z.object
 * schema. Types already defined as `z.infer<typeof Schema>` cannot drift and
 * need no entry here.
 */
import { z } from "zod"
import {
  ActorAccessRequestViewSchema,
  ConversationPresentationViewSchema,
  ConversationSummaryViewSchema,
  FriendRequestViewSchema,
  RemoteAgentAccessRequestViewSchema,
} from "./schemas/relationship.js"
import type {
  FileOriginSummaryView,
  FileRecordViewSchemaType,
} from "./schemas/files.js"
import type {
  ActorAccessRequestView,
  ConversationPresentationView,
  ConversationSummaryView,
  FileOriginSummary,
  FileRecordView,
  FriendRequestView,
  RemoteAgentAccessRequestView,
} from "./types/index.js"

/** True iff A and B are exactly equal (member- and modifier-sensitive). */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false
/** Forces a compile error unless its argument resolves to exactly `true`. */
type Expect<T extends true> = T

// One assertion per hand-written View ↔ schema pair. A mismatch (added/removed
// field, optional vs required, nullable, widened enum→string) makes the
// corresponding `Expect<false>` a type error.

// relationship — RC2 (createdAt) + reverse drifts (canManageParticipants)
type _FriendRequestView = Expect<
  Equal<z.infer<typeof FriendRequestViewSchema>, FriendRequestView>
>
type _ActorAccessRequestView = Expect<
  Equal<z.infer<typeof ActorAccessRequestViewSchema>, ActorAccessRequestView>
>
type _RemoteAgentAccessRequestView = Expect<
  Equal<
    z.infer<typeof RemoteAgentAccessRequestViewSchema>,
    RemoteAgentAccessRequestView
  >
>
type _ConversationPresentationView = Expect<
  Equal<
    z.infer<typeof ConversationPresentationViewSchema>,
    ConversationPresentationView
  >
>
type _ConversationSummaryView = Expect<
  Equal<z.infer<typeof ConversationSummaryViewSchema>, ConversationSummaryView>
>

// files — RC3 (origin system enum widening)
type _FileOriginSummary = Expect<
  Equal<FileOriginSummaryView, FileOriginSummary>
>
type _FileRecordView = Expect<Equal<FileRecordViewSchemaType, FileRecordView>>

export {}
