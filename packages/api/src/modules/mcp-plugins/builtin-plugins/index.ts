import type { BuiltinOrgSeed } from "./types.js"
import { zAiSeed } from "./z-ai/index.js"
import { feishuSeed } from "./feishu/index.js"
import { aminerSeed } from "./aminer/index.js"
import { amapSeed } from "./amap/index.js"
import { figmaSeed } from "./figma/index.js"
import { githubSeed } from "./github/index.js"
import { gitlabSeed } from "./gitlab/index.js"
import { mijiaSeed } from "./mijia/index.js"
import { firecrawlSeed } from "./firecrawl/index.js"
import { notionSeed } from "./notion/index.js"
import { xhsSeed } from "./xhs/index.js"
import { bilibiliSeed } from "./bilibili/index.js"

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

// Firecrawl is a hosted remote MCP (no sidecar). It is overseas-only (decision
// D1); gate it behind an explicit enable flag so it never surfaces in a
// mainland deployment that should not reach mcp.firecrawl.dev. The fc- key is
// supplied per-install, so no deploy-level credential is needed to seed it.
const firecrawlEnabled =
  process.env.MCP_ENABLE_FIRECRAWL === "1" ||
  process.env.MCP_ENABLE_FIRECRAWL === "true"

// Notion proxies the optional notion-mcp sidecar (compose `notion` profile).
// Gate on the explicit enable flag AND the presence of NOTION_MCP_URL, so a
// deployment that hasn't started the sidecar does not surface an installable
// plugin that fails at connect time against a non-existent service.
const notionEnabled =
  (process.env.MCP_ENABLE_NOTION === "1" ||
    process.env.MCP_ENABLE_NOTION === "true") &&
  Boolean(process.env.NOTION_MCP_URL)

// 小红书 proxies the optional xhs-mcp sidecar (compose `xhs` profile). Same
// gating rationale as Notion: require both the enable flag and XHS_MCP_URL.
const xhsEnabled =
  Boolean(process.env.XHS_MCP_URL) &&
  (process.env.MCP_ENABLE_XHS === "1" || process.env.MCP_ENABLE_XHS === "true")

// 哔哩哔哩 proxies the optional bilibili-mcp sidecar (compose `bilibili`
// profile). Same gating rationale as Notion/小红书: require both the enable
// flag and BILIBILI_MCP_URL.
const bilibiliEnabled =
  Boolean(process.env.BILIBILI_MCP_URL) &&
  (process.env.MCP_ENABLE_BILIBILI === "1" ||
    process.env.MCP_ENABLE_BILIBILI === "true")

export const builtinSeeds: BuiltinOrgSeed[] = [
  feishuSeed,
  aminerSeed,
  amapSeed,
  githubSeed,
  gitlabSeed,
  zAiSeed,
  ...(mijiaEnabled ? [mijiaSeed] : []),
  ...(figmaEnabled && figmaCredentialed ? [figmaSeed] : []),
  ...(firecrawlEnabled ? [firecrawlSeed] : []),
  ...(notionEnabled ? [notionSeed] : []),
  ...(xhsEnabled ? [xhsSeed] : []),
  ...(bilibiliEnabled ? [bilibiliSeed] : []),
]

export type { BuiltinOrgSeed, BuiltinPluginSeed } from "./types.js"
