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
