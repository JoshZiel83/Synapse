// Narrow, side-effect-free re-export of the device-runtime CONFIG schemas that
// the repo's JSON-Schema generator (packages/api/scripts/gen-config-schemas.mts)
// turns into schemas/*.schema.json. Kept as its own entry (exported as
// "@synapse/device-runtime/config-schemas") so the generator pulls in only these
// zod schemas, not the whole device runtime.
export { ToolchainManifestSchema } from "./terminal/manifest.js"
export { cliPrereqOverlaySchema } from "./builtins/cli-catalog/overlay-schema.js"
