VERSION ?= dev
LDFLAGS = -s -w -X main.Version=$(VERSION)

.PHONY: cua-helper clean test

# synapse-device-cua-helper — Go sidecar binary for CUA primitives.
# The v2 relay CLI / GUI / mount / agent binaries have been removed; the v3
# device runtime lives in @synapse/device-runtime (TypeScript) and supervises
# this sidecar as a child process.
cua-helper:
	CGO_ENABLED=0 go build -ldflags="$(LDFLAGS)" -o synapse-device-cua-helper ./cmd/synapse-device-cua-helper

clean:
	rm -f synapse-device-cua-helper

test:
	go test ./...
