// chat/presenter.ts — DTO/wire-shaping helpers for the chat module.
//
// presenter.ts is neither a service nor a controller, so it is the layer that
// is permitted to call serializeInstant / serializeOptionalInstant (see
// packages/api/scripts/guard-layering.mjs r3). service.ts shapes timestamps via
// the thin wrappers below instead of touching the infra serializers directly.
//
// This file must not import generated/db or use Kysely table-row types; it
// takes row values structurally.

import {
  serializeInstant,
  serializeOptionalInstant,
  type IsoInstantString,
} from "../../infrastructure/datetime.js"

/** Present a stored instant as an ISO timestamp for the wire DTO. */
export function presentInstant(value: Date): IsoInstantString {
  return serializeInstant(value)
}

/** Present a nullable stored instant as an optional ISO timestamp. */
export function presentOptionalInstant(
  value: Date | null | undefined
): IsoInstantString | undefined {
  return serializeOptionalInstant(value)
}
