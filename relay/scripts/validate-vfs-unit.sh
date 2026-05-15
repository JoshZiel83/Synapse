#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib/validation-common.sh"

require_cmd go
require_cmd make

log "running relay VFS unit/build validation"

(
  cd "${RELAY_ROOT}"
  go test ./internal/config ./internal/builtinmcp/chrome ./internal/vfs ./internal/vfscli ./internal/relaycontroller ./internal/relayagent ./cmd/synapse-relay
  go test -tags 'relay_fuse,desktop_cua' ./internal/vfsmount ./cmd/synapse-relay-mount
  make cli
  make cli-desktop
  make mount-fuse
)

log "relay VFS unit/build validation passed"
