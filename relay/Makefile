VERSION ?= dev
LDFLAGS = -s -w -X main.Version=$(VERSION)

.PHONY: build clean test

build:
	CGO_ENABLED=0 go build -ldflags="$(LDFLAGS)" -o synapse-relay .

clean:
	rm -f synapse-relay

test:
	go test ./...

# Cross-compilation targets
build-linux-amd64:
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags="$(LDFLAGS)" -o synapse-relay-linux-amd64 .

build-linux-arm64:
	CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -ldflags="$(LDFLAGS)" -o synapse-relay-linux-arm64 .

build-darwin-amd64:
	CGO_ENABLED=0 GOOS=darwin GOARCH=amd64 go build -ldflags="$(LDFLAGS)" -o synapse-relay-darwin-amd64 .

build-darwin-arm64:
	CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 go build -ldflags="$(LDFLAGS)" -o synapse-relay-darwin-arm64 .

build-windows-amd64:
	CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -ldflags="$(LDFLAGS)" -o synapse-relay-windows-amd64.exe .

build-all: build-linux-amd64 build-linux-arm64 build-darwin-amd64 build-darwin-arm64 build-windows-amd64
