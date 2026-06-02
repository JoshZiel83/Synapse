# Synapse private npm registry (Verdaccio)

> **Production deploys run Verdaccio from the root `docker-compose.yml`**
> (`registry` profile): `docker compose --profile registry up -d verdaccio`.
> It shares the main network so the public nginx proxies it at
> `https://$SYNAPSE_REGISTRY_DOMAIN/` with TLS, and the `4873` port is bound
> to loopback only. The standalone `docker-compose.yml` in THIS directory is
> kept for local/offline single-container use; pick one, not both. The
> `config.yaml` and `htpasswd` here are the volumes both setups mount.

Self-hosted [Verdaccio](https://verdaccio.org/) registry so external end
users can one-shot `npm install` the Synapse npm packages **without**
publishing them to public npmjs.

Published packages:

- `@synapse/device-protocol`, `@synapse/shared` (internal deps)
- `@synapse/device-runtime` (+ 6 platform sidecars
  `@synapse/device-runtime-bundles-<os>-<arch>`)
- `@synapse/remote-agent-daemon`

## What this registry guarantees

- **`@synapse/*`** — stored locally, never proxied to npmjs. Anonymous
  **read** (external users install with no token); **publish** requires
  an authenticated publisher.
- **Third-party deps** (`zod`, `ws`, `@anthropic-ai/*`, …) — proxied and
  cached from npmjs (so installs work, and can run offline once warmed),
  but **publish is denied for everyone** so no one can shadow a real
  dependency name in the private registry.

## One-time setup

```bash
cd infra/verdaccio
cp .env.example .env                     # edit NPM_REGISTRY / port if needed

# create a publisher (bcrypt hash appended to ./htpasswd, gitignored):
docker run --rm httpd:2 htpasswd -nbB publisher 'STRONG_PASSWORD' >> htpasswd

docker compose up -d                     # starts on $VERDACCIO_PORT (default 4873)

# obtain a publish token (written to YOUR ~/.npmrc, not the repo):
npm login --registry=http://localhost:4873/
```

## Mandatory acceptance check (run right after `up`)

`publish:` being empty denies third-party publishing — verify it really
returns **403** for BOTH third-party rule patterns, using throwaway
harmless names (never a real dep name, to avoid poisoning the volume):

```bash
# unscoped, hits the "**" rule:
mkdir /tmp/deny1 && cd /tmp/deny1
npm init -y >/dev/null && npm pkg set name="publish-deny-smoke-$(date +%s)"
npm publish --registry=http://localhost:4873/   # expect 403

# scoped non-@synapse, hits the "@*/*" rule:
mkdir /tmp/deny2 && cd /tmp/deny2
npm init -y >/dev/null && npm pkg set name="@publish-deny-smoke-$(date +%s)/pkg"
npm publish --registry=http://localhost:4873/   # expect 403
```

If either unexpectedly succeeds, the registry volume is polluted — wipe
and recreate (`docker compose down -v && docker compose up -d`) before
continuing.

## Publishing

From the repo root, with `NPM_REGISTRY` exported (e.g.
`set -a && source infra/verdaccio/.env && set +a`):

```bash
node scripts/safe-publish.mjs packages/device-protocol
node scripts/safe-publish.mjs packages/shared
bash scripts/publish-device-runtime-sidecars.sh        # 6 sidecars FIRST
node scripts/safe-publish.mjs packages/device-runtime
node scripts/safe-publish.mjs packages/remote-agent-daemon
```

Use `scripts/safe-publish.mjs`, **not** a bare `npm publish --registry=…`.
For scoped packages npm routes the publish to the `@synapse:registry`
mapping, which **overrides** a plain `--registry` flag — so a stray
`@synapse:registry=…npmjs…` in your `~/.npmrc` could leak a private
package to public npm. `safe-publish.mjs` pins `--@synapse:registry`
(which wins) and refuses any npmjs target. The sidecar wrapper does the
same internally.

Sidecars must be published **before** the main `@synapse/device-runtime`
(it pins them as exact `optionalDependencies`).

## Persistence / backup

The `verdaccio-storage` named volume holds all published `@synapse/*`
tarballs and the uplink cache. Back it up; losing it loses published
versions (and npm forbids re-publishing the same version).

## API config: `PUBLIC_NPM_REGISTRY_URL` (one-click daemon command)

The Synapse **API server** builds the daemon install command shown on the
dashboard from `PUBLIC_NPM_REGISTRY_URL` (read into
`config.remoteAgent.npmRegistryUrl`). This is a **separate** value from
`NPM_REGISTRY`:

| Var                       | Who uses it                                         | Reachability                                                                                                    |
| ------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `NPM_REGISTRY`            | the publisher machine + repo `.npmrc` scope mapping | how the **publisher** reaches Verdaccio (often internal/localhost)                                              |
| `PUBLIC_NPM_REGISTRY_URL` | the API server, embedded into the dashboard command | how an **end user's laptop** reaches Verdaccio (must be externally routable, e.g. `https://npm.your-host.tld/`) |

Set `PUBLIC_NPM_REGISTRY_URL` in the **API service's** environment. If it
is unset, the dashboard command degrades from a true one-click
`npm exec --registry=… --@synapse:registry=… …` to a bare
`synapse-remote-agent-daemon …` that only works if the user already
configured `@synapse:registry` in their own `~/.npmrc`. Never set it to an
internal address (`http://verdaccio:4873`, `http://localhost:4873`) — that
is unreachable from user machines.
