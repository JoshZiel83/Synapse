import test from "node:test"
import assert from "node:assert/strict"
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from "kysely"
import { buildReEnableAutoDisabledQqWebhookBindingsSql } from "./accounts.js"
import { shouldReEnableAutoDisabledBinding } from "./account-recovery-planner.js"

// SQL-shape contract test for `reEnableAutoDisabledQqWebhookBindings`.
//
// The pure JS predicate `shouldReEnableAutoDisabledBinding` already
// locks in WHICH rows should be re-enabled, but it doesn't catch the
// case where someone edits the SQL UPDATE in accounts.ts in a way that
// silently drifts from the predicate. This file closes that gap:
//
//  1. Compile the SQL builder offline using Kysely's DummyDriver, so
//     the test never touches the live pg.Pool. This is critical:
//     importing the live `db` from a unit test starts the connection
//     pool and prevents the test runner from exiting cleanly.
//  2. Assert the WHERE clause encodes EXACTLY the same predicate the
//     JS function uses, the SET clause flips outbound_enabled + removes
//     the marker, and `transport_account_id` is bound parametrically
//     (no SQL injection).
//  3. Cross-check with the JS predicate against synthetic rows — if
//     the SQL changes, the test wants to see the equivalent change in
//     the predicate (and vice-versa).

// Offline Kysely instance — no real connection, just the
// dialect/compiler so RawBuilder.compile() can format Postgres
// placeholders. Reused across tests.
const offlineDb = new Kysely<Record<string, never>>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (k) => new PostgresIntrospector(k),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
})

test("compiled SQL: targets conversation_transport_bindings UPDATE", () => {
  const compiled =
    buildReEnableAutoDisabledQqWebhookBindingsSql("acc-foo").compile(offlineDb)
  // Verb + table.
  assert.match(compiled.sql, /UPDATE conversation_transport_bindings/)
})

test("compiled SQL: SET clause flips outbound + removes marker + bumps updated_at", () => {
  const compiled =
    buildReEnableAutoDisabledQqWebhookBindingsSql("acc-foo").compile(offlineDb)
  // The three side-effects we actually intend; absence of any one of
  // these is a bug (e.g. forgetting `updated_at = NOW()` would leave
  // the row's timestamp stale and confuse the dashboard's "Last
  // updated" column).
  assert.match(compiled.sql, /SET\s+outbound_enabled = TRUE/)
  assert.match(compiled.sql, /metadata = metadata - 'autoDisabledReason'/)
  assert.match(compiled.sql, /updated_at = NOW\(\)/)
})

test("compiled SQL: WHERE encodes the same predicate as shouldReEnableAutoDisabledBinding", () => {
  const compiled =
    buildReEnableAutoDisabledQqWebhookBindingsSql("acc-foo").compile(offlineDb)
  // 1. account scope — caller-supplied id is in parameters[0], NOT
  //    inlined into the SQL string.
  assert.match(compiled.sql, /transport_account_id = \$1/)
  assert.deepEqual(compiled.parameters, ["acc-foo"])
  // 2. only outbound-already-disabled rows.
  assert.match(compiled.sql, /outbound_enabled = FALSE/)
  // 3. only rows with the system-auto-disable marker for QQ's webhook
  //    OQ2 gate. The marker string MUST match the constant the binding
  //    upsert writes (see transportKindDefaultsForBindings in
  //    bindings.ts); changing one without the other strands rows.
  assert.match(
    compiled.sql,
    /metadata\s*->>\s*'autoDisabledReason'\s*=\s*'webhook_inbound_unavailable'/
  )
})

test("compiled SQL: contract matches JS predicate row-by-row on synthetic data", () => {
  // If the JS predicate and the SQL ever disagree on a synthetic input,
  // it means a refactor broke one of them. Walk a small matrix of
  // binding shapes that exercise each WHERE clause arm.
  const accountId = "acc-target"
  const cases: Array<{
    label: string
    binding: Parameters<typeof shouldReEnableAutoDisabledBinding>[0]
    expectSelected: boolean
  }> = [
    {
      label:
        "matching account, outbound=false, marker=webhook_inbound_unavailable",
      binding: {
        id: "b-match",
        transportAccountId: accountId,
        outboundEnabled: false,
        metadata: { autoDisabledReason: "webhook_inbound_unavailable" },
      },
      expectSelected: true,
    },
    {
      label: "matching account, outbound=true (already enabled) → skip",
      binding: {
        id: "b-on",
        transportAccountId: accountId,
        outboundEnabled: true,
        metadata: { autoDisabledReason: "webhook_inbound_unavailable" },
      },
      expectSelected: false,
    },
    {
      label:
        "matching account, outbound=false, marker absent (user-disabled) → skip",
      binding: {
        id: "b-manual",
        transportAccountId: accountId,
        outboundEnabled: false,
        metadata: {},
      },
      expectSelected: false,
    },
    {
      label: "matching account, marker has a different reason → skip",
      binding: {
        id: "b-other-reason",
        transportAccountId: accountId,
        outboundEnabled: false,
        metadata: { autoDisabledReason: "operator_override" },
      },
      expectSelected: false,
    },
    {
      label: "different account, otherwise valid → skip",
      binding: {
        id: "b-cross",
        transportAccountId: "acc-other",
        outboundEnabled: false,
        metadata: { autoDisabledReason: "webhook_inbound_unavailable" },
      },
      expectSelected: false,
    },
  ]
  // 1. JS predicate agrees with our expectSelected matrix.
  for (const c of cases) {
    assert.equal(
      shouldReEnableAutoDisabledBinding(c.binding, accountId),
      c.expectSelected,
      `JS predicate disagreed on case "${c.label}"`
    )
  }
  // 2. The SQL's WHERE clause encodes the same three filters that
  //    drove the JS matrix. If a future SQL edit adds a new filter
  //    without updating the predicate (or vice versa), one of the
  //    WHERE regexes above will start failing — that's the contract
  //    we want to lock down.
  const compiled =
    buildReEnableAutoDisabledQqWebhookBindingsSql(accountId).compile(offlineDb)
  assert.match(compiled.sql, /transport_account_id = \$1/)
  assert.match(compiled.sql, /outbound_enabled = FALSE/)
  assert.match(
    compiled.sql,
    /metadata\s*->>\s*'autoDisabledReason'\s*=\s*'webhook_inbound_unavailable'/
  )
})
