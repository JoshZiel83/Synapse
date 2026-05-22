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

After generating `.env`, you can verify with:

```bash
set -a; . ./.env; set +a
getent ahostsv4 "$SYNAPSE_PUBLIC_DOMAIN" "$SYNAPSE_WWW_DOMAIN" "$SYNAPSE_MOBILE_SHORT_DOMAIN" "$SYNAPSE_MOBILE_DOMAIN"
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
- `LETSENCRYPT_CERT_NAME`
- `LETSENCRYPT_EMAIL`

Before using real AI or ASR flows, fill the relevant provider variables in `.env`, including `AI_PROVIDER`, `AI_API_KEY`, `AI_BASE_URL`, `AI_MODEL`, and the Volcengine ASR variables if ASR is required.

## 4. Build and Initialize

Build production images:

```bash
docker compose --profile production build api web mobile-web
```

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

Install the renewal cron:

```bash
install -m 644 infrastructure/cron/synapse-certbot-renew /etc/cron.d/synapse-certbot-renew
```

Manual renewal:

```bash
./infrastructure/scripts/renew-cert.sh
```

## 6. Start Production

Start or update the TLS public stack:

```bash
docker compose --profile production --profile tls up -d api web mobile-web nginx
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
