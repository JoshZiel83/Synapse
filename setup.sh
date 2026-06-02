#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="$(cd "$(dirname "$0")" && pwd)/.env"
WEB_ENV_FILE="$(cd "$(dirname "$0")" && pwd)/packages/web-next/.env.local"

read_env_value() {
  local key="$1"
  if [ -f "$ENV_FILE" ]; then
    sed -n "s/^${key}=//p" "$ENV_FILE" | tail -n 1
  fi
}

host_from_url() {
  local value="$1"
  value="${value#http://}"
  value="${value#https://}"
  value="${value%%/*}"
  value="${value%%:*}"
  printf '%s' "$value"
}

scheme_from_url() {
  local value="$1"
  case "$value" in
    http://*) printf 'http' ;;
    https://*) printf 'https' ;;
    *) printf '' ;;
  esac
}

url_for_public_endpoint() {
  local scheme="$1"
  local host="$2"
  local port="$3"

  if [ "$scheme" = "http" ] && [ -n "$port" ] && [ "$port" != "80" ]; then
    printf '%s://%s:%s' "$scheme" "$host" "$port"
    return
  fi

  printf '%s://%s' "$scheme" "$host"
}

existing_public_domain="$(read_env_value SYNAPSE_PUBLIC_DOMAIN)"
existing_public_host="$(read_env_value SYNAPSE_PUBLIC_HOST)"
existing_http_port="$(read_env_value SYNAPSE_HTTP_PORT)"
existing_deploy_mode="$(read_env_value SYNAPSE_DEPLOY_MODE)"
existing_app_base_url="$(read_env_value APP_BASE_URL)"
existing_app_base_host="$(host_from_url "$existing_app_base_url")"
existing_app_base_scheme="$(scheme_from_url "$existing_app_base_url")"

DEPLOY_MODE="${SYNAPSE_DEPLOY_MODE:-${existing_deploy_mode:-}}"
if [ -z "$DEPLOY_MODE" ]; then
  if [ "$existing_app_base_scheme" = "http" ]; then
    DEPLOY_MODE="http"
  else
    DEPLOY_MODE="tls"
  fi
fi

case "$DEPLOY_MODE" in
  tls|http) ;;
  *)
    echo "Unsupported SYNAPSE_DEPLOY_MODE: $DEPLOY_MODE" >&2
    echo "Use SYNAPSE_DEPLOY_MODE=tls or SYNAPSE_DEPLOY_MODE=http." >&2
    exit 1
    ;;
esac

DOMAIN="${SYNAPSE_PUBLIC_DOMAIN:-${existing_public_domain:-${existing_app_base_host:-change-me.example.com}}}"
PUBLIC_HOST="${SYNAPSE_PUBLIC_HOST:-${existing_public_host:-${existing_app_base_host:-$DOMAIN}}}"
HTTP_PORT="${SYNAPSE_HTTP_PORT:-${existing_http_port:-80}}"
WWW_DOMAIN="${SYNAPSE_WWW_DOMAIN:-$(read_env_value SYNAPSE_WWW_DOMAIN)}"
MOBILE_SHORT_DOMAIN="${SYNAPSE_MOBILE_SHORT_DOMAIN:-$(read_env_value SYNAPSE_MOBILE_SHORT_DOMAIN)}"
MOBILE_DOMAIN="${SYNAPSE_MOBILE_DOMAIN:-$(read_env_value SYNAPSE_MOBILE_DOMAIN)}"
REGISTRY_DOMAIN="${SYNAPSE_REGISTRY_DOMAIN:-$(read_env_value SYNAPSE_REGISTRY_DOMAIN)}"
LETSENCRYPT_CERT_NAME_VALUE="${LETSENCRYPT_CERT_NAME:-$(read_env_value LETSENCRYPT_CERT_NAME)}"
LETSENCRYPT_EMAIL_VALUE="${LETSENCRYPT_EMAIL:-$(read_env_value LETSENCRYPT_EMAIL)}"

if [ "$DEPLOY_MODE" = "http" ]; then
  DOMAIN="${SYNAPSE_PUBLIC_DOMAIN:-${existing_public_domain:-$PUBLIC_HOST}}"
  PUBLIC_SCHEME="http"
  WS_SCHEME="ws"
  APP_URL="$(url_for_public_endpoint "$PUBLIC_SCHEME" "$PUBLIC_HOST" "$HTTP_PORT")"
else
  PUBLIC_HOST="$DOMAIN"
  PUBLIC_SCHEME="https"
  WS_SCHEME="wss"
  APP_URL="$(url_for_public_endpoint "$PUBLIC_SCHEME" "$DOMAIN" "")"
fi

WWW_DOMAIN="${WWW_DOMAIN:-www.$DOMAIN}"
MOBILE_SHORT_DOMAIN="${MOBILE_SHORT_DOMAIN:-m.$DOMAIN}"
MOBILE_DOMAIN="${MOBILE_DOMAIN:-mobile.$DOMAIN}"
REGISTRY_DOMAIN="${REGISTRY_DOMAIN:-npmr.$DOMAIN}"
LETSENCRYPT_CERT_NAME_VALUE="${LETSENCRYPT_CERT_NAME_VALUE:-$DOMAIN}"
LETSENCRYPT_EMAIL_VALUE="${LETSENCRYPT_EMAIL_VALUE:-admin@$DOMAIN}"
WS_URL="$WS_SCHEME://${APP_URL#*://}"
# External-reachable URL of the private npm registry (end-user side). The
# API embeds it into the dashboard one-click daemon install command. The
# real registry host stays out of the repo — it lives only in this .env.
PUBLIC_NPM_REGISTRY_URL="${SYNAPSE_PUBLIC_NPM_REGISTRY_URL:-$(read_env_value PUBLIC_NPM_REGISTRY_URL)}"
PUBLIC_NPM_REGISTRY_URL="${PUBLIC_NPM_REGISTRY_URL:-$PUBLIC_SCHEME://$REGISTRY_DOMAIN/}"
API_PROXY_ORIGIN="${SYNAPSE_API_PROXY_ORIGIN:-http://localhost:3001}"
SELECTED_AI_PROVIDER="${SYNAPSE_AI_PROVIDER:-}"
SELECTED_AI_ENGINE_KIND="${SYNAPSE_AI_ENGINE_KIND:-}"
SELECTED_AI_BASE_URL="${SYNAPSE_AI_BASE_URL:-}"
SELECTED_AI_MODEL="${SYNAPSE_AI_MODEL:-}"
SELECTED_AI_API_KEY="${SYNAPSE_AI_API_KEY:-}"

case "$SELECTED_AI_PROVIDER" in
  anthropic)
    SELECTED_AI_ENGINE_KIND="${SELECTED_AI_ENGINE_KIND:-anthropic.messages}"
    SELECTED_AI_BASE_URL="${SELECTED_AI_BASE_URL:-https://api.anthropic.com}"
    SELECTED_AI_MODEL="${SELECTED_AI_MODEL:-claude-sonnet-4-20250514}"
    ;;
  openai)
    SELECTED_AI_ENGINE_KIND="${SELECTED_AI_ENGINE_KIND:-openai.chat_completions}"
    SELECTED_AI_BASE_URL="${SELECTED_AI_BASE_URL:-https://api.openai.com}"
    SELECTED_AI_MODEL="${SELECTED_AI_MODEL:-gpt-4.1}"
    ;;
  bigmodel)
    SELECTED_AI_ENGINE_KIND="${SELECTED_AI_ENGINE_KIND:-bigmodel.chat_completions}"
    SELECTED_AI_BASE_URL="${SELECTED_AI_BASE_URL:-https://open.bigmodel.cn/api}"
    SELECTED_AI_MODEL="${SELECTED_AI_MODEL:-glm-5.1}"
    ;;
esac

generate_password() {
  openssl rand -base64 32 | tr -d '/+=' | head -c 32
}

# Ed25519 signing key for device-dispatch envelopes, base64-encoded so it fits
# on a single .env line (envelope-signer decodes base64 PEM). Reuse an existing
# value across re-runs (rotating it would orphan already-paired devices).
SANDBOX_SIGNING_KEY="$(read_env_value SYNAPSE_DEVICE_ENVELOPE_SIGNING_KEY)"
if [ -z "$SANDBOX_SIGNING_KEY" ]; then
  SANDBOX_SIGNING_KEY="$(openssl genpkey -algorithm Ed25519 2>/dev/null | base64 | tr -d '\n')"
fi
# Shared frp token (frps + frpc + the sandbox backend must all agree).
FRP_SHARED_TOKEN_VALUE="$(read_env_value FRP_SHARED_TOKEN)"
if [ -z "$FRP_SHARED_TOKEN_VALUE" ]; then
  FRP_SHARED_TOKEN_VALUE="$(openssl rand -hex 32)"
fi

upsert_env_var() {
  local file="$1"
  local key="$2"
  local value="$3"

  if [ ! -f "$file" ]; then
    return
  fi

  if grep -q "^${key}=" "$file"; then
    local current
    current="$(sed -n "s/^${key}=//p" "$file" | tail -n 1)"
    if [ "$current" = "$value" ]; then
      return
    fi

    local tmp_file
    tmp_file="$(mktemp)"
    awk -v key="$key" -v value="$value" '
      BEGIN { replaced = 0 }
      $0 ~ "^" key "=" {
        if (!replaced) {
          print key "=" value
          replaced = 1
        }
        next
      }
      { print }
      END {
        if (!replaced) {
          print key "=" value
        }
      }
    ' "$file" > "$tmp_file"
    cat "$tmp_file" > "$file"
    rm -f "$tmp_file"
    ENV_FILES_UPDATED=true
    echo "Updated $key in $file"
  else
    {
      printf '\n'
      printf '%s=%s\n' "$key" "$value"
    } >> "$file"
    ENV_FILES_UPDATED=true
    echo "Added $key to $file"
  fi
}

ROOT_ENV_CREATED=false
WEB_ENV_CREATED=false
ENV_FILES_UPDATED=false

if [ ! -f "$ENV_FILE" ]; then
  POSTGRES_PASSWORD=$(generate_password)
  REDIS_PASSWORD=$(generate_password)
  APP_SECRET=$(generate_password)
  MCP_ENCRYPTION_KEY=$(generate_password)

  cat > "$ENV_FILE" <<EOF
# Auto-generated by setup.sh — $(date -u '+%Y-%m-%dT%H:%M:%SZ')
# Do NOT commit this file to git.

# PostgreSQL
POSTGRES_USER=synapse
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
POSTGRES_DB=synapse

# Redis
REDIS_PASSWORD=$REDIS_PASSWORD

# Application secrets
APP_SECRET=$APP_SECRET
MCP_ENCRYPTION_KEY=$MCP_ENCRYPTION_KEY

# Server-side actor isolation (sandbox). Off by default; flip ENABLED + BACKEND
# to turn on. Signing key is base64-encoded PEM (single line).
SYNAPSE_SANDBOX_ENABLED=false
SYNAPSE_SANDBOX_BACKEND=local
SYNAPSE_SANDBOX_TUNNEL=none
SYNAPSE_DEVICE_ENVELOPE_SIGNING_KEY=$SANDBOX_SIGNING_KEY
FRP_SHARED_TOKEN=$FRP_SHARED_TOKEN_VALUE

# Deployment domains
SYNAPSE_DEPLOY_MODE=$DEPLOY_MODE
SYNAPSE_PUBLIC_HOST=$PUBLIC_HOST
SYNAPSE_HTTP_PORT=$HTTP_PORT
SYNAPSE_PUBLIC_DOMAIN=$DOMAIN
SYNAPSE_WWW_DOMAIN=$WWW_DOMAIN
SYNAPSE_MOBILE_SHORT_DOMAIN=$MOBILE_SHORT_DOMAIN
SYNAPSE_MOBILE_DOMAIN=$MOBILE_DOMAIN
SYNAPSE_REGISTRY_DOMAIN=$REGISTRY_DOMAIN
LETSENCRYPT_CERT_NAME=$LETSENCRYPT_CERT_NAME_VALUE
LETSENCRYPT_EMAIL=$LETSENCRYPT_EMAIL_VALUE

# Application URLs
APP_BASE_URL=$APP_URL
BASE_URL=$APP_URL
NEXT_PUBLIC_APP_URL=$APP_URL
NEXT_PUBLIC_SITE_URL=$APP_URL

# Application runtime
PORT=3001
HOST=localhost
DATABASE_URL=postgresql://synapse:${POSTGRES_PASSWORD}@localhost:5432/synapse
REDIS_URL=redis://:${REDIS_PASSWORD}@localhost:6379
PLATFORM_ADMIN_EMAILS=demo@synapse.dev
STORAGE_DIR=storage/files
# Local-dev model settings. The production Docker image bakes the embedding
# model in and overrides these (download off, /app/models/memory) via the
# compose api environment block.
MEMORY_ALLOW_RUNTIME_MODEL_DOWNLOAD=true
MEMORY_MODEL_CACHE_DIR=storage/models/memory

# Private npm registry (end-user reachable URL). Used by the API to build
# the dashboard one-click daemon install command. Real host stays in .env.
PUBLIC_NPM_REGISTRY_URL=$PUBLIC_NPM_REGISTRY_URL

# Realtime ASR (Volcengine / Doubao Seed ASR Streaming 2.0)
ASR_PROVIDER=volcengine
VOLCENGINE_ASR_APP_ID=
VOLCENGINE_ASR_ACCESS_TOKEN=
VOLCENGINE_ASR_SECRET_KEY=
VOLCENGINE_ASR_RESOURCE_ID=volc.seedasr.sauc.duration
VOLCENGINE_ASR_WS_URL=wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async
VOLCENGINE_ASR_MAX_CONCURRENCY=3
VOLCENGINE_ASR_CONNECT_TIMEOUT_MS=10000
VOLCENGINE_ASR_IDLE_TIMEOUT_MS=15000

# Frontend runtime
NEXT_PUBLIC_API_URL=/api/v1
NEXT_PUBLIC_WS_URL=$WS_URL
EXPO_PUBLIC_API_URL=$APP_URL/api/v1
EXPO_BASE_URL=/mobile

# AI provider
AI_PROVIDER=$SELECTED_AI_PROVIDER
AI_ENGINE_KIND=$SELECTED_AI_ENGINE_KIND
AI_API_KEY=$SELECTED_AI_API_KEY
AI_BASE_URL=$SELECTED_AI_BASE_URL
AI_MODEL=$SELECTED_AI_MODEL
EOF

  chmod 600 "$ENV_FILE"
  ROOT_ENV_CREATED=true
  echo "Generated root env at $ENV_FILE"
else
  echo ".env already exists at $ENV_FILE"
fi

upsert_env_var "$ENV_FILE" SYNAPSE_DEPLOY_MODE "$DEPLOY_MODE"
upsert_env_var "$ENV_FILE" SYNAPSE_PUBLIC_HOST "$PUBLIC_HOST"
upsert_env_var "$ENV_FILE" SYNAPSE_HTTP_PORT "$HTTP_PORT"
upsert_env_var "$ENV_FILE" SYNAPSE_PUBLIC_DOMAIN "$DOMAIN"
upsert_env_var "$ENV_FILE" SYNAPSE_WWW_DOMAIN "$WWW_DOMAIN"
# Sandbox secrets — added to existing .env files too (don't rotate if present).
upsert_env_var "$ENV_FILE" SYNAPSE_DEVICE_ENVELOPE_SIGNING_KEY "$SANDBOX_SIGNING_KEY"
upsert_env_var "$ENV_FILE" FRP_SHARED_TOKEN "$FRP_SHARED_TOKEN_VALUE"
upsert_env_var "$ENV_FILE" SYNAPSE_MOBILE_SHORT_DOMAIN "$MOBILE_SHORT_DOMAIN"
upsert_env_var "$ENV_FILE" SYNAPSE_MOBILE_DOMAIN "$MOBILE_DOMAIN"
upsert_env_var "$ENV_FILE" SYNAPSE_REGISTRY_DOMAIN "$REGISTRY_DOMAIN"
upsert_env_var "$ENV_FILE" LETSENCRYPT_CERT_NAME "$LETSENCRYPT_CERT_NAME_VALUE"
upsert_env_var "$ENV_FILE" LETSENCRYPT_EMAIL "$LETSENCRYPT_EMAIL_VALUE"
upsert_env_var "$ENV_FILE" PUBLIC_NPM_REGISTRY_URL "$PUBLIC_NPM_REGISTRY_URL"
upsert_env_var "$ENV_FILE" APP_BASE_URL "$APP_URL"
upsert_env_var "$ENV_FILE" BASE_URL "$APP_URL"
upsert_env_var "$ENV_FILE" NEXT_PUBLIC_API_URL "/api/v1"
upsert_env_var "$ENV_FILE" NEXT_PUBLIC_WS_URL "$WS_URL"
upsert_env_var "$ENV_FILE" NEXT_PUBLIC_APP_URL "$APP_URL"
upsert_env_var "$ENV_FILE" NEXT_PUBLIC_SITE_URL "$APP_URL"
upsert_env_var "$ENV_FILE" EXPO_PUBLIC_API_URL "$APP_URL/api/v1"
upsert_env_var "$ENV_FILE" EXPO_BASE_URL "/mobile"

if [ ! -f "$WEB_ENV_FILE" ]; then
  mkdir -p "$(dirname "$WEB_ENV_FILE")"
  cat > "$WEB_ENV_FILE" <<EOF
# Auto-generated by setup.sh — $(date -u '+%Y-%m-%dT%H:%M:%SZ')
NEXT_PUBLIC_API_URL=/api/v1
NEXT_PUBLIC_WS_URL=$WS_URL
NEXT_PUBLIC_APP_URL=$APP_URL
NEXT_PUBLIC_SITE_URL=$APP_URL
# Optional: comma-separated hostnames or URLs for additional Next dev origins.
# NEXT_ALLOWED_DEV_ORIGINS=$DOMAIN
API_PROXY_ORIGIN=$API_PROXY_ORIGIN
EOF

  chmod 600 "$WEB_ENV_FILE"
  WEB_ENV_CREATED=true
  echo "Generated web env at $WEB_ENV_FILE"
else
  echo "Web env already exists at $WEB_ENV_FILE"
fi

upsert_env_var "$WEB_ENV_FILE" NEXT_PUBLIC_API_URL "/api/v1"
upsert_env_var "$WEB_ENV_FILE" NEXT_PUBLIC_WS_URL "$WS_URL"
upsert_env_var "$WEB_ENV_FILE" NEXT_PUBLIC_APP_URL "$APP_URL"
upsert_env_var "$WEB_ENV_FILE" NEXT_PUBLIC_SITE_URL "$APP_URL"
upsert_env_var "$WEB_ENV_FILE" API_PROXY_ORIGIN "$API_PROXY_ORIGIN"

if [ "$ROOT_ENV_CREATED" = false ] && [ "$WEB_ENV_CREATED" = false ] && [ "$ENV_FILES_UPDATED" = false ]; then
  echo "No env files were created."
  exit 0
fi

echo "Local secrets and URLs have been initialized."
echo ""
echo "Next steps:"
echo "  1. Install Docker and Docker Compose on the host if they are missing"
echo "  2. Run: docker compose --profile production build api web mobile-web"
echo "  3. Run: docker compose up -d postgres redis"
echo "  4. Run: docker compose --profile production run --rm api npm run db:rebuild:runtime -w packages/api"
if [ "$DEPLOY_MODE" = "http" ]; then
  echo "  5. Run: docker compose --profile production --profile http up -d api web mobile-web nginx-http"
else
  echo "  5. Run: ./infrastructure/scripts/issue-cert.sh"
  echo "  6. Run: docker compose --profile production --profile tls up -d api web mobile-web nginx"
fi
