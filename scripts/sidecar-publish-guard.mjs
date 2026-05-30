#!/usr/bin/env node
// prepublishOnly guard for the six @synapse/device-runtime-bundles-*
// platform sidecar packages.
//
// These packages must ONLY be published via
// scripts/publish-device-runtime-sidecars.sh, which stages each one to a
// temp dir and hoists publishConfig.os/cpu to top-level so npm's os/cpu
// filter installs only the host-matching sidecar. A naive
// `npm publish -w packages/device-runtime-bundles-<plat>` would skip that
// hoist and publish a package WITHOUT top-level os/cpu — consumers would
// then download all six sidecars on every host.
//
// So this guard fails by default and only passes when the publish wrapper
// sets SYNAPSE_SIDECAR_PUBLISH_OK=1 (after it has done the hoist). The
// wrapper copies this file into its staging dir, so `node
// ./sidecar-publish-guard.mjs` resolves there too.

if (process.env.SYNAPSE_SIDECAR_PUBLISH_OK === "1") {
  process.exit(0)
}

console.error(
  "\n[sidecar-publish-guard] REFUSING direct publish of a " +
    "@synapse/device-runtime-bundles-* sidecar.\n" +
    "  These must be published via:\n" +
    "    bash scripts/publish-device-runtime-sidecars.sh\n" +
    "  (which hoists publishConfig.os/cpu so npm fetches only the " +
    "matching one).\n"
)
process.exit(1)
