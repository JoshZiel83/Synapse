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

- TLS mode: TCP `80` and `443`, plus UDP `443` for HTTP/3 over QUIC
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

Before using real AI flows, configure at least one platform model group: copy `packages/api/config/model-groups.yaml.example` to `packages/api/config/model-groups.yaml`, fill the referenced `${ENV}` variables (e.g. `ANTHROPIC_API_KEY`) in `.env`, and apply it via `db:rebuild` (which imports it automatically) or `npm run db:seed:model-groups`. For ASR, fill the Volcengine ASR variables in `.env` if ASR is required.

## 4. Build and Initialize

Build production images:

```bash
docker compose --profile production build api web mobile-web
```

The API image bakes in the memory embedding model
(`Xenova/multilingual-e5-small`) into `/app/models/memory` at build time so
vector search works offline — no runtime download, no silent degradation.

This lives outside the `api_storage` volume mount on purpose (a mount under
`/app/storage` would shadow it). If the model fails to fetch, the image build
FAILS rather than degrading at runtime. `MEMORY_ALLOW_RUNTIME_MODEL_DOWNLOAD`
is therefore `false` in the production container.

OCR is **not** baked into the API image — it runs out-of-process. The
`production` profile includes a `tesseract-ocr` sidecar (image OCR on by
default); the optional `ppocr` profile adds a PP-OCRv6 sidecar. Select the
provider with `OCR_PROVIDER` (see the OCR block in `.env.example`).

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

The public nginx config enables HTTP/2, HTTP/3 over QUIC, and advertises HTTP/3
with `Alt-Svc`. HTTP/3 requires UDP `443` to be open and published by Docker;
clients that cannot use QUIC continue to use HTTP/2 or HTTP/1.1 over TCP.

Let's Encrypt removed OCSP URLs from production certificates in May 2025 and
shut down OCSP responders in August 2025, moving revocation status to CRLs. Do
not enable nginx OCSP stapling for the default Let's Encrypt deployment; current
certificates do not contain an OCSP responder URL, so stapling only produces
nginx startup warnings.

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

## 5c. Mijia MCP sidecar (optional)

The Mijia (Xiaomi smart-home) builtin plugin proxies a containerized,
multi-tenant MCP sidecar (`sidecars/mijia-mcp/`, a fork of `javen-yan/miot-mcp`;
see `sidecars/mijia-mcp/UPSTREAM.md`). It runs as the `mijia-mcp` service behind
the `mijia` compose profile, internal-network only (no host port). Per-request
Xiaomi credentials arrive in the `X-Mijia-Auth` header from the API — nothing is
baked into the image, and the service deliberately does NOT receive `.env`
(its environment is an explicit allowlist).

The API reaches it at `http://mijia-mcp:8765/mcp/` via `MIJIA_MCP_URL`. This is
**empty by default** — the Mijia builtin plugin is only seeded when `MIJIA_MCP_URL`
is set, so a plain `--profile production` deployment never surfaces a Mijia plugin
that would fail at connect time against a sidecar you didn't start. To enable,
set it in `.env` and bring up the sidecar with the `mijia` profile:

```bash
echo 'MIJIA_MCP_URL=http://mijia-mcp:8765/mcp/' >> .env
docker compose --profile production --profile mijia up -d --build mijia-mcp api
# re-seed builtin MCP plugins so the Mijia plugin appears in the catalog
# (db:bootstrap:runtime is schema-only and does NOT run the builtin seed):
docker compose --profile production run --rm api npm run db:seed:builtin-mcp -w packages/api
```

Rebuild after changes:

```bash
docker compose --profile production --profile mijia up -d --build mijia-mcp
```

Login (QR) happens on the Synapse side (the `mijia_qr_login` auth driver); the
sidecar only consumes the resulting credentials per request. One installation
binds one Mi Home account (shared by that installation's authorized members);
members who need their own account create a separate installation.

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

### 7.1 Coordinated multi-image rebuild (web + nginx, or a whole release)

> **Build order is load-bearing.** The TLS `nginx` image does `FROM ${WEB_IMAGE}` and
> `COPY --from=web .../.next/static`, baking web's chunks into the nginx image. Rebuilding
> `web` **without** rebuilding `nginx` serves new HTML against nginx's stale baked chunks —
> every chunk 404s. `nginx`'s `WEB_IMAGE` build arg reads the freshly built web image
> **tag**, not a compose build dependency, so compose does not guarantee web builds first.
> Build them as **separate, ordered** invocations; do not lean on a single
> `up -d --build web nginx` (it may build them in parallel). The `nginx` single-file
> template + `ratelimit.js` bind mounts also need a **`--force-recreate`** (not reload/
> restart) to take effect — a plain edit swaps the inode and the container keeps serving
> the deleted one.

The trace-correctness round-2 rollout (commits `defdece3`, `f6c456b5`, `cd615060`,
`79ddc845`) is exactly this shape and has an exact runnable procedure — build order
`web → nginx → mobile-web → api`, per-image `--no-deps --force-recreate`, and a
post-recreate verification checklist (edge strip trio + `x-synapse-trace-ingress` marker +
`limit_req`/`limit_conn`; a real 4xx SERVER span UNSET not ERROR; forged trace headers
stripped; a rate-limit smoke) — in
[`docs/logging-refactor/04-operations.md`](docs/logging-refactor/04-operations.md) §7. The
api rebuild is what applies the in-image `@fastify/otel` patch (§8b prerequisite pattern);
after it, republish the remote-agent daemon (§5b) so paired daemons pick up the new wire
frames (un-upgraded daemons get `400` until republished, deliveries stay pending — no data
loss). See the breaking-change list in `CHANGELOG.md`.

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

Check the certificate chain:

```bash
set -a; . ./.env; set +a
openssl s_client -connect "${SYNAPSE_PUBLIC_DOMAIN}:443" -servername "$SYNAPSE_PUBLIC_DOMAIN" -status </dev/null
```

Check HTTP protocol negotiation:

```bash
set -a; . ./.env; set +a
curl --http2 -I "https://${SYNAPSE_PUBLIC_DOMAIN}/"
curl --http3 -I "https://${SYNAPSE_PUBLIC_DOMAIN}/"
```

The TLS config intentionally leaves `ssl_early_data` off. If 0-RTT is enabled
later, reject replayable early-data requests at nginx and pass the signal to the
API, for example by returning `425` when `$ssl_early_data` is set on non-static
or non-idempotent locations and forwarding `Early-Data: $ssl_early_data`.

## 8b. Server-side actor isolation (sandbox)

Per-session actor sandboxes run each actor turn's filesystem + command tools in
an isolated runtime. Two backends, selected by `SANDBOX_PROVIDER` (local|docker|none):

- **`local`** (default) — a same-host `device-runtime` child process. Command
  confinement needs `bwrap`; the API image bakes `bubblewrap` (+ `ripgrep` for
  live search), so a **containerized** API has it — but the container still needs
  extra kernel privileges (see §8b.1). On a **bare-metal** API, install
  `bubblewrap` on the host and ensure userns/bwrap actually run; absent a working
  bwrap the sandbox is file-only (fail-closed — no commandline tool). The runtime
  exposes its MCP host to the API over a **direct loopback** endpoint
  (`--tunnel-mode=noop` → `http://127.0.0.1:<port>`); the server accepts that
  loopback URL only for a live local sandbox (no frpc).
- **`docker`** — the per-session `device-runtime` runs in its own cloud-sandbox
  container (DooD via the host docker socket), reached over the frp tunnel.
  Command confinement (bwrap) and network isolation live in that container.
  Because the container is on an internal-only network with no co-located
  loopback path, the docker + resident adapter **requires** `FRP_SHARED_TOKEN`
  (frp tunnel); its absence fails fast at boot rather than
  booting a sandbox whose tools can never be dispatched.

> **Image prerequisite (BOTH backends).** The API process itself runs the Rust
> `synapse-device-fs-helper` for all supervisor-side content-addressed-storage
> work (materialize / scan / 3-way merge) — _before_ the backend is even selected
> — so `infrastructure/Dockerfile.api` builds it in a `rust:1-bookworm` stage and
> pins `SYNAPSE_DEVICE_FS_HELPER_PATH`. After pulling a build that adds this,
> **rebuild the api image** (`docker compose --profile production build api`); an
> un-baked image fails the first provision with
> `synapse-device-fs-helper binary not found`.
>
> **Helper distribution (device side).** The Go `synapse-device-cua-helper` and
> Rust `synapse-device-fs-helper` reach a device by exactly one of: the container
> image (above), a repo checkout, or an explicit
> `SYNAPSE_DEVICE_CUA_HELPER_PATH` / `SYNAPSE_DEVICE_FS_HELPER_PATH` — **never via
> `npm i @synapse/device-runtime`**, which ships no helper binaries by design
> (npm cannot pack them above the package root). A device-runtime with no helper
> degrades gracefully — no cua provider, and fs helper-backed features
> (history / indexed search / extract / CAS) disabled — and now **warns at
> startup** naming the env var. This is pinned by check (5) of
> `npm run audit:device-runtime-sidecars`.

In both cases provisioning waits for the device to register its tunnel endpoint
(`device.tunnel.up`) before activating the sandbox or granting tools — a sandbox
that never becomes dispatchable fails provisioning instead of silently looking
"online" while every tool call returns `no_tunnel_endpoint`.

Enable the docker backend — recommended, use the script (it does baseline checks,
secret backfill, the three flag flips, the effective-origin guard, all three image
builds, and brings the stack up, restoring `.env` on any failure):

```bash
bash scripts/deploy-sandbox-docker.sh
```

Or do it by hand:

```bash
# 0. Ensure the two sandbox secrets exist (signing key + frp token). Narrow —
#    does NOT touch deploy vars the way ./setup.sh does. Older .env files predate
#    these and lack the lines entirely; this generates them when missing/empty/
#    whitespace and keeps any existing non-empty value.
bash scripts/ensure-sandbox-secrets.sh

# 1. Rebuild the api image WITH the baked fs-helper (see prerequisite above),
#    then build the cloud-sandbox image (self-contained; compiles TS + Rust inside).
docker compose --profile production build api
docker compose --profile sandbox-build build sandbox-image

# 2. In .env set the provider (setup.sh defaults SANDBOX_PROVIDER=none):
#      SANDBOX_PROVIDER=docker
#    (SANDBOX_MODE defaults to 'resident'; the docker+resident adapter needs
#     FRP_SHARED_TOKEN — set it too.)
#    Leave SANDBOX_SERVER_ORIGIN UNSET (compose default http://api:3001)
#    or set it to that internal address — NEVER a loopback or public domain (the
#    sandbox is on an internal-only network). NB: compose reads the shell env
#    before .env, so unset any stale value in your deploy shell too. (The script
#    above strips a stale loopback from .env and rejects any other custom value.)

# 3. Bring up the API + the tunnel edge WITH the docker-backend override, which
#    is what adds the host docker socket to the API container (see note below).
docker compose \
  -f docker-compose.yml \
  -f docker-compose.sandbox-docker.yml \
  --profile production up -d api tunnel-edge
```

Notes:

- The host docker socket is **opt-in**, not in the base compose. The base
  `docker-compose.yml` deliberately does NOT mount `/var/run/docker.sock` into
  the API container — doing so unconditionally would give every production API
  container host-root-equivalent access even with sandboxes disabled or on the
  default `local` backend. The `docker-compose.sandbox-docker.yml` override
  appends the socket mount; layer it (`-f ... -f docker-compose.sandbox-docker.yml`)
  only when `SANDBOX_PROVIDER=docker`. The backend only ever runs the
  pinned `SANDBOX_DOCKER_IMAGE` with a fixed argument list; a docker-socket-proxy
  is the recommended hardening for multi-tenant hosts.
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
  (default `/app/storage`; override with `SANDBOX_DOCKER_STORAGE_VOLUME_MOUNT`).
  In the reference compose `STORAGE_DIR=/app/storage/files` and the volume mounts
  at `/app/storage`, so the subpath is `files/sandboxes/<sessionId>`. If you
  remount the volume or change `STORAGE_DIR` so the storage dir no longer sits
  under the mount point, set `SANDBOX_DOCKER_STORAGE_VOLUME_MOUNT` accordingly —
  otherwise provisioning fails loudly rather than mounting the wrong directory.
- **Custom tunnel edge:** the sandbox runtime registers its dispatch endpoint as
  `<internal-base>/d/<token>`, and the server only accepts an `internal_url`
  whose origin matches `SYNAPSE_DEVICE_TUNNEL_EDGE_URL`. Both default to the
  reference `http://tunnel-edge:8080`. If you run the frp edge under a different
  host/port, set `SYNAPSE_DEVICE_TUNNEL_EDGE_URL` (the docker backend forwards it
  to the container as the internal base automatically) **and**
  `SYNAPSE_TUNNEL_VHOST_HOST` so the frps Host route matches. The docker backend
  **fails fast when it is selected** (the first sandbox provision after the API
  starts, i.e. backend selection — not a separate startup pre-check) if the
  `SYNAPSE_DEVICE_TUNNEL_EDGE_URL` host and `SYNAPSE_TUNNEL_VHOST_HOST` disagree
  (a mismatch would make every sandbox dispatch fail to route), so the two must
  be configured together.

### 8b.1 Containerized `local` backend (single-tenant only)

The `local` backend runs the device-runtime as a same-host child of the API. When
the API itself runs in a container, that child's bwrap jail needs kernel
privileges the default profile denies. The API image already bakes `bubblewrap`
and `ripgrep`; what's left is the container's capability profile:

- `cap_add: SYS_ADMIN` (bwrap mount/namespace setup) **and** `NET_ADMIN` (the
  local jail uses `--unshare-net`, whose loopback bring-up needs it — the local
  host-provider does not pass `--cmd-sandbox-share-net`),
- `security_opt: seccomp=unconfined`, `apparmor=unconfined` (AppArmor otherwise
  blocks the jail's mount make-rslave).

These apply to **every** process in the API container, so they weaken its
isolation — strictly worse than the `docker` backend (which keeps the API on the
default profile and confines each session in a separate container). **Use `local`
only single-tenant / trusted; prefer `docker` for multi-tenant or untrusted
workloads.** These caps live in the opt-in `docker-compose.sandbox-local.yml`
override, which also injects `SANDBOX_SERVER_ORIGIN=http://127.0.0.1:3001`
(loopback) — kept in the override, **never in `.env`**, since that variable is
shared with the docker backend (which needs an internal address instead).

```bash
# One-shot helper: baseline-.env check → reject conflicting shell-env flags →
# ensure secrets → set ENABLED/BACKEND=local → build api → bwrap smoke in a
# THROWAWAY container → only then up api+tunnel-edge with the local override.
# Running the smoke BEFORE bring-up means a cap-stack failure never leaves a
# running local+privileged API; .env is backed up (outside the repo) and
# restored on any failure.
bash scripts/deploy-sandbox-local.sh

# Or just the smoke test against a throwaway container (builds the image, proves a
# --unshare-net bwrap jail actually starts under the cap stack — not merely that
# the binaries exist):
bash scripts/sandbox-local-smoke.sh
```

**Bare-metal API (not containerized):** no container caps are needed — the host's
userns suffices — but you must install `bubblewrap` on the host and confirm
userns/bwrap actually run (else commandline fail-closes off). The baked image
bwrap does not help a bare-metal process.

**Switching back to `docker`:** ensure no leftover loopback
`SANDBOX_SERVER_ORIGIN` remains in `.env` **or your shell** (compose reads
the shell first) — it must be unset or `http://api:3001`, never a loopback/public
domain, or the docker sandbox container will dial the wrong address.

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
