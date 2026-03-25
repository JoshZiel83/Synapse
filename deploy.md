# Synapse Host Deploy

This repository is deployed on a single Ubuntu host with:

- local `nginx`
- `systemd` for API and web
- Docker for PostgreSQL, Redis, and SpiceDB
- web running in dev mode

## 1. Host prerequisites

Install the host packages:

```bash
sudo apt-get update
sudo apt-get install -y docker.io docker-compose-v2 nginx
sudo systemctl enable --now docker nginx
```

## 2. Local env files

Generate the local-only env files:

```bash
./setup.sh
```

This creates:

- `.env`
- `packages/web-next/.env.local`

Default seeded platform admin:

- email: `demo@synapse.dev`
- password: `demo1234`

## 3. Infrastructure containers

Start the local-only infrastructure containers:

```bash
sudo docker compose up -d postgres redis spicedb-migrate spicedb
```

Notes:

- Redis is bound to loopback and requires a password from `.env`
- SpiceDB uses PostgreSQL persistence and is no longer run in testing mode

## 4. Application dependencies

Install Node dependencies:

```bash
npm ci
```

## 5. Database initialization

For full reset plus seed data:

```bash
bash -lc 'set -a && source ./.env && set +a && npm run db:reset -w packages/api'
```

For schema-only initialization:

```bash
bash -lc 'set -a && source ./.env && set +a && npm run db:migrate -w packages/api'
```

## 6. Systemd services

Install and enable the services:

```bash
sudo install -m 644 infrastructure/systemd/synapse-api.service infrastructure/systemd/synapse-web-dev.service -t /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now synapse-api synapse-web-dev
```

## 7. Nginx

Do not commit the real `infrastructure/nginx.conf`.
It is intentionally gitignored.

Create a local config from `infrastructure/nginx.conf.template` and replace:

- `{{SERVER_NAME}}`
- `{{API_UPSTREAM}}`
- `{{WEB_UPSTREAM}}`
- `{{TLS_CERT_PATH}}`
- `{{TLS_KEY_PATH}}`

Install it:

```bash
sudo install -d -m 755 /etc/nginx/certs /etc/nginx/sites-available /etc/nginx/sites-enabled
sudo install -m 644 infrastructure/nginx.conf /etc/nginx/sites-available/synapse.conf
sudo ln -sfn /etc/nginx/sites-available/synapse.conf /etc/nginx/sites-enabled/synapse.conf
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
```

## 8. Verification

Check services:

```bash
systemctl is-active synapse-api synapse-web-dev nginx docker
```

Check health:

```bash
curl -sS http://localhost:3001/api/v1/health
curl -sS https://<your-domain>/api/v1/health
```
