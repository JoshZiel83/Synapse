# Synapse private npm registry (Verdaccio)

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
npm publish -w packages/device-protocol      --registry="$NPM_REGISTRY"
npm publish -w packages/shared               --registry="$NPM_REGISTRY"
bash scripts/publish-device-runtime-sidecars.sh        # 6 sidecars FIRST
npm publish -w packages/device-runtime       --registry="$NPM_REGISTRY"
npm publish -w packages/remote-agent-daemon  --registry="$NPM_REGISTRY"
```

Sidecars must be published **before** the main `@synapse/device-runtime`
(it pins them as exact `optionalDependencies`).

## Persistence / backup

The `verdaccio-storage` named volume holds all published `@synapse/*`
tarballs and the uplink cache. Back it up; losing it loses published
versions (and npm forbids re-publishing the same version).
