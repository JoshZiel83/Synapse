# FE Modernization — Phase Notes & Baseline (off dev 209cf7f)

## Verification gates (per plan)

- **W** web: `npm run typecheck -w packages/web-next` + `npm run build -w packages/web-next`
- **M** mobile: `cd packages/mobile-app && npm run typecheck`
- **S** shared: `npm run build:device-protocol && npm run build:shared` then `npm test -w packages/shared`
- **SW regression**: `npx tsx --test packages/api/src/test/regression/sw-constants-shared.test.ts`

## Phase 0 baseline (2026-06-01) — frontend-relevant: GREEN

- web typecheck: PASS
- web build (`next build --webpack`): PASS (eslint does NOT block build)
- mobile typecheck: PASS
- shared build (needs device-protocol built first): PASS; shared tests 97/97 PASS
- SW-constants-shared regression: 8/8 PASS (incl. zod-no-leak + regenerate-no-diff)

## KNOWN PRE-EXISTING ISSUES (reproduce on untouched Synapse-dev; NOT caused by this work)

1. **`npm run lint` is environmentally broken**: a Debian system eslint at
   `/usr/share/nodejs/eslint` (no `exports` map) shadows the local eslint@9.39.4
   because `@typescript-eslint/utils` is hoisted to ROOT node_modules but there is
   NO eslint at root. `require('eslint/use-at-your-own-risk')` then fails.
   - Workaround to actually RUN lint: `ln -s ../packages/web-next/node_modules/eslint node_modules/eslint`
     (temporary, untracked; lost on reinstall). DO NOT rely on lint as a hard gate.
   - Once it runs, there are **133 pre-existing `no-explicit-any` errors** at baseline.
   - STRATEGY: use typecheck + build as hard web gates; treat lint as advisory
     (only ensure we don't ADD new errors).
2. **`npm test -w packages/api` has 6 pre-existing failures**: `authenticateDeviceHello`
   tests fail with Postgres `28P01 password authentication failed for user "synapse"`
   (no DB provisioned). Environmental, unrelated to frontend. The SW regression subset
   (our Phase 8 gate) passes — run it directly via tsx, not the whole api suite.

## Build ordering reminder

- shared depends on device-protocol: run `npm run build:device-protocol` before `build:shared`.
- web does NOT auto-rebuild shared; mobile auto-runs `sync:shared` via pre\* hooks.

## Phase 0 note: mobile SW bundle comment path

- Because mobile-app is installed separately, esbuild now emits `// node_modules/idb/...`
  instead of the previously-committed `// ../../node_modules/idb/...` (comment-only, behavior identical).
- Committed the regenerated packages/mobile-app/public/chat-service-worker.js so the
  SW regenerate-no-diff regression passes against the current install topology.

## Phase 5 scope note (react-query mutations + polling)

Migrated to useQuery/invalidateQueries/optimistic setQueryData (covering every pattern):

- devices, audit, remote-agents (Phase 4 reads)
- event-sources (read + invalidate-on-mutate, selected-item + occurrences)
- triggers (same shape as event-sources)
- memory-browser (3-source parallel read + optimistic patchMemories via setQueryData)

DEFERRED (tracked continuation — pattern is proven, remaining work is mechanical repetition
with higher per-file risk; not done to avoid destabilizing auth/dialog/chat flows in one pass):

- ~34 more useEffect+api data-loaders: settings/_ (model-group-_, invite-management,
  access-management, actor-_), plugins/_ (install-dialog, \*-step, installations), contacts/
  contact-hub-client, dashboard-home, remote-agents/[id] detail pages, im/page, devices/[deviceId].
  Each follows the proven useQuery + invalidateQueries recipe; migrate incrementally.
- 4 polling loops INTENTIONALLY LEFT on their hand-rolled recursive setTimeout:
  web-qr-login-panel (auth!), sidebar-weixin-binding, im/page (dingtalk device-flow),
  plugins/install-dialog (per-field OAuth pollers). These are auth/OAuth-critical with
  interlocking finalize/dialog state; react-query refetchInterval is a marginal win there and
  the regression risk is high. Convert later with dedicated testing. (Per plan: "convert with
  care or leave last".)

## Phase 6 scope note (react-hook-form + zod)

- Added react-hook-form 7.77 + @hookform/resolvers 5.4 to web-next.
- KEY GOTCHA: @hookform/resolvers v5 `zodResolver` has a TYPE-LEVEL skew with zod 4.3.6
  (expects a different zod internal version) -> use `standardSchemaResolver` from
  `@hookform/resolvers/standard-schema` instead. zod 4 implements Standard Schema (`~standard`),
  so this is the clean, version-agnostic resolver. THIS IS THE CANONICAL PATTERN for all forms.
- Reusable bindings added at components/ui/form.tsx (Form/FormField/useFormFieldError) layered
  over the existing shadcn Field primitives (FieldError already takes Array<{message}>).
- Migrated: login-form (pilot), signup-form (shows cross-field zod .refine for password match).

DEFERRED (tracked continuation — recipe proven, mechanical per-form work): automation-rule-editor
(907 lines, single draft object + shared builder — the stress test), model-item-dialog,
model-group-dialog, actor-editor-sheet, memory-editor-page, plugin steps, etc. Each: define a zod
schema, useForm({resolver: standardSchemaResolver(schema)}), wrap inputs in Controller, surface
errors via FieldError. Migrate incrementally.

## Phase 7 scope note (chat reducer + outbox transitions)

Added PURE outbox state-machine transitions + conversation helpers to @synapse/shared/chat-state:

- markOutboxAttemptStarted / markOutboxDelivered / markOutboxFailed (clock + server item + error
  injected; no API, no platform) — extracted from the byte-parallel flush loops in mobile
  chat-runtime.ts and web chat-store.ts.
- updateConversationInState, buildItemPreviewText, toConversationLastItem.
- 3 new tsx --test cases (deterministic now; firstFailedAt sticky; delivered merges+updates lastItem);
  shared suite 127 -> 130 green.
- Wired mobile chat-runtime.ts to consume shared clearDeliveredOutbox + shouldIncrementUnreadCount
  (deleted local dupes).

DEFERRED (intentional, risk-bounded): the mobile/web flush LOOPS still call the class/zustand
shell (updateSnapshotForWorkspace / set) rather than being rewritten to thread the markOutbox\*
transitions, and web's chat-store leaf helpers are not yet repointed to shared. The pure transitions
are extracted, tested, and ready for incremental adoption; rewriting the live flush loops + web store
wholesale is high-risk on the chat data path with no integration tests, so it is staged rather than
done in one pass. Net Tier-2 win delivered: the chat merge/sort/upsert/outbox/unread logic now has a
single tested source of truth in shared, consumed by mobile.
