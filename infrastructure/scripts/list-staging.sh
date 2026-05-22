#!/usr/bin/env bash
# List all synapse staging compose projects on this host, with their bound ports.
set -euo pipefail

if ! command -v docker >/dev/null 2>&1; then
  echo "docker not found" >&2
  exit 1
fi

projects=$(docker ps -a --format '{{.Label "com.docker.compose.project"}}' | sort -u | grep '^synapse-stg-' || true)
if [[ -z "${projects}" ]]; then
  echo "No staging projects found."
  exit 0
fi

printf '%-32s %-32s %-32s %s\n' PROJECT SERVICE STATE PORTS
while IFS= read -r project; do
  docker ps -a --filter "label=com.docker.compose.project=${project}" \
    --format '{{.Names}}|{{.State}}|{{.Ports}}' | \
    while IFS='|' read -r name state ports; do
      printf '%-32s %-32s %-32s %s\n' "${project}" "${name}" "${state}" "${ports}"
    done
done <<< "${projects}"
