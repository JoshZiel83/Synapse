import { createHash } from "crypto"
import { mkdir, rm } from "fs/promises"
import os from "os"
import path from "path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { ToolDefinition } from "@synapse/shared"
import { createLogger } from "../../infrastructure/logger/index.js"

const log = createLogger("mcp.stdio")

type StdioEntryPointSpec = {
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
}

type ResolveContext = {
  config: Record<string, unknown>
  instanceKey: string
}

function getConfigValue(
  config: Record<string, unknown>,
  pathExpression: string
): unknown {
  const pathParts = pathExpression.split(".").filter(Boolean)
  let current: unknown = config
  for (const segment of pathParts) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined
    }
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

function stringifyTemplateValue(value: unknown): string {
  if (value === undefined || value === null) {
    return ""
  }
  if (typeof value === "string") {
    return value
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value)
  }
  return JSON.stringify(value)
}

function resolveTemplate(template: string, context: ResolveContext): string {
  return template.replace(/\$\{([^}]+)\}/g, (_match, rawExpression: string) => {
    const expression = rawExpression.trim()
    if (expression === "node") {
      return process.execPath
    }
    if (expression === "tmpdir") {
      return os.tmpdir()
    }
    if (expression.startsWith("env:")) {
      return process.env[expression.slice(4)] || ""
    }
    if (expression.startsWith("config:")) {
      return stringifyTemplateValue(
        getConfigValue(context.config, expression.slice(7))
      )
    }
    if (expression === "instanceKey") {
      return context.instanceKey
    }
    return ""
  })
}

function parseStdioEntryPoint(
  entryPoint: string,
  context: ResolveContext
): StdioEntryPointSpec {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(entryPoint) as Record<string, unknown>
  } catch (error) {
    throw new Error(
      `Invalid stdio entry point JSON: ${(error as Error).message}`
    )
  }

  const command =
    typeof parsed.command === "string"
      ? resolveTemplate(parsed.command, context)
      : ""
  if (!command) {
    throw new Error("Stdio entry point is missing a command")
  }

  const args = Array.isArray(parsed.args)
    ? parsed.args
        .filter((value): value is string => typeof value === "string")
        .map((value) => resolveTemplate(value, context))
    : []

  const env =
    parsed.env && typeof parsed.env === "object" && !Array.isArray(parsed.env)
      ? Object.fromEntries(
          Object.entries(parsed.env as Record<string, unknown>)
            .filter(([, value]) => typeof value === "string")
            .map(([key, value]) => [
              key,
              resolveTemplate(value as string, context),
            ])
            .filter(([, value]) => value !== "")
        )
      : {}

  const cwd =
    typeof parsed.cwd === "string"
      ? resolveTemplate(parsed.cwd, context)
      : undefined

  return { command, args, env, cwd }
}

function buildInstanceDirs(instanceKey: string) {
  const hash = createHash("sha256")
    .update(instanceKey)
    .digest("hex")
    .slice(0, 24)
  const root = path.join(os.tmpdir(), "synapse-mcp-stdio", hash)
  return {
    root,
    home: path.join(root, "home"),
    cache: path.join(root, "cache"),
    data: path.join(root, "data"),
    state: path.join(root, "state"),
    tmp: path.join(root, "tmp"),
  }
}

function mapToolDefinitions(
  tools: Array<{
    name: string
    description?: string
    inputSchema?: {
      type?: string
      properties?: Record<
        string,
        {
          type?: string
          description?: string
          enum?: string[]
          items?: { type?: string; enum?: string[] }
        }
      >
      required?: string[]
    }
  }>
): ToolDefinition[] {
  return tools.map((tool) => {
    const properties: Record<
      string,
      ToolDefinition["parameters"]["properties"][string]
    > = {}

    for (const [key, value] of Object.entries(
      tool.inputSchema?.properties || {}
    )) {
      properties[key] = {
        type: value.type || "string",
        description: value.description || "",
        ...(value.enum ? { enum: value.enum } : {}),
        ...(value.items
          ? {
              items: {
                type: value.items.type || "string",
                ...(value.items.enum ? { enum: value.items.enum } : {}),
              },
            }
          : {}),
      }
    }

    return {
      name: tool.name,
      description: tool.description || "",
      parameters: {
        type: "object",
        properties,
        required: tool.inputSchema?.required || [],
      },
    }
  })
}

export class McpStdioClient {
  private readonly client = new Client(
    {
      name: "synapse-mcp-client",
      version: "1.0.0",
    },
    { capabilities: {} }
  )

  private readonly transport: StdioClientTransport
  private readonly dirs: ReturnType<typeof buildInstanceDirs>

  constructor(
    entryPoint: string,
    config: Record<string, unknown>,
    instanceKey: string
  ) {
    const context: ResolveContext = { config, instanceKey }
    const spec = parseStdioEntryPoint(entryPoint, context)
    this.dirs = buildInstanceDirs(instanceKey)

    const env = {
      ...spec.env,
      HOME: this.dirs.home,
      XDG_CACHE_HOME: this.dirs.cache,
      XDG_DATA_HOME: this.dirs.data,
      XDG_STATE_HOME: this.dirs.state,
      TMPDIR: this.dirs.tmp,
    }

    this.transport = new StdioClientTransport({
      command: spec.command,
      args: spec.args,
      env,
      cwd: spec.cwd,
      stderr: "pipe",
    })

    this.transport.stderr?.on("data", (chunk) => {
      const message = chunk.toString().trim()
      if (!message) return
      log.error(`[MCP stdio] ${message}`)
    })
  }

  async initialize(): Promise<{
    capabilities: Record<string, unknown>
    serverInfo: Record<string, unknown>
  }> {
    await mkdir(this.dirs.home, { recursive: true })
    await mkdir(this.dirs.cache, { recursive: true })
    await mkdir(this.dirs.data, { recursive: true })
    await mkdir(this.dirs.state, { recursive: true })
    await mkdir(this.dirs.tmp, { recursive: true })

    await this.client.connect(this.transport)
    return {
      capabilities: (this.client.getServerCapabilities() || {}) as Record<
        string,
        unknown
      >,
      serverInfo: (this.client.getServerVersion() || {}) as Record<
        string,
        unknown
      >,
    }
  }

  async listTools(): Promise<ToolDefinition[]> {
    const result = await this.client.listTools()
    return mapToolDefinitions(result.tools || [])
  }

  async callTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<unknown> {
    return this.client.callTool({
      name,
      arguments: args,
    })
  }

  async shutdown(): Promise<void> {
    await this.client.close().catch(() => {})
    await rm(this.dirs.root, { recursive: true, force: true }).catch(() => {})
  }
}
