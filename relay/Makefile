.PHONY: test

# v3.0 note: the cua-helper sidecar moved to sidecars/cua/ — build it from
# there with `cd sidecars/cua && make cua-helper`. This module now contains
# only the Go-side policy matcher reference (internal/runtimeauth, codegen
# target of scripts/codegen/relay-policies.ts), the config loader, and
# deviceauth/relaypaths utilities retained for future Go sidecars.
test:
	go test ./...
