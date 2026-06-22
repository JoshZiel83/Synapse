# Upstream provenance — Notion MCP backend

The Notion backend for this sidecar is the **official, unmodified** Notion MCP
server, vendored as a pinned npm dependency. We do **not** fork or patch it; we
run it as a loopback-only child process behind the shared Synapse MCP front end
(`_mcp_base`) via the generic MCP-PROXY adapter (`_mcp_base/proxy.py`,
`lifecycle="shared"`). This sidecar contributes **no** front-end / transport
code of its own (E1).

## Pinned backend

- **Package:** [`@notionhq/notion-mcp-server`](https://www.npmjs.com/package/@notionhq/notion-mcp-server)
- **Version (EXACT):** `2.4.0`
- **Upstream commit (`gitHead` of 2.4.0):** `df04d3f9891ef5dd089c5f48b498c83f4d3c4e63`
- **Repository:** https://github.com/makenotion/notion-mcp-server
- **Tarball integrity (npm):** `sha512-sbroJAFI7iJG97IrCfheTLjgq7qDkg+9y5CPPqMY9LgmzT+q+V1PvG1ONlhrjE6Ph5iIPR59vNkCKfHoXQsHJw==`
- **License:** MIT (`Copyright (c) 2025 Notion Labs, Inc.`) — retained verbatim in
  `LICENSE`.

## How it is vendored (reproducible `npm ci`)

`vendor/notion-mcp/` contains a tiny wrapper package that pins the exact backend
version plus a committed `package-lock.json`:

```
vendor/notion-mcp/
  package.json        # depends on @notionhq/notion-mcp-server@2.4.0 (exact)
  package-lock.json   # full pinned dependency tree (lockfileVersion 3)
```

The Docker build stage (`infrastructure/Dockerfile.notion-mcp`) runs
`npm ci --omit=dev` inside `vendor/notion-mcp/`, which reconstructs
`node_modules/` byte-for-byte from the lockfile. The committed lockfile is the
source of truth; `node_modules/` is **never** committed (see `.gitignore`).

The runtime entry is the package's pre-bundled (esbuild) CLI:

```
vendor/notion-mcp/node_modules/@notionhq/notion-mcp-server/bin/cli.mjs
```

NOTE: `bin/cli.mjs` resolves its OpenAPI spec via a path RELATIVE to itself
(`../scripts/notion-openapi.json`), so the installed package layout (its `bin/`
adjacent to `scripts/`) must be preserved — which `npm ci` guarantees. Do not
flatten or relocate the package.

## How the proxy drives it (see serve.py / plan §4.3)

The base spawns the Node server ONCE as a loopback child:

```
node .../bin/cli.mjs --transport http --enable-token-passthrough \
  --auth-token <RANDOM_GATEWAY_TOKEN> --host 127.0.0.1 --port 9766
```

- **`--transport http`** — Streamable HTTP at `http://127.0.0.1:9766/mcp`
  (the loopback port is NEVER published/exposed; the Python base on
  `FASTMCP_PORT` is the container's only listener, E1).
- **`--enable-token-passthrough`** — each request brings its own Notion
  integration token via the `Notion-Token` header (one deployment serves many
  integrations). The token is bound to the MCP session, so the proxy holds one
  upstream session per `(tenant, token-hash)`.
- **`--auth-token <RANDOM_GATEWAY_TOKEN>`** — a per-process random bearer minted
  in `serve.py`. It is the loopback transport credential (sent as
  `Authorization: Bearer ...` by the proxy's outbound client); it is **NOT** the
  Notion token, is never `--unsafe-disable-auth`'d, never logged, and never
  exposed to Synapse. The two credentials are kept distinct (double-bearer).

### Notion-Version is intentionally NOT pinned by us

Upstream sources `Notion-Version` PER-OPERATION from its OpenAPI spec (e.g. the
page-markdown endpoints require `2026-03-11` while most others use
`2025-09-03`); `token.notionHeadersForToken` deliberately OMITS the header for
exactly this reason. We therefore do **not** set a fixed `Notion-Version` header
in `fixed_headers` (doing so would clobber the per-operation version and break
endpoints needing the other one). This is a deliberate deviation from an earlier
plan draft that proposed `fixed_headers={"Notion-Version": "2026-03-11"}`.

## Onboarding (no OAuth)

This integration uses an **internal integration token** (`ntn_…`, legacy
`secret_…`) — NOT OAuth. The hosted OAuth-only `mcp.notion.com` is deliberately
not used. Each tenant:

1. Creates an INTERNAL integration at `notion.so/my-integrations` and copies the
   secret.
2. **Shares each target page/database with the integration** (Connections menu)
   — holding the token alone grants zero access.
3. Pastes the token into the Synapse install dialog (`notionToken` secret field).

## Syncing upstream

To bump: pick a new exact version, update `vendor/notion-mcp/package.json`, run
`npm install --package-lock-only` to refresh `package-lock.json`, update the
version / `gitHead` / integrity above, re-confirm the CLI flags
(`scripts/server-options.ts`) and the `Notion-Token` passthrough behavior
(`src/openapi-mcp-server/mcp/token.ts`) still match `serve.py`, and re-run a
`tools/list` against the pinned version to re-confirm the `never_tools` /
`raw_tools` allowlists in `serve.py`.
