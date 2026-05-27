VERSION ?= dev
LDFLAGS = -s -w -X main.Version=$(VERSION)

.PHONY: cua-helper clean test

# synapse-device-cua-helper — Go sidecar binary for CUA primitives. Spawned by
# the TypeScript device runtime (packages/device-runtime) via JSON-RPC over
# stdio. See docs/device-runtime-v3.md §5.2 / §10.4.
#
# CGO is REQUIRED — DeskAct binds X11 / Cocoa / Win32 native APIs. On Linux
# the build needs libx11-dev + libxtst-dev + libxinerama-dev installed.
cua-helper:
	CGO_ENABLED=1 go build -ldflags="$(LDFLAGS)" -o synapse-device-cua-helper ./cmd/synapse-device-cua-helper

clean:
	rm -f synapse-device-cua-helper

test:
	go test ./...
