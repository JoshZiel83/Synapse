# Integration tests for the API package

End-to-end tests that exercise the full MCP / relay / canonical-content
pipeline against an isolated stack — separate postgres, redis, and (when
needed) a separate API container, all on private ports under a single
`synapse-int-test` docker compose project.

## What's in here

```
docker-compose.test.yaml         # isolated postgres (55433) + redis (56380)
docker-compose.prod.yaml         # docker rebuild of the production API
                                 # (AGENTS.md backend-update gate)
scripts/
  up.sh                          # bring up test postgres+redis
  down.sh                        # tear them down (default: with -v to delete volumes)
  build-relay.sh                 # build relay/synapse-relay via make cli, cache to .cache/
  run-test.sh                    # wrapper that sets DATABASE_URL/REDIS_URL
                                 # in the parent process before invoking node
harness/
  api-process.ts                 # spawn API as tsx child process on 127.0.0.1:38091
  db.ts                          # pg client + resetDb + seedMinimal
  http-server.ts                 # tiny mock HTTP server for image-url / plugin-remote mocks
  relay.ts                       # pair + start synapse-relay against the test API
  index.ts                       # re-exports
mocks/
  mcp-servers/                   # 11 stdio MCP server variants
    text-only.mjs, image-base64.mjs, image-source-base64.mjs,
    image-url.mjs, audio.mjs, resource-text.mjs, resource-blob.mjs,
    mixed.mjs, structured.mjs, error.mjs, pre-canonical.mjs
    lib/                         # shared MCP stdio framework + fixtures
sanity.test.ts                   # smoke test
```

## Why private ports

This machine hosts multiple worktrees that may each run their own
dev/test stacks. To avoid colliding with production (3001/3000/5432/6379)
and to share one canonical "integration test" namespace across worktrees,
this stack uses:

| Service                                                   | Port                         |
| --------------------------------------------------------- | ---------------------------- |
| Test postgres                                             | `127.0.0.1:55433`            |
| Test redis                                                | `127.0.0.1:56380`            |
| Test API (spawned tsx)                                    | `127.0.0.1:38091`            |
| Production-style API container (docker-compose.prod.yaml) | `127.0.0.1:38001`            |
| Mock HTTP servers                                         | dynamically assigned by test |

All docker compose calls use `-p synapse-int-test` to isolate project
namespace. Container names are `synapse-int-*`. Only one worktree can
own this stack at a time — concurrent worktrees would compete on these
ports. Most CI / dev workflows only need one anyway.

## How to run

```bash
# one-time: build relay binary
bash packages/api/tests/integration/scripts/build-relay.sh

# bring up isolated postgres + redis
bash packages/api/tests/integration/scripts/up.sh

# run integration tests via the wrapper. The wrapper sets DATABASE_URL +
# REDIS_URL in the PARENT process before invoking node, because ESM static
# imports hoist before any top-of-file `process.env = ...` runs — without
# that, importing API modules at module-load time grabs the production
# defaults (5432 / 6379 with prod password) and the test fails with auth
# errors. The relevant test files also `throw` if you forget the wrapper.
bash packages/api/tests/integration/scripts/run-test.sh \
  packages/api/tests/integration/sanity.test.ts
bash packages/api/tests/integration/scripts/run-test.sh \
  packages/api/tests/integration/origin-propagation.test.ts
bash packages/api/tests/integration/scripts/run-test.sh \
  packages/api/tests/integration/execution-tool-results.test.ts
bash packages/api/tests/integration/scripts/run-test.sh \
  packages/api/tests/integration/ingest-via-relay.test.ts

# tear down (default: deletes volumes for next clean run; set KEEP_VOLUMES=1 to keep)
bash packages/api/tests/integration/scripts/down.sh
```

Tests that don't import API modules at load time (sanity, ingest-via-relay)
also work with a bare `node --test --import tsx <file>`, but the wrapper
is safer and faster for everything.

## Production-style API build verification

After backend code changes per `AGENTS.md` §Backend, rebuild the API image
under the isolated project so it never touches the host's `synapse`
production stack:

```bash
docker compose -p synapse-int-test \
  -f packages/api/tests/integration/docker-compose.test.yaml \
  -f packages/api/tests/integration/docker-compose.prod.yaml \
  up -d --build api

curl -sS http://127.0.0.1:38001/api/v1/health
docker ps --filter name=synapse-int-api   # confirm it's the int-test container
```

The `-p synapse-int-test` project name + `synapse-int-*` container names
ensure this never collides with `synapse-*` production containers.

## Notes

- `provider-specific AI endpoint` access on this machine requires SOCKS5 `<redacted-local-proxy>`. Only
  `llm-smoke.test.ts` hits the gateway; everything else is fully
  self-contained.
- `.cache/` and `tmp-profiles/` are gitignored.
- Mock MCP servers are pure stdio Node scripts — they don't need any
  runtime bundle; the relay's plain `make cli` build is sufficient.
