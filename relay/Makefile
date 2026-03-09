VERSION ?= dev
LDFLAGS = -s -w -X main.Version=$(VERSION)

.PHONY: cli gui gui-dev clean test cli-all

# CLI binary (no CGO, pure Go)
cli:
	CGO_ENABLED=0 go build -ldflags="$(LDFLAGS)" -o synapse-relay ./cmd/synapse-relay

# GUI binary (requires Wails + WebView libs)
gui:
	cd cmd/synapse-relay-gui && wails build -ldflags="$(LDFLAGS)"

# GUI dev mode with hot reload
gui-dev:
	cd cmd/synapse-relay-gui && wails dev

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
