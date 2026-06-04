# Integration tests for the API package

End-to-end tests that exercise the full MCP / device / canonical-content
pipeline against an isolated stack — separate postgres, redis, and (when
needed) a separate API container, all under a **per-worktree** docker
compose project so multiple worktrees can run their stacks concurrently
without colliding.

This is the **default** integration test stack for `@synapse/api`.
`npm run test:integration -w packages/api` brings the stack up, runs every
`*.test.ts` in this directory (NOT in `manual/`) through
`scripts/run-integration.sh`, and tears the stack down again — leaving
nothing behind. There is no staging / external-API mode in the default
path; the prior `STAGING_API_URL` black-box harness was removed because the
new isolated stack covers the same coverage area without depending on a
deployed environment.

## What's in here

```
docker-compose.test.yaml         # isolated postgres + redis (per-worktree ports)
docker-compose.prod.yaml         # docker rebuild of the production API
                                 # (AGENTS.md backend-update gate)
scripts/
  lib.sh                         # single source of truth: derives per-worktree
                                 # compose project name + 4 host ports from the
                                 # worktree path; `bash lib.sh --print` to inspect
  up.sh                          # bring up test postgres+redis (sources lib.sh)
  down.sh                        # tear down BOTH compose files + --remove-orphans
                                 # (default: -v deletes volumes; KEEP_VOLUMES=1 keeps)
  run-test.sh                    # wrapper that sets the derived DATABASE_URL/
                                 # REDIS_URL/BASE_URL + SYNAPSE_INT_TEST=1 in the
                                 # parent process before invoking node
  run-all.sh                     # serially invoke run-test.sh on every default
                                 # *.test.ts file (assumes the stack is already up)
  run-integration.sh             # owning wrapper for `npm run test:integration`:
                                 # up -> run-all -> down (trap-cleaned on any exit)
harness/
  api-process.ts                 # spawn API as tsx child process on the per-worktree
                                 # API port (derived from BASE_URL)
  chat-fixture.ts                # setupChatStack()/teardownChatStack() — common
                                 # `before/after` for HTTP/WS tests
  client.ts                      # ApiClient + registerTestUser + createTestWorkspace
                                 # (in-process replacement for the old
                                 # STAGING_API_URL setup.ts)
  db.ts                          # pg client + resetDb + seedMinimal
  http-server.ts                 # tiny mock HTTP server for image-url / plugin-remote mocks
  mock-llm.ts                    # testcontainers wrapper around mockserver/mockserver
                                 # for the LLM-endpoint provider/error tests below.
                                 # Per-file dynamic-port container; no impact on
                                 # docker-compose.test.yaml.
  index.ts                       # re-exports
mocks/
  mcp-servers/                   # 11 stdio MCP server variants
    text-only.mjs, image-base64.mjs, image-source-base64.mjs,
    image-url.mjs, audio.mjs, resource-text.mjs, resource-blob.mjs,
    mixed.mjs, structured.mjs, error.mjs, pre-canonical.mjs
    lib/                         # shared MCP stdio framework + fixtures
manual/                          # NOT in the default test:integration glob;
                                 # opt-in via dedicated package scripts
  llm-smoke.test.ts              # optional external-endpoint Anthropic probe;
                                 # run with `npm run test:integration:llm-smoke`
llm-providers.test.ts            # provider conformance: per-provider HTTP shape,
                                 # tools envelope, parsed ToolCall + tokens. Uses
                                 # MockServer via harness/mock-llm.ts. No DB.
llm-tool-result-serialization.test.ts
                                 # per-provider wire-level serialization of
                                 # tool_call_batch + tool_result_batch ContextItems
                                 # (Anthropic tool_result block, OpenAI Chat
                                 # role:"tool", OpenAI Responses
                                 # function_call_output, BigModel role:"tool").
                                 # Two-round provider.chat() against MockServer
                                 # with priority-distinguished expectations.
                                 # No DB.
llm-error-behavior.test.ts       # 4xx/5xx Error.message contract; malformed
                                 # JSON; empty content[]; bad tool_call args;
                                 # ECONNREFUSED via close-listener trick. No DB.
sanity.test.ts                   # smoke test: pg/redis reachable, resetDb +
                                 # seedMinimal work, spawnApi becomes healthy
```

## Why per-worktree ports

This machine hosts multiple worktrees that may each run their own
dev/test stacks. To avoid colliding with production (3001/3000/5432/6379)
**and with each other**, `scripts/lib.sh` derives a stable compose project
name and four host ports from the worktree path:

| Service                                                   | Host port            |
| --------------------------------------------------------- | -------------------- |
| Test postgres                                             | `55000 + offset`     |
| Test redis                                                | `56000 + offset`     |
| Test API (spawned tsx)                                    | `38000 + offset`     |
| Production-style API container (docker-compose.prod.yaml) | `39000 + offset`     |
| Mock HTTP / MockServer                                    | dynamically assigned |

`offset` is `cksum(worktree path) % 1000`, so the **same worktree gets the
same ports every run** (debuggable with a fixed `psql -p` / `curl`). If the
preferred band is occupied by a _foreign_ listener, lib.sh floats to the
next free offset and records the choice in the gitignored `.stack-env` so
`run-test.sh` / `down.sh` reuse the exact same stack. Run
`bash scripts/lib.sh --print` to see the values for the current worktree.

Each compose project is `synapse-int-test-<slug>-<hash>` and containers are
located by the `com.docker.compose.project` label (no pinned container
names). Worktrees no longer compete for one shared stack — they run in
parallel.

## How to run

```bash
# Run the full suite. This owns the whole lifecycle: it brings the
# per-worktree stack up, runs each tests/integration/*.test.ts file serially
# through run-test.sh (the per-file `before` hook resets this worktree's
# synapse_test DB and spawns a fresh API on the derived API port), then tears
# the stack down on any exit (success, failure, or Ctrl-C) — nothing is left
# behind. Files run one at a time because they share this worktree's DB + API
# port; cross-worktree runs are isolated by the per-worktree ports.
npm run test:integration -w packages/api

# Keep the stack up afterwards for debugging (inspect logs / psql / curl).
# Use as a one-shot prefix; if you `export` it, `unset` before running down.sh.
KEEP_CONTAINERS=1 npm run test:integration -w packages/api
# ...or the dedicated script alias:
npm run test:integration:keep-stack -w packages/api

# Run a single test via the wrapper. It sources lib.sh and sets the derived
# DATABASE_URL + REDIS_URL + BASE_URL + SYNAPSE_INT_TEST=1 in the PARENT
# process before invoking node, because ESM static imports hoist before any
# top-of-file `process.env = ...` runs — without that, importing API modules
# at module-load time grabs the production defaults (5432 / 6379 with prod
# password). The test files also `throw` (and resetDb() refuses) if
# SYNAPSE_INT_TEST!=1. Bring the stack up first:
bash packages/api/tests/integration/scripts/up.sh
bash packages/api/tests/integration/scripts/run-test.sh \
  packages/api/tests/integration/sanity.test.ts
bash packages/api/tests/integration/scripts/run-test.sh \
  packages/api/tests/integration/origin-propagation.test.ts
bash packages/api/tests/integration/scripts/run-test.sh \
  packages/api/tests/integration/execution-tool-results.test.ts

# tear down (default: deletes volumes for next clean run; set KEEP_VOLUMES=1 to keep)
bash packages/api/tests/integration/scripts/down.sh
```

The `run-test.sh` wrapper is required for the **default DB-backed** tests —
their per-file run guards (and the destructive `resetDb()`) refuse to run
without `SYNAPSE_INT_TEST=1`, which only the wrapper sets. The opt-in
`manual/` tests are the exception: they're DB-less and run directly via
`tsx --test` (e.g. `npm run test:integration:llm-smoke`), not the wrapper.

### Opt-in manual tests

Anything under `manual/` is excluded from the default `test:integration`
glob because it talks to externally configured services. Run via the
dedicated package scripts; configuration stays generic so no deployment
topology lives in this repo.

```bash
# Optional LLM smoke — drives an Anthropic-compatible endpoint.
# Configure with LLM_SMOKE_BASE_URL + LLM_SMOKE_API_KEY (test-scoped). The app
# no longer reads any AI_* env vars to pick a model (models come from configured
# model groups), so this smoke test no longer falls back to AI_*. The test skips
# cleanly if the pair is not set. Optional LLM_SMOKE_MODEL overrides the model.
# Any proxy requirement should be handled at the environment level via
# HTTPS_PROXY / HTTP_PROXY — the test is unaware of any specific topology.
LLM_SMOKE_BASE_URL=https://example.invalid/ai-gateway \
LLM_SMOKE_API_KEY=$KEY \
  npm run test:integration:llm-smoke -w packages/api
```

Note that the default suite now has its own MockServer-backed LLM
coverage (`llm-providers.test.ts`, `llm-tool-result-serialization.test.ts`,
`llm-error-behavior.test.ts`), so `manual/llm-smoke.test.ts` is no
longer the only path that exercises a provider — it is a thin "real
gateway still responds" sanity check on top of the deterministic mock
coverage.

## MockServer mock LLM endpoint

The three `llm-*.test.ts` files at the top level mock the LLM
endpoint deterministically rather than calling a real upstream. Each
file spawns its own `mockserver/mockserver:5.15.0` container via
[testcontainers](https://www.npmjs.com/package/testcontainers) on a
**dynamic** mapped port (so no fixed worktree port is reserved, and
nothing changes in `docker-compose.test.yaml` / `up.sh`).

- First-run cost: pulls the MockServer image (~150 MB). Cached
  afterwards. On cold CI, warm the cache once with
  `docker pull mockserver/mockserver:5.15.0`.
- Per-file cost: ~5–8 s container start. `run-all.sh` runs files
  serially, so at most one MockServer container is alive at a time.
- The harness (`harness/mock-llm.ts`) auto-cleans the container via
  an idempotent `stop()` in each test file's `after()` hook. Failed
  tests still tear the container down.
- Requires a working Docker daemon. If a test fails with a raw
  `testcontainers`-shaped error (e.g. "could not find a working
  container runtime strategy"), run `docker info` first.

The three files do **not** depend on the postgres / redis stack —
they instantiate providers directly and only touch MockServer via
`fetch`. `up.sh` is therefore optional when running these three in
isolation, though `run-all.sh` still requires it because other
default files need pg/redis.

## Production-style API build verification

After backend code changes per `AGENTS.md` §Backend, rebuild the API image
under the per-worktree project so it never touches the host's `synapse`
production stack:

```bash
# Source lib.sh to get this worktree's $INT_PROJECT_NAME + $INT_PROD_API_PORT.
source packages/api/tests/integration/scripts/lib.sh up

docker compose -p "$INT_PROJECT_NAME" \
  -f packages/api/tests/integration/docker-compose.test.yaml \
  -f packages/api/tests/integration/docker-compose.prod.yaml \
  up -d --build api

curl -sS "http://127.0.0.1:${INT_PROD_API_PORT}/api/v1/health"
# confirm it's this worktree's int-test api (not a production container):
docker ps --filter "label=com.docker.compose.project=$INT_PROJECT_NAME"

# tear it down (down.sh passes both compose files + --remove-orphans):
bash packages/api/tests/integration/scripts/down.sh
```

The per-worktree `$INT_PROJECT_NAME` project + compose labels ensure this
never collides with `synapse-*` production containers or other worktrees.

## Notes

- The optional LLM smoke test lives under `manual/llm-smoke.test.ts`
  and is excluded from the default `test:integration` glob. See
  [Opt-in manual tests](#opt-in-manual-tests) above for configuration
  and how to invoke it. The default LLM coverage is now provided by
  the three MockServer-backed `llm-*.test.ts` files at the top level —
  see [MockServer mock LLM endpoint](#mockserver-mock-llm-endpoint).
- `.cache/`, `tmp-profiles/`, and `.stack-env` (the per-worktree
  project/port record written by lib.sh) are gitignored.
- Mock MCP servers are pure stdio Node scripts — they don't need any
  runtime bundle.
