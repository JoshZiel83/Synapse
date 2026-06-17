const path = require("path")
// Sentry's drop-in for getDefaultConfig — adds the Debug ID serializer needed
// for source-map symbolication. Falls back to expo's default if unavailable.
const { getSentryExpoConfig } = require("@sentry/react-native/metro")
const { withNativeWind } = require("nativewind/metro")

const projectRoot = __dirname
const workspaceRoot = path.resolve(projectRoot, "../..")

const config = getSentryExpoConfig(projectRoot)

config.resolver.assetExts = [...(config.resolver.assetExts || []), "wasm"]

// IMPORTANT: preserve the monorepo resolver settings — these are what let Metro
// resolve @synapse/shared (@shared) from the workspace root. withNativeWind must
// wrap this config, not replace it.
config.watchFolders = [workspaceRoot]
config.resolver.blockList = [
  ...(config.resolver.blockList || []),
  new RegExp(
    `${path
      .resolve(workspaceRoot, "storage/files")
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\\\/].*`
  ),
]
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
]

module.exports = withNativeWind(config, { input: "./global.css" })
