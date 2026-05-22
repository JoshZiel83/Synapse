# Integration tests for canonical-content-blocks worktree

End-to-end tests that exercise the full MCP / relay / canonical-content pipeline against a worktree-isolated stack.

## What's in here

```
docker-compose.test.yaml         # isolated postgres (55433) + redis (56380)
docker-compose.prod.yaml         # worktree-scoped production-style API build override
scripts/
  up.sh                          # bring up test postgres+redis
  down.sh                        # tear them down (default: with -v to delete volumes)
  build-relay.sh                 # build relay/synapse-relay via make cli, cache to .cache/
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
sanity.test.ts                   # Phase 0 sanity check
```

## Why worktree-isolated ports

This machine hosts multiple Synapse worktrees that may each be running their own dev/test stacks. To avoid port collisions and accidental cross-contamination:

| Service                                                   | Port (this worktree)         |
| --------------------------------------------------------- | ---------------------------- |
| Test postgres                                             | `127.0.0.1:55433`            |
| Test redis                                                | `127.0.0.1:56380`            |
| Test API (spawned tsx)                                    | `127.0.0.1:38091`            |
| Production-style API container (docker-compose.prod.yaml) | `127.0.0.1:38001`            |
| Mock HTTP servers                                         | dynamically assigned by test |

All docker compose calls use `-p synapse-canonical-content-blocks` to isolate project namespace. Container names are `synapse-cb-*`.

## How to run

```bash
# one-time: build relay binary
bash packages/api/tests/integration/scripts/build-relay.sh

# bring up isolated postgres + redis
bash packages/api/tests/integration/scripts/up.sh

# run the integration tests (single suite or all)
node --test --import tsx 'packages/api/tests/integration/sanity.test.ts'
node --test --import tsx 'packages/api/tests/integration/**/*.test.ts'

# tear down (default: deletes volumes for next clean run; set KEEP_VOLUMES=1 to keep)
bash packages/api/tests/integration/scripts/down.sh
```

## Production-style API build verification

After backend code changes per `AGENTS.md` §Backend, rebuild the API image:

```bash
docker compose -p synapse-canonical-content-blocks \
  -f packages/api/tests/integration/docker-compose.test.yaml \
  -f packages/api/tests/integration/docker-compose.prod.yaml \
  up -d --build api

curl -sS http://127.0.0.1:38001/api/v1/health
docker ps --filter name=synapse-cb-api   # confirm it's our worktree's container
```

The `-p synapse-canonical-content-blocks` project name + `synapse-cb-*` container names ensure this never collides with other worktrees that may be doing the same.

## Notes

- `provider-specific AI endpoint` access on this machine requires SOCKS5 `<redacted-local-proxy>`. Only the LLM smoke test in Phase 6 hits the gateway; everything else is fully self-contained.
- `.cache/` and `tmp-profiles/` are gitignored.
- Mock MCP servers are pure stdio Node scripts — they don't need any runtime bundle; the relay's plain `make cli` build is sufficient.
