/**
 * Contract test for the generic re-enable SQL shape.
 *
 * The QQ branch originally shipped this under
 * `buildReEnableAutoDisabledQqWebhookBindingsSql` — purely
 * QQ-specific naming. Shared prep promotes the helper to a
 * transport-neutral builder (`buildReEnableAutoDisabledBindingsSql`)
 * driven by the `reason` marker passed in. This test pins the SQL
 * contract so a future refactor can't silently:
 *   - forget to remove the `autoDisabledReason` marker (would let a
 *     manually-disabled binding get re-enabled on the next recovery
 *     cycle);
 *   - drop the per-workspace filter (cross-workspace leak);
 *   - swap the IS NOT DISTINCT FROM check for `=` (NULL handling
 *     diverges and certain edges stop matching).
 *
 * Stays compilation-only — no Postgres connection required.
 */

import test from "node:test"
import assert from "node:assert/strict"
import { buildReEnableAutoDisabledBindingsSql } from "./recovery.js"

test("buildReEnableAutoDisabledBindingsSql sets outbound_enabled = TRUE", () => {
  const q = buildReEnableAutoDisabledBindingsSql({
    workspaceId: "ws-1",
    reason: "webhook_inbound_unavailable",
  })
  assert.match(q.sql, /set\b.*"outbound_enabled"\s*=\s*\$/i)
  // Param order in Kysely's compiled output: outbound_enabled = $1,
  // workspaceId = $2, reason = $3. Assert by value rather than index
  // so a reordering of WHERE clauses doesn't false-positive.
  assert.ok(
    q.parameters.includes(true),
    `expected outbound_enabled=true parameter (got ${JSON.stringify(q.parameters)})`
  )
})

test("buildReEnableAutoDisabledBindingsSql removes the autoDisabledReason marker", () => {
  const q = buildReEnableAutoDisabledBindingsSql({
    workspaceId: "ws-1",
    reason: "webhook_inbound_unavailable",
  })
  assert.match(
    q.sql,
    /metadata\s*-\s*'autoDisabledReason'/i,
    "must remove the marker via jsonb `-` operator"
  )
})

test("buildReEnableAutoDisabledBindingsSql filters by workspace_id and matching reason", () => {
  const q = buildReEnableAutoDisabledBindingsSql({
    workspaceId: "ws-1",
    reason: "webhook_inbound_unavailable",
  })
  assert.match(q.sql, /where\b.*"workspace_id"\s*=\s*\$/i)
  assert.match(
    q.sql,
    /metadata->>'autoDisabledReason'.*IS\s+NOT\s+DISTINCT\s+FROM\s*\$/i,
    "must use IS NOT DISTINCT FROM so a NULL marker doesn't accidentally match"
  )
  // Reason parameter must be threaded through unchanged.
  assert.ok(
    q.parameters.includes("webhook_inbound_unavailable"),
    `reason parameter must reach the query (got ${JSON.stringify(q.parameters)})`
  )
  assert.ok(
    q.parameters.includes("ws-1"),
    `workspaceId parameter must reach the query (got ${JSON.stringify(q.parameters)})`
  )
})

test("buildReEnableAutoDisabledBindingsSql touches updated_at", () => {
  const q = buildReEnableAutoDisabledBindingsSql({
    workspaceId: "ws-1",
    reason: "webhook_inbound_unavailable",
  })
  assert.match(q.sql, /"updated_at"\s*=\s*NOW\(\)/i)
})
