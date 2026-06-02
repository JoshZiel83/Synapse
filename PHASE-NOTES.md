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

## Phase 8 note (shared SW flush helper)

- Added flushOutboxQueue(state, {send, now, failureMessage}) to @synapse/shared/chat-queue —
  the near-verbatim SW outbox flush loop (optimisticSequence order; attempt bump; success delete;
  failure -> retrying + sticky firstFailedAt + break). Platform bits (fetch transport, clock,
  locale error string) injected.
- Both SWs (web-chat-service-worker.ts, mobile chat-service-worker.ts) now call flushOutboxQueue
  via the @synapse/shared/chat-queue (web) / @shared/chat-queue (mobile) subpath, replacing their
  duplicated loops (~75 lines each removed).
- GOTCHA: the api regression suite (sw-constants-shared.test.ts) asserts CHAT*QUEUE*\* CONSTANTS are
  imported from the bare barrel "@synapse/shared"/"@shared" in chat-persistence.ts /
  chat-web-queue-storage.ts. So those CONSTANT imports stay on the barrel (the zod-no-leak test
  already proves the barrel is zod-free today); only the flush helper uses the subpath.
- Verification order followed: build:chat-worker (both) + commit regenerated bundles, THEN
  npm test (regression) — 8/8, no zod in bundles.

## Phase 9 note (react-query on mobile)

- Added @tanstack/react-query 5.100 to mobile (separate install; react 19.1 peer OK; no zod).
- src/providers/query-provider.tsx (lazy-init client, ApiError-aware retry) mounted at the top of
  AppProviders (above Session/Workspace/Chat).
- src/lib/query-keys.ts (workspace-rooted factory).
- Migrated pilots: contacts-tab-screen (simple read), search.tsx (contact-hub + identity-search
  keyed query with placeholderData=keep-previous for search-as-you-type).
- ChatRuntime/chat realtime store intentionally NOT behind react-query (live mutable store).

DEFERRED (mechanical, same recipe): discover.tsx, contacts/requests.tsx (has approve/reject
mutations), home-tab actors fetch, workspace-entity-picker-screen. Migrate incrementally.

## Phase 10 note (FlashList)

- Added @shopify/flash-list 2.0.2 (expo install; SDK 54 compatible, Expo Go OK).
- 10a DONE: inbox virtualized. conversation-list.tsx now exports:
  - ConversationListView — FlashList that OWNS the scroll (header/empty/refresh injected)
  - ConversationList — back-compat: maxItems -> capped non-scrolling stack (home, 3 items);
    otherwise FlashList. home-tab (maxItems=3) unchanged; chats-tab uses ConversationListView,
    removed its wrapping ScrollView so FlashList owns scrolling.
- 10b DEFERRED (chat message list app/chat/[conversationId].tsx): behavior-dense + chat-critical
  (scrollRef.scrollToEnd, appendedAtTail auto-scroll, onScroll at-bottom mark-read, load-older
  button needing maintainVisibleContentPosition, interleaved footer ActorActivityBubble nodes in a
  non-inverted list). FlashList scrollToEnd is unreliable with variable heights; converting safely
  needs careful manual testing on device with no integration tests. Left on ScrollView; tracked.

## Phase 10.5 note (alphabet list -> FlashList + shared pinyin)

- New @synapse/shared/pinyin (pure, off-barrel): getAlphabetInitial / comparePinyin /
  PINYIN_INITIAL_BOUNDARIES / ALPHABET_RAIL. 5 tsx --test cases pinning only ASCII / "#" / empty
  paths + asserting representative hanzi land on a real rail letter (ICU-data-independent).
  shared suite 130 -> 135 green.
- alphabet-indexed-entity-list.tsx rewritten on FlashList: flattened header/item rows, getItemType
  recycling, stickyHeaderIndices sticky headers, rail drives scrollToIndex (thin PanResponder maps
  touch-Y -> letter), pinyin bucketing imported from @shared/pinyin. Domain pinyin table preserved
  (now in shared, tested).

## Phase 11 note (web landing scroll-snap + react-virtual)

- 11a DONE: replaced the 212-line wheel-hijack snap engine with native CSS scroll-snap.
  globals.css: html.landing-snap-root { scroll-snap-type: y mandatory } + .landing-snap-section
  { scroll-snap-align: start; scroll-snap-stop: always }, gated to the same
  (min-width:1024)(pointer:fine)(min-height:1000) viewport and DISABLED under
  prefers-reduced-motion. landing-snap-scroll-controller.tsx slimmed 212 -> 90 LOC: now only
  toggles the landing-snap-root class on <html> and keeps an ArrowUp/ArrowDown keyboard-nav island
  (CSS snap doesn't cover keyboard). Wheel-hijack (an a11y hazard) removed.
- 11b DEFERRED (web chat list virtualization, @tanstack/react-virtual on conversation-chat.tsx):
  same risk profile as mobile 10b — load-older prepend scroll-anchoring (scrollHeight-delta math),
  auto-scroll-to-bottom, jump button, footer ActorActivityBubble nodes, bottom sentinel. Variable-
  height prepend anchoring is the single riskiest item in the plan; no integration tests. Not
  installed/started; tracked for a focused, manually-tested follow-up.

## Phase 12 note (mobile katex swap + local assets)

- 12a DONE: markdown-it-katex@2.0.3 (deprecated, ~9 yrs stale, needed a hand-written .d.ts shim)
  -> @vscode/markdown-it-katex@1.1.2 (maintained; ships its own types). chat-markdown-html.ts import
  swapped (default export, no `as never` cast); deleted src/types/markdown-it-katex.d.ts; removed the
  old dep. Mobile typecheck PASS.
- 12b DEFERRED (CDN -> local KaTeX CSS/fonts + twemoji assets in chat-markdown-dom.tsx /
  file-preview-dom.tsx): these are Expo DOM (`"use dom"`) WebView components; serving katex.min.css
  - its fonts and twemoji SVGs from a local origin inside the webview is fiddly asset-pipeline work
    that must be verified on-device (getting it wrong silently breaks math/emoji rendering). The CDN
    path works today (only breaks fully offline). Tracked for a device-tested follow-up. Note katex
    CSS is pinned to 0.16.44 matching the installed katex dep.

## Phase 13 note (NativeWind v4 + dark mode)

- 13a DONE (config spike, fully verified): nativewind 4.2.4 + tailwindcss 3.4.19 installed in mobile
  (reanimated 4.1.7 peer already present). Created babel.config.js (preset-expo jsxImportSource:
  nativewind + nativewind/babel), tailwind.config.js (nativewind preset, darkMode:"class", content
  globs for app/+src/, Expo DOM components intentionally excluded), global.css, nativewind-env.d.ts.
  WRAPPED the existing metro.config.js with withNativeWind PRESERVING watchFolders/blockList/
  nodeModulesPaths (the workspace resolver). Imported ../global.css in app/\_layout.tsx; added
  nativewind-env.d.ts to tsconfig.
  ACCEPTANCE PASSED: mobile typecheck PASS; `expo export --platform web` bundles ALL routes with the
  NativeWind transform active and @synapse/shared/@shared resolving through the wrapped Metro config
  (the riskiest config step is proven end-to-end).
- 13b DONE: tailwind.config.js derives the color palette from src/theme/tokens.ts and adds a dark
  variant (color.DEFAULT / color.dark) so `dark:` utilities are available. The StyleSheet `theme`
  object remains the source of truth during migration (compatibility — both coexist).
- 13c/13d DEFERRED (tracked): converting the 675-line ui.tsx primitives + ~24 themed screens from
  StyleSheet(theme.colors.\*) to className/`dark:`, and wiring navigation theme + StatusBar to
  useColorScheme. This is a large visual surface with NO automated visual/integration tests;
  doing it blind risks regressing the entire mobile UI. The toolchain is in place and proven, so
  this is now safe incremental per-file work that MUST be verified on-device in light + dark. Recipe:
  replace StyleSheet color refs with className="bg-surface dark:bg-surface-dark text-text
  dark:text-text-dark ..." per component; flip navigationTheme.dark + StatusBar via useColorScheme.
