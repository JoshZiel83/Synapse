import type { BuiltinOrgSeed } from "./types.js"
import { zAiSeed } from "./z-ai/index.js"
import { feishuSeed } from "./feishu/index.js"
import { aminerSeed } from "./aminer/index.js"
import { amapSeed } from "./amap/index.js"
import { figmaSeed } from "./figma/index.js"
import { githubSeed } from "./github/index.js"
import { gitlabSeed } from "./gitlab/index.js"
import { mijiaSeed } from "./mijia/index.js"

// Figma's remote MCP gates the mcp:connect OAuth scope to Catalog-approved
// clients, so seeding it before Synapse holds an approved OAuth app would
// surface a plugin whose connect step always fails. Gate on the explicit
// enable flag AND the presence of both OAuth client credentials.
const figmaEnabled =
  process.env.MCP_ENABLE_FIGMA === "1" ||
  process.env.MCP_ENABLE_FIGMA === "true"
const figmaCredentialed = Boolean(
  process.env.FIGMA_OAUTH_CLIENT_ID && process.env.FIGMA_OAUTH_CLIENT_SECRET
)

// Mijia proxies the optional mijia-mcp sidecar (compose `mijia` profile). Only
// seed it when MIJIA_MCP_URL is actually set, so a default `--profile
// production` deployment that hasn't started the sidecar does not surface an
// installable plugin that fails at connect time against a non-existent service.
const mijiaEnabled = Boolean(process.env.MIJIA_MCP_URL)

export const builtinSeeds: BuiltinOrgSeed[] = [
  feishuSeed,
  aminerSeed,
  amapSeed,
  githubSeed,
  gitlabSeed,
  zAiSeed,
  ...(mijiaEnabled ? [mijiaSeed] : []),
  ...(figmaEnabled && figmaCredentialed ? [figmaSeed] : []),
]

export type { BuiltinOrgSeed, BuiltinPluginSeed } from "./types.js"
