VERSION ?= dev
LDFLAGS = -s -w -X main.Version=$(VERSION)

.PHONY: cua-helper clean test

# synapse-device-cua-helper — Go sidecar binary for CUA primitives. Spawned by
# the TypeScript device runtime (packages/device-runtime) via JSON-RPC over
# stdio. See docs/device-runtime-v3.md §5.2 / §10.4.
#
# CGO is REQUIRED — DeskAct binds X11 / Cocoa / Win32 native APIs. On Linux
# the build needs libx11-dev + libxtst-dev + libxinerama-dev installed.
#
# -buildvcs=false: the binary's version is injected explicitly via
# -ldflags "-X main.Version" below, so Go's automatic VCS stamping adds
# nothing — and it FAILS ("error obtaining VCS status: exit status 128")
# whenever the build runs from a git worktree / linked checkout (e.g. the
# repo lives under .claude/worktrees or /projects/Synapse-dev). Disabling it
# keeps `npm run build:cua-helper` working in every checkout layout.
cua-helper:
	CGO_ENABLED=1 go build -buildvcs=false -ldflags="$(LDFLAGS)" -o synapse-device-cua-helper ./cmd/synapse-device-cua-helper

clean:
	rm -f synapse-device-cua-helper

test:
	go test -buildvcs=false ./...
