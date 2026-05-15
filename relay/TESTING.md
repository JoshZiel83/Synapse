# Relay Testing

This document standardizes the relay VFS and FUSE validation flow introduced for builtin `browser` and `cua`.

## Scope

The standardized flow covers:

- relay VFS unit and contract tests
- host binary builds for `synapse-relay`, `synapse-relay-desktop`, and `synapse-relay-mount`
- Linux headless browser DOM validation over a persistent VFS harness
- Linux headless FUSE validation over a mounted filesystem
- Linux no-GUI CUA fallback validation for the AT-SPI semantic tree surface

It does not try to automate a real GUI desktop validation on Linux/macOS/Windows. Those still need native machines with a real desktop session.

## Local Prerequisites

For Linux headless validation, install:

- Go toolchain
- `make`
- `curl`
- `python3`
- `libfuse-dev`
- `libfuse2t64`
- `libfuse3-dev`
- `python3-pyatspi`
- a Chrome or Chromium binary

The scripts auto-detect `google-chrome-stable`, `google-chrome`, `chromium`, or `chromium-browser`.
If your browser lives elsewhere, set `VALIDATE_BROWSER_BIN=/absolute/path/to/browser`.
The browser-oriented scripts also auto-prepare the bundled Node and Chrome DevTools runtime for the current host platform when the checked-in manifest points at a different platform.

## Standard Commands

From [relay/Makefile](/home/ubuntu/project/synapse-relay-vfs-dom-semantic-fuse/relay/Makefile):

- `make test-vfs-unit`
  - runs the targeted VFS/FUSE Go tests and host binary builds
- `make validate-vfs-browser-headless`
  - validates real DOM tree access through a persistent in-process VFS harness
- `make validate-vfs-fuse-linux-headless`
  - validates FUSE mount behavior plus Linux headless CUA fallback
- `make validate-vfs-linux-headless`
  - runs all of the above in order

## Script Reference

- [validation-common.sh](/home/ubuntu/project/synapse-relay-vfs-dom-semantic-fuse/relay/scripts/lib/validation-common.sh)
  - shared helpers for temp dirs, config generation, HTTP fixture setup, browser detection, and JSON assertions
- [validate-vfs-unit.sh](/home/ubuntu/project/synapse-relay-vfs-dom-semantic-fuse/relay/scripts/validate-vfs-unit.sh)
  - unit/build validation entry point
- [validate-vfs-browser-headless.sh](/home/ubuntu/project/synapse-relay-vfs-dom-semantic-fuse/relay/scripts/validate-vfs-browser-headless.sh)
  - direct VFS service validation with a persistent process
- [validate-vfs-browser-headless.go](/home/ubuntu/project/synapse-relay-vfs-dom-semantic-fuse/relay/scripts/validate-vfs-browser-headless.go)
  - Go harness used by the browser validation script to keep session state alive across multiple VFS operations
- [validate-vfs-fuse-linux-headless.sh](/home/ubuntu/project/synapse-relay-vfs-dom-semantic-fuse/relay/scripts/validate-vfs-fuse-linux-headless.sh)
  - mounted filesystem validation
- [validate-vfs-linux-headless.sh](/home/ubuntu/project/synapse-relay-vfs-dom-semantic-fuse/relay/scripts/validate-vfs-linux-headless.sh)
  - umbrella entry point

## Environment Knobs

- `VALIDATE_SKIP_BUILD=1`
  - skip rebuilding binaries when they are already up to date
- `VALIDATE_KEEP_TMP=1`
  - preserve the temporary validation workspace under `/tmp`
- `VALIDATE_TMP_PARENT=/custom/tmp`
  - override the parent temp directory
- `VALIDATION_MARKER=value`
  - override the DOM marker string written during browser validation
- `VALIDATE_BROWSER_BIN=/path/to/browser`
  - force a specific browser executable
- `BUNDLED_NODE_VERSION=value`
  - override the host Node bundle version used by validation runtime prep
- `CHROME_DEVTOOLS_MCP_VERSION=value`
  - override the bundled `chrome-devtools-mcp` version used by validation runtime prep

## CI Boundary

GitHub-hosted CI reuses the targeted unit/build validation script, but it does not run the full Linux headless FUSE integration flow.

Reasons:

- hosted runners do not guarantee usable `/dev/fuse`
- hosted runners do not guarantee a local Chrome/Chromium binary in the expected location
- the Linux CUA semantic tree behavior depends on the presence or absence of a real AT-SPI desktop session

So the standard split is:

- CI: `make test-vfs-unit`
- local Linux machine: `make validate-vfs-linux-headless`

One important detail:

- repeated `synapse-relay vfs ...` CLI invocations are intentionally stateless because each command creates and closes its own VFS service
- sessionful browser flows therefore use either the persistent Go harness or a mounted FUSE filesystem
