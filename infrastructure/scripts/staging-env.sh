#!/usr/bin/env bash
# Source this file (not exec) to load staging env for the current worktree.
# Derives a slug from the worktree path, ensures .env.staging.local exists,
# and exports the variables docker compose needs.
#
# Usage:
#   source infrastructure/scripts/staging-env.sh
#   docker compose -f docker-compose.staging.yml --profile staging up -d
#
# Idempotent: re-sourcing does nothing destructive.

# Resolve repo root.
__staging_env_script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
__staging_repo_root="$(cd "${__staging_env_script_dir}/../.." && pwd)"

# Slug = worktree dir name, sanitized to lowercase letters/digits/dash.
__staging_raw_slug="$(basename "${__staging_repo_root}")"
__staging_slug="$(echo "${__staging_raw_slug}" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9-' '-' | sed 's/--*/-/g; s/^-//; s/-$//')"

if [[ -z "${__staging_slug}" ]]; then
  echo "ERROR: failed to derive staging slug from ${__staging_repo_root}" >&2
  return 1 2>/dev/null || exit 1
fi

export SYNAPSE_STAGING_SLUG="${__staging_slug}"
export COMPOSE_PROJECT_NAME="synapse-stg-${SYNAPSE_STAGING_SLUG}"

__staging_env_file="${__staging_repo_root}/.env.staging.local"

if [[ ! -f "${__staging_env_file}" ]]; then
  echo "Allocating ports for staging slug=${SYNAPSE_STAGING_SLUG} ..."
  "${__staging_env_script_dir}/allocate-staging-ports.sh" "${__staging_env_file}"
fi

# Export variables from .env.staging.local.
set -a
# shellcheck disable=SC1090
source "${__staging_env_file}"
set +a

# Derived public URL of this staging instance (host-side address; staging nginx
# binds 0.0.0.0:${NGINX_PORT} and serves at root path, just on a different port
# from prod). Used to bake into web/mobile-web build args.
__staging_host="${SYNAPSE_STAGING_HOST:-127.0.0.1}"
export SYNAPSE_STAGING_HOST="${__staging_host}"
export SYNAPSE_STAGING_APP_URL="http://${__staging_host}:${NGINX_PORT}"
export SYNAPSE_STAGING_WS_URL="ws://${__staging_host}:${NGINX_PORT}/ws"

# Common docker-compose convenience.
export SYNAPSE_STAGING_COMPOSE_FILE="${__staging_repo_root}/docker-compose.staging.yml"

cat <<EOF
[staging-env] slug=${SYNAPSE_STAGING_SLUG}
[staging-env] project=${COMPOSE_PROJECT_NAME}
[staging-env] ports: pg=${PG_PORT} redis=${REDIS_PORT} nginx=${NGINX_PORT}
[staging-env] app: ${SYNAPSE_STAGING_APP_URL}
EOF

unset __staging_env_script_dir __staging_repo_root __staging_raw_slug __staging_slug __staging_env_file __staging_host
