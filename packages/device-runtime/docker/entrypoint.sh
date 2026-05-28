#!/usr/bin/env bash
# Entrypoint for the synapse-device cloud-sandbox image. Bootstrap once if
# the broker is empty, then exec into the daemon.
set -euo pipefail

BROKER_DIR="${SYNAPSE_BROKER_DIR:-/opt/synapse-device/state}"
mkdir -p "${BROKER_DIR}"

if [[ -z "${SYNAPSE_SERVER_ORIGIN:-}" ]]; then
  echo "synapse-device cloud entrypoint: SYNAPSE_SERVER_ORIGIN is required" >&2
  exit 2
fi

if [[ ! -f "${BROKER_DIR}/device-identity.json" ]]; then
  if [[ -z "${SYNAPSE_BOOTSTRAP_TOKEN:-}" ]]; then
    echo "synapse-device cloud entrypoint: first boot requires SYNAPSE_BOOTSTRAP_TOKEN" >&2
    exit 2
  fi
  echo "[synapse-device] bootstrapping cloud device against ${SYNAPSE_SERVER_ORIGIN}" >&2
  /usr/local/bin/synapse-device bootstrap \
    --broker-dir "${BROKER_DIR}" \
    --server "${SYNAPSE_SERVER_ORIGIN}" \
    --bootstrap-token "${SYNAPSE_BOOTSTRAP_TOKEN}"
fi

exec /usr/local/bin/synapse-device "$@" \
  --broker-dir "${BROKER_DIR}" \
  --server "${SYNAPSE_SERVER_ORIGIN}"
