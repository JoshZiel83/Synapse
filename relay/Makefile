VERSION ?= dev
LDFLAGS = -s -w -X main.Version=$(VERSION)

.PHONY: cli cli-desktop mount-fuse gui gui-dev gui-windows-installer clean test cli-all test-vfs-unit validate-vfs-browser-headless validate-vfs-fuse-linux-headless validate-vfs-linux-headless non-github-preflight non-github-build

# CLI binary (no CGO, pure Go)
cli:
	CGO_ENABLED=0 go build -ldflags="$(LDFLAGS)" -o synapse-relay ./cmd/synapse-relay

# CLI binary with built-in desktop CUA support (requires CGO + desktop libs)
cli-desktop:
	CGO_ENABLED=1 go build -tags=desktop_cua -ldflags="$(LDFLAGS)" -o synapse-relay-desktop ./cmd/synapse-relay

# FUSE mount helper (requires CGO + platform FUSE runtime/headers)
mount-fuse:
	CGO_ENABLED=1 go build -tags="relay_fuse,desktop_cua" -ldflags="$(LDFLAGS)" -o synapse-relay-mount ./cmd/synapse-relay-mount

# GUI binary (requires Wails + WebView libs)
gui:
	node scripts/prepare-gui-build-assets.mjs --goos=$$(go env GOOS) --runtime-mode=portable
	cd cmd/synapse-relay-gui && wails build -tags desktop_cua -ldflags="$(LDFLAGS)"

gui-windows-installer:
	node scripts/prepare-gui-build-assets.mjs --goos=windows --runtime-mode=packaged
	cd cmd/synapse-relay-gui && wails build -nsis -tags desktop_cua,relay_packaged_runtime -ldflags="$(LDFLAGS)"

# GUI dev mode with hot reload
gui-dev:
	cd cmd/synapse-relay-gui && wails dev -tags desktop_cua

clean:
	rm -f synapse-relay synapse-relay-*
	rm -rf cmd/synapse-relay-gui/build/bin

test:
	go test ./...

test-vfs-unit:
	bash scripts/validate-vfs-unit.sh

validate-vfs-browser-headless:
	bash scripts/validate-vfs-browser-headless.sh

validate-vfs-fuse-linux-headless:
	bash scripts/validate-vfs-fuse-linux-headless.sh

validate-vfs-linux-headless:
	bash scripts/validate-vfs-linux-headless.sh

non-github-preflight:
	bash scripts/non-github-ci/preflight.sh --include-vms

non-github-build:
	bash scripts/non-github-ci/build-all.sh --version="$(VERSION)"

# Cross-compilation targets (CLI only, CGO_ENABLED=0)
cli-linux-amd64:
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags="$(LDFLAGS)" -o synapse-relay-linux-amd64 ./cmd/synapse-relay

cli-linux-arm64:
	CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -ldflags="$(LDFLAGS)" -o synapse-relay-linux-arm64 ./cmd/synapse-relay

cli-darwin-amd64:
	CGO_ENABLED=0 GOOS=darwin GOARCH=amd64 go build -ldflags="$(LDFLAGS)" -o synapse-relay-darwin-amd64 ./cmd/synapse-relay

cli-darwin-arm64:
	CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 go build -ldflags="$(LDFLAGS)" -o synapse-relay-darwin-arm64 ./cmd/synapse-relay

cli-windows-amd64:
	CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -ldflags="$(LDFLAGS)" -o synapse-relay-windows-amd64.exe ./cmd/synapse-relay

cli-all: cli-linux-amd64 cli-linux-arm64 cli-darwin-amd64 cli-darwin-arm64 cli-windows-amd64
