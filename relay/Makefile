VERSION ?= dev
LDFLAGS = -s -w -X main.Version=$(VERSION)

.PHONY: cli cli-desktop gui gui-dev gui-windows-installer clean test cli-all

# CLI binary (no CGO, pure Go)
cli:
	CGO_ENABLED=0 go build -ldflags="$(LDFLAGS)" -o synapse-relay ./cmd/synapse-relay

# CLI binary with built-in desktop CUA support (requires CGO + desktop libs)
cli-desktop:
	CGO_ENABLED=1 go build -tags=desktop_cua -ldflags="$(LDFLAGS)" -o synapse-relay-desktop ./cmd/synapse-relay

# GUI binary (requires Wails + WebView libs)
gui:
	node scripts/prepare-gui-build-assets.mjs --goos=$$(go env GOOS) --runtime-mode=portable
	cd cmd/synapse-relay-gui && wails build -tags desktop_cua -ldflags="$(LDFLAGS)"

gui-windows-installer:
	node scripts/prepare-gui-build-assets.mjs --goos=windows --runtime-mode=installer
	cd cmd/synapse-relay-gui && wails build -nsis -tags desktop_cua,relay_installer_runtime -ldflags="$(LDFLAGS)"

# GUI dev mode with hot reload
gui-dev:
	cd cmd/synapse-relay-gui && wails dev -tags desktop_cua

clean:
	rm -f synapse-relay synapse-relay-*
	rm -rf cmd/synapse-relay-gui/build/bin

test:
	go test ./...

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
