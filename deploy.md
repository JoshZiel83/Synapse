# Synapse Docker Deploy

This repository is deployed on a single Ubuntu host with Docker Compose:

- `postgres` and `redis` for local infrastructure
- `api` for the Fastify backend
- `web` for the production Next.js desktop app
- `mobile-web` for the exported Expo mobile web static site
- `nginx` as the public TLS entrypoint
- `nginx-http` as the optional HTTP-only entrypoint for IP and port deployments
- Dockerized Certbot for Let's Encrypt certificates and renewal

## 1. Host Prerequisites

Install Docker and Compose:

```bash
apt-get update
apt-get install -y docker.io docker-compose-v2
systemctl enable --now docker
```

The public host must allow the selected inbound port:

- TLS mode: TCP `80` and `443`
- HTTP-only mode: TCP `${SYNAPSE_HTTP_PORT:-80}`

## 2. DNS or IP

For TLS mode, point these hostnames at the server IP:

- primary domain, for example `<primary-domain>`
- `www.<primary-domain>`
- `m.<primary-domain>`
- `mobile.<primary-domain>`
- `npmr.<primary-domain>` (private npm registry; only needed if you run the `registry` profile)

After generating `.env`, you can verify with:

```bash
set -a; . ./.env; set +a
getent ahostsv4 "$SYNAPSE_PUBLIC_DOMAIN" "$SYNAPSE_WWW_DOMAIN" "$SYNAPSE_MOBILE_SHORT_DOMAIN" "$SYNAPSE_MOBILE_DOMAIN" "$SYNAPSE_REGISTRY_DOMAIN"
```

HTTP-only mode can use a plain IP or hostname with a single port and does not require DNS.

## 3. Local Env

Generate local-only secrets and public URLs for TLS mode:

```bash
SYNAPSE_PUBLIC_DOMAIN=<primary-domain> ./setup.sh
```

For HTTP-only mode:

```bash
SYNAPSE_DEPLOY_MODE=http SYNAPSE_PUBLIC_HOST=<ip-or-host> SYNAPSE_HTTP_PORT=<port> ./setup.sh
```

This creates `.env` and `packages/web-next/.env.local`. Do not commit either file.

`setup.sh` stores the concrete production hostnames in local-only `.env` variables:

- `SYNAPSE_DEPLOY_MODE`
- `SYNAPSE_PUBLIC_HOST`
- `SYNAPSE_HTTP_PORT`
- `SYNAPSE_PUBLIC_DOMAIN`
- `SYNAPSE_WWW_DOMAIN`
- `SYNAPSE_MOBILE_SHORT_DOMAIN`
- `SYNAPSE_MOBILE_DOMAIN`
- `SYNAPSE_REGISTRY_DOMAIN`
- `LETSENCRYPT_CERT_NAME`
- `LETSENCRYPT_EMAIL`
- `PUBLIC_NPM_REGISTRY_URL`

Before using real AI or ASR flows, fill the relevant provider variables in `.env`, including `AI_PROVIDER`, `AI_API_KEY`, `AI_BASE_URL`, `AI_MODEL`, and the Volcengine ASR variables if ASR is required.

## 4. Build and Initialize

Build production images:

```bash
docker compose --profile production build api web mobile-web
```

The API image bakes in everything it needs at build time — no runtime model
downloads, no silent degradation:

- the memory embedding model (`Xenova/multilingual-e5-small`) into
  `/app/models/memory` (so vector search works offline),
- the tesseract OCR language data (`chi_sim`, `chi_tra`, `eng`, `jpn`) into
  `/app/models/tessdata`.

These live outside the `api_storage` volume mount on purpose (a mount under
`/app/storage` would shadow them). If a model or language fails to fetch, the
image build FAILS rather than degrading at runtime. `MEMORY_ALLOW_RUNTIME_MODEL_DOWNLOAD`
is therefore `false` in the production container.

Start infrastructure:

```bash
docker compose up -d postgres redis
```

For a fresh demo environment with seeded users, workspace, official actors, skills, and plugins:

```bash
docker compose --profile production run --rm api npm run db:rebuild:runtime -w packages/api
```

For schema-only initialization:

```bash
docker compose --profile production run --rm api npm run db:bootstrap:runtime -w packages/api
```

Seeded demo accounts:

- `demo@synapse.dev` / `demo1234`
- `yihang@synapse.dev` / `demo1234`

## 5. TLS Certificates

Skip this section when `SYNAPSE_DEPLOY_MODE=http`.

Issue a SAN certificate for all TLS public hostnames:

```bash
./infrastructure/scripts/issue-cert.sh
```

The public nginx config enables OCSP stapling with the Let's Encrypt chain.

Install the renewal cron (substitutes the current repo root into the template; run from the repo root). The substitution shell-escapes the value for single-quote injection and escapes sed metacharacters, so paths containing spaces, `$`, backticks, `"`, `'`, `&`, `|`, and `\` are all preserved literally. The repo path must still avoid `%` (cron metacharacter) and newlines.

```bash
REPO_ROOT_ESC=$(printf '%s' "$(pwd)" | sed -e "s/'/'\\\\''/g" -e 's/[\\&|]/\\&/g')
sed "s|__REPO_ROOT__|${REPO_ROOT_ESC}|g" infrastructure/cron/synapse-certbot-renew.template \
  | install -m 644 /dev/stdin /etc/cron.d/synapse-certbot-renew
```

Manual renewal:

```bash
./infrastructure/scripts/renew-cert.sh
```

## 5b. Private npm registry (Verdaccio)

The private registry serves `@synapse/*` to end users and caches third-party
deps from npmjs. It runs as the `verdaccio` service behind the `registry`
compose profile, published at the registry subdomain
(`$SYNAPSE_REGISTRY_DOMAIN`, e.g. `npmr.<primary-domain>`) through the same
public nginx + TLS cert. The `4873` port is bound to loopback only — all
external access goes through nginx. The real registry hostname lives only in
the gitignored `.env` (`SYNAPSE_REGISTRY_DOMAIN` / `PUBLIC_NPM_REGISTRY_URL`),
never in the repo.

One-time setup (publisher credentials + registry config are gitignored):

```bash
cp infra/verdaccio/.env.example infra/verdaccio/.env   # set NPM_REGISTRY / PUBLIC_NPM_REGISTRY_URL
# create a publisher (bcrypt hash appended to ./htpasswd, gitignored):
docker run --rm httpd:2 htpasswd -nbB publisher 'STRONG_PASSWORD' >> infra/verdaccio/htpasswd
```

Make sure `$SYNAPSE_REGISTRY_DOMAIN` is in the TLS cert (re-run
`./infrastructure/scripts/issue-cert.sh` — it now includes the registry
subdomain in the SAN list), then start the registry:

```bash
docker compose --profile registry up -d verdaccio
```

Run the deny smoke test (verify third-party publish is refused, 403) per
`infra/verdaccio/README.md`, then publish the packages. Order matters — the
six sidecars must publish before `@synapse/device-runtime` (it pins them as
exact `optionalDependencies`), and always use the wrappers (never a bare
`npm publish`, which can leak a scoped package to public npm):

```bash
set -a && source infra/verdaccio/.env && set +a   # exports NPM_REGISTRY
npm run build:device-protocol && npm run build:shared && npm run build:device-runtime
npm run build -w packages/remote-agent-daemon
node scripts/safe-publish.mjs packages/device-protocol
node scripts/safe-publish.mjs packages/shared
bash scripts/publish-device-runtime-sidecars.sh    # 6 sidecars FIRST
node scripts/safe-publish.mjs packages/device-runtime
node scripts/safe-publish.mjs packages/remote-agent-daemon
```

The publishable packages build with `tsconfig.build.json` (sourcemaps off)
and the `prepublish-guard` refuses any tarball containing `.map` files, so
no sourcemaps are ever published. Back up the `verdaccio_storage` volume —
losing it loses every published version (npm forbids re-publishing a version).

## 6. Start Production

Start or update the TLS public stack:

```bash
docker compose --profile production --profile tls up -d api web mobile-web nginx
```

To also serve the private npm registry, add the `registry` profile:

```bash
docker compose --profile production --profile tls --profile registry up -d api web mobile-web nginx verdaccio
```

Start or update the HTTP-only public stack:

```bash
docker compose --profile production --profile http up -d api web mobile-web nginx-http
```

Service routing:

- TLS mode: `https://${SYNAPSE_PUBLIC_DOMAIN}/` and `https://${SYNAPSE_WWW_DOMAIN}/` serve desktop web.
- TLS mode: `https://${SYNAPSE_MOBILE_SHORT_DOMAIN}/` and `https://${SYNAPSE_MOBILE_DOMAIN}/` redirect to `/mobile/`.
- HTTP-only mode: `http://${SYNAPSE_PUBLIC_HOST}:${SYNAPSE_HTTP_PORT}/` serves desktop web.
- HTTP-only mode: `http://${SYNAPSE_PUBLIC_HOST}:${SYNAPSE_HTTP_PORT}/mobile/` serves mobile web.
- `/api/`, `/ws`, and `/files/` are proxied to the API.
- `/mobile/` is proxied to the `mobile-web` static nginx container.
- TLS mode: `https://${SYNAPSE_REGISTRY_DOMAIN}/` serves the private npm registry (when the `registry` profile is up).

## 7. Updates

API update:

```bash
docker compose --profile production up -d --build api
```

Desktop web update:

```bash
docker compose --profile production --profile tls up -d --build web nginx
docker compose --profile production --profile http up -d --build web nginx-http
```

Mobile web update:

```bash
docker compose --profile production --profile tls up -d --build mobile-web nginx
docker compose --profile production --profile http up -d --build mobile-web nginx-http
```

Nginx config update:

```bash
docker compose --profile production --profile tls up -d --force-recreate nginx
docker compose --profile production --profile http up -d --force-recreate nginx-http
```

## 8. Verification

Check containers:

```bash
docker compose --profile production --profile tls ps
docker compose --profile production --profile http ps
```

Check health and routes:

```bash
set -a; . ./.env; set +a
curl -sS http://127.0.0.1:3001/api/v1/health
curl -sS "https://${SYNAPSE_PUBLIC_DOMAIN}/api/v1/health"
curl -I "https://${SYNAPSE_PUBLIC_DOMAIN}/"
curl -I "https://${SYNAPSE_WWW_DOMAIN}/"
curl -I "https://${SYNAPSE_MOBILE_SHORT_DOMAIN}/"
curl -I "https://${SYNAPSE_MOBILE_SHORT_DOMAIN}/mobile/"
```

HTTP-only checks:

```bash
set -a; . ./.env; set +a
curl -sS "http://${SYNAPSE_PUBLIC_HOST}:${SYNAPSE_HTTP_PORT}/api/v1/health"
curl -I "http://${SYNAPSE_PUBLIC_HOST}:${SYNAPSE_HTTP_PORT}/"
curl -I "http://${SYNAPSE_PUBLIC_HOST}:${SYNAPSE_HTTP_PORT}/mobile/"
curl -I "http://${SYNAPSE_PUBLIC_HOST}:${SYNAPSE_HTTP_PORT}/.env"
curl -I "http://${SYNAPSE_PUBLIC_HOST}:${SYNAPSE_HTTP_PORT}/mobile/.env"
```

Check certificate and OCSP stapling:

```bash
set -a; . ./.env; set +a
openssl s_client -connect "${SYNAPSE_PUBLIC_DOMAIN}:443" -servername "$SYNAPSE_PUBLIC_DOMAIN" -status </dev/null
```

## 8b. Server-side actor isolation (sandbox)

Per-session actor sandboxes run each actor turn's filesystem + command tools in
an isolated runtime. Two backends, selected by `SYNAPSE_SANDBOX_BACKEND`:

- **`local`** (default) — a same-host `device-runtime` child process. Command
  confinement needs `bwrap` on the API host; absent it, the sandbox is
  file-only (fail-closed).
- **`docker`** — the per-session `device-runtime` runs in its own cloud-sandbox
  container (DooD via the host docker socket), reached over the frp tunnel.
  Command confinement (bwrap) and network isolation live in that container.

Enable the docker backend:

```bash
# 1. Build the cloud-sandbox image (self-contained; compiles TS + Rust inside).
docker compose --profile sandbox-build build sandbox-image

# 2. In .env (setup.sh already generated the signing key + frp token):
#      SYNAPSE_SANDBOX_ENABLED=true
#      SYNAPSE_SANDBOX_BACKEND=docker
#      SYNAPSE_SANDBOX_TUNNEL=frp
#    (SYNAPSE_DEVICE_ENVELOPE_SIGNING_KEY + FRP_SHARED_TOKEN must be set.)

# 3. Bring up the API + the tunnel edge.
docker compose --profile production up -d api tunnel-edge
```

Notes:

- The API container mounts `/var/run/docker.sock` to launch sandbox containers.
  That socket is host-root-equivalent — the backend only ever runs the pinned
  `SYNAPSE_SANDBOX_IMAGE` with a fixed argument list. A docker-socket-proxy is
  the recommended hardening for multi-tenant hosts.
- Sandbox containers join the **internal** `synapse-sandbox-egress` network: they
  reach the API + tunnel-edge but have **no public egress and no DB/Redis
  access** — so a confined command (which shares the container's netns) can't
  reach the internet or the database.
- `bwrap` runs without `CAP_NET_ADMIN` (`--unshare-net` is gated off via
  `--cmd-sandbox-share-net`; network isolation is the container's job). The
  backend sets `seccomp=unconfined`, `apparmor=unconfined`, `CAP_SYS_ADMIN`
  per sandbox container — the API container keeps the default profile.
- **Storage volume layout:** each sandbox container mounts only its own session
  subpath of the shared `api_storage` volume. The API derives that subpath from
  `STORAGE_DIR` relative to the volume's mount point inside the API container
  (default `/app/storage`; override with `SYNAPSE_SANDBOX_STORAGE_VOLUME_MOUNT`).
  In the reference compose `STORAGE_DIR=/app/storage/files` and the volume mounts
  at `/app/storage`, so the subpath is `files/sandboxes/<sessionId>`. If you
  remount the volume or change `STORAGE_DIR` so the storage dir no longer sits
  under the mount point, set `SYNAPSE_SANDBOX_STORAGE_VOLUME_MOUNT` accordingly —
  otherwise provisioning fails loudly rather than mounting the wrong directory.

## 9. Troubleshooting

Inspect logs:

```bash
docker compose --profile production logs --tail=100 api
docker compose --profile production logs --tail=100 web
docker compose --profile production logs --tail=100 mobile-web
docker compose --profile production --profile tls logs --tail=100 nginx
docker compose --profile production --profile http logs --tail=100 nginx-http
```

If nginx fails with missing certificate files, run `./infrastructure/scripts/issue-cert.sh` before starting `nginx`.

If ports `80` or `443` are already in use, stop the conflicting process before starting the public stack.
