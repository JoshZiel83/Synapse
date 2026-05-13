import path from "node:path"
import type {
  RelayAuthorizationBrowserAction,
  RelayAuthorizationBrowserPolicy,
  RelayAuthorizationCUAAccess,
  RelayAuthorizationCommandlinePolicy,
  RelayAuthorizationFilesystemAccess,
  RelayAuthorizationGrantOption,
  RelayAuthorizationGrantSpec,
  RelayAuthorizationRequestedAction,
} from "@synapse/shared/types"

const FILESYSTEM_READ_TOOL_NAMES = new Set([
  "ListAllowedDirectories",
  "View",
  "ViewMany",
  "GetFile",
  "LS",
  "DirectoryTree",
  "Stat",
  "GlobTool",
  "GrepTool",
  "SearchFiles",
  "ListBackups",
  "GetBackup",
])

const FILESYSTEM_WRITE_TOOL_NAMES = new Set([
  "Edit",
  "Replace",
  "Patch",
  "UpdateStructuredData",
  "CreateDirectory",
  "Move",
  "Copy",
  "Delete",
  "RestoreBackup",
])

const CUA_WRITE_TOOL_NAMES = new Set([
  "desktop_move_pointer",
  "desktop_click",
  "desktop_drag",
  "desktop_scroll",
  "desktop_type_text",
  "desktop_press_keys",
])

const BROWSER_READ_TOOL_NAMES = new Set([
  "list_pages",
  "select_page",
  "get_console_message",
  "get_network_request",
  "list_console_messages",
  "list_network_requests",
  "lighthouse_audit",
  "performance_analyze_insight",
  "take_memory_snapshot",
  "take_screenshot",
  "take_snapshot",
  "wait_for",
  "screenshot",
])

const BROWSER_WRITE_TOOL_NAMES = new Set([
  "click",
  "close_page",
  "drag",
  "emulate",
  "evaluate",
  "evaluate_script",
  "fill",
  "fill_form",
  "handle_dialog",
  "hover",
  "navigate",
  "navigate_page",
  "new_page",
  "performance_start_trace",
  "performance_stop_trace",
  "press_key",
  "resize_page",
  "type_text",
  "upload_file",
])

const DANGEROUS_COMMAND_PREFIXES = new Set([
  "sh",
  "bash",
  "zsh",
  "fish",
  "csh",
  "tcsh",
  "ksh",
  "dash",
  "cmd",
  "powershell",
  "pwsh",
  "env",
  "xargs",
  "nice",
  "stdbuf",
  "nohup",
  "timeout",
  "time",
  "sudo",
  "doas",
  "pkexec",
])

export type RelaySpecialMcpKind =
  | "filesystem"
  | "cua"
  | "browser"
  | "commandline"

export interface RelaySpecialAuthorizationPlan {
  kind: RelaySpecialMcpKind
  requestedToolName: string
  toolStableKey: string
  reason: string
  requestedAction: RelayAuthorizationRequestedAction
  grantOptions: RelayAuthorizationGrantOption[]
}

type BrowserSiteContext = {
  origin?: string
  host?: string
  registrableDomain?: string
}

function asTrimmedString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined
}

function normalizeBuiltinKind(value: unknown): RelaySpecialMcpKind | null {
  const normalized = asTrimmedString(value)?.toLowerCase()
  if (
    normalized === "filesystem" ||
    normalized === "cua" ||
    normalized === "browser" ||
    normalized === "commandline"
  ) {
    return normalized
  }
  return null
}

function normalizeAbsolutePath(value: unknown) {
  const text = asTrimmedString(value)
  if (!text || !path.isAbsolute(text)) {
    return null
  }
  return path.resolve(path.normalize(text))
}

function normalizeDirectoryGrantPrefix(value: string) {
  return path.resolve(path.normalize(value))
}

function optionId(parts: Array<string | undefined | null>) {
  return parts
    .filter((value) => typeof value === "string" && value.length > 0)
    .join(":")
}

function pushGrantOption(
  options: RelayAuthorizationGrantOption[],
  option: RelayAuthorizationGrantOption
) {
  if (options.some((candidate) => candidate.id === option.id)) {
    return
  }
  options.push(option)
}

function formatPathPrefixes(pathPrefixes: string[]) {
  if (pathPrefixes.length === 0) {
    return ""
  }
  if (pathPrefixes.length === 1) {
    return pathPrefixes[0]!
  }
  if (pathPrefixes.length === 2) {
    return `${pathPrefixes[0]} and ${pathPrefixes[1]}`
  }
  return `${pathPrefixes[0]} and ${pathPrefixes.length - 1} more directories`
}

function collectFilesystemDirectoryPrefixes(
  visibleToolName: string,
  toolInput: Record<string, unknown>
) {
  const prefixes = new Set<string>()
  const pushPathPrefix = (
    candidate: unknown,
    mode: "file" | "directory" | "auto" = "auto"
  ) => {
    const resolved = normalizeAbsolutePath(candidate)
    if (!resolved) {
      return
    }
    let prefix = resolved
    if (mode === "file" || mode === "auto") {
      prefix = path.dirname(resolved)
    }
    prefixes.add(normalizeDirectoryGrantPrefix(prefix))
  }

  pushPathPrefix(toolInput.directory_path, "directory")
  pushPathPrefix(toolInput.file_path, "file")
  pushPathPrefix(toolInput.source_path, "file")
  pushPathPrefix(toolInput.destination_path, "file")
  pushPathPrefix(toolInput.target_path, "file")
  pushPathPrefix(
    toolInput.path,
    visibleToolName === "LS" || visibleToolName === "DirectoryTree"
      ? "directory"
      : "auto"
  )

  const files = Array.isArray(toolInput.files) ? toolInput.files : []
  for (const file of files) {
    if (file && typeof file === "object") {
      pushPathPrefix((file as Record<string, unknown>).file_path, "file")
    }
  }

  const operations = Array.isArray(toolInput.operations)
    ? toolInput.operations
    : []
  for (const operation of operations) {
    if (operation && typeof operation === "object") {
      pushPathPrefix((operation as Record<string, unknown>).file_path, "file")
    }
  }

  return Array.from(prefixes).sort()
}

function buildFilesystemGrantSpec(
  access: RelayAuthorizationFilesystemAccess,
  pathPrefixes: string[]
): RelayAuthorizationGrantSpec {
  return {
    capability: "filesystem",
    filesystem: {
      access,
      pathPrefixes,
    },
  }
}

function inferFilesystemPlan(params: {
  toolStableKey?: string
  visibleToolName: string
  toolInput: Record<string, unknown>
}) {
  const access = FILESYSTEM_WRITE_TOOL_NAMES.has(params.visibleToolName)
    ? "write"
    : FILESYSTEM_READ_TOOL_NAMES.has(params.visibleToolName)
      ? "read"
      : null
  if (!access) {
    return null
  }

  const directoryPrefixes = collectFilesystemDirectoryPrefixes(
    params.visibleToolName,
    params.toolInput
  )
  if (directoryPrefixes.length === 0) {
    return null
  }

  const requestedAction: RelayAuthorizationRequestedAction = {
    capability: "filesystem",
    toolName: params.visibleToolName,
    summary:
      access === "read"
        ? `Read relay filesystem content under ${formatPathPrefixes(directoryPrefixes)}`
        : `Write relay filesystem content under ${formatPathPrefixes(directoryPrefixes)}`,
    detail: directoryPrefixes.join("\n"),
    filesystem: {
      access,
      pathPrefixes: directoryPrefixes,
    },
  }

  return {
    kind: "filesystem" as const,
    requestedToolName: params.visibleToolName,
    toolStableKey:
      params.toolStableKey ||
      `synapse.builtin.filesystem.${params.visibleToolName}.v1`,
    reason:
      access === "read"
        ? "Reading relay filesystem content requires authorization."
        : "Writing relay filesystem content requires authorization.",
    requestedAction,
    grantOptions: [
      {
        id: optionId(["filesystem", access, ...directoryPrefixes]),
        summary:
          access === "read"
            ? `Allow reads under ${formatPathPrefixes(directoryPrefixes)}`
            : `Allow writes under ${formatPathPrefixes(directoryPrefixes)}`,
        detail: directoryPrefixes.join("\n"),
        grantSpec: buildFilesystemGrantSpec(access, directoryPrefixes),
      },
    ],
  }
}

function inferCUAPlan(params: {
  toolStableKey?: string
  visibleToolName: string
}) {
  if (!params.visibleToolName.startsWith("desktop_")) {
    return null
  }

  const access: RelayAuthorizationCUAAccess = CUA_WRITE_TOOL_NAMES.has(
    params.visibleToolName
  )
    ? "write"
    : "read"
  const requestedAction: RelayAuthorizationRequestedAction = {
    capability: "cua",
    toolName: params.visibleToolName,
    summary:
      access === "write"
        ? "Perform desktop input actions on the relay"
        : "Observe the relay desktop",
    detail: params.visibleToolName,
    cua: {
      access,
    },
  }

  return {
    kind: "cua" as const,
    requestedToolName: params.visibleToolName,
    toolStableKey:
      params.toolStableKey ||
      `synapse.builtin.cua.${params.visibleToolName}.v1`,
    reason:
      access === "write"
        ? "Desktop input on the relay requires authorization."
        : "Desktop observation on the relay requires authorization.",
    requestedAction,
    grantOptions: [
      {
        id: optionId(["cua", access]),
        summary:
          access === "write"
            ? "Allow desktop input actions"
            : "Allow desktop observation actions",
        grantSpec: {
          capability: "cua" as const,
          cua: {
            access,
          },
        },
      },
    ],
  }
}

function normalizeHost(value: string) {
  return value.trim().toLowerCase()
}

function isIpv4(host: string) {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)
}

function inferRegistrableDomain(host: string) {
  const normalized = normalizeHost(host)
  if (!normalized || normalized === "localhost" || isIpv4(normalized)) {
    return null
  }
  const labels = normalized.split(".").filter(Boolean)
  if (labels.length < 2) {
    return null
  }
  return labels.slice(-2).join(".")
}

function inferBrowserSiteContext(
  toolInput: Record<string, unknown>
): BrowserSiteContext | null {
  const rawUrl =
    asTrimmedString(toolInput.url) ||
    asTrimmedString(toolInput.page_url) ||
    asTrimmedString(toolInput.pageUrl) ||
    asTrimmedString(toolInput.browser_url) ||
    asTrimmedString(toolInput.browserUrl)
  if (!rawUrl) {
    return null
  }

  try {
    const parsed = new URL(rawUrl)
    const host = parsed.hostname ? normalizeHost(parsed.hostname) : undefined
    const origin =
      parsed.origin && parsed.origin !== "null"
        ? parsed.origin
        : `${parsed.protocol}${host ? `//${host}` : ""}`
    return {
      origin,
      host,
      registrableDomain: host
        ? inferRegistrableDomain(host) || undefined
        : undefined,
    }
  } catch {
    return null
  }
}

function buildBrowserGrantSpec(
  action: RelayAuthorizationBrowserAction,
  site: BrowserSiteContext | null,
  scopeType?: RelayAuthorizationBrowserPolicy["scopeType"]
): RelayAuthorizationGrantSpec {
  return {
    capability: "browser",
    browser: {
      action,
      scopeType,
      origin: site?.origin,
      host: site?.host,
      registrableDomain: site?.registrableDomain,
    },
  }
}

function inferBrowserPlan(params: {
  toolStableKey?: string
  visibleToolName: string
  toolInput: Record<string, unknown>
}) {
  const action = BROWSER_READ_TOOL_NAMES.has(params.visibleToolName)
    ? "read"
    : BROWSER_WRITE_TOOL_NAMES.has(params.visibleToolName)
      ? "write"
      : "write"
  const site = inferBrowserSiteContext(params.toolInput)

  const requestedAction: RelayAuthorizationRequestedAction = {
    capability: "browser",
    toolName: params.visibleToolName,
    summary: site?.host
      ? `Use browser ${action} actions on ${site.host}`
      : action === "read"
        ? "Inspect the relay browser"
        : "Control the relay browser",
    detail: site?.origin || params.visibleToolName,
    browser: {
      action,
      scopeType: site?.host ? "host" : site?.origin ? "origin" : undefined,
      origin: site?.origin,
      host: site?.host,
      registrableDomain: site?.registrableDomain,
    },
  }

  const grantOptions: RelayAuthorizationGrantOption[] = []
  if (site?.host) {
    pushGrantOption(grantOptions, {
      id: optionId(["browser", action, "host", site.host]),
      summary: `Allow ${action} actions on ${site.host}`,
      detail: site.origin,
      grantSpec: buildBrowserGrantSpec(action, site, "host"),
    })
  } else if (site?.origin) {
    pushGrantOption(grantOptions, {
      id: optionId(["browser", action, "origin", site.origin]),
      summary: `Allow ${action} actions on ${site.origin}`,
      grantSpec: buildBrowserGrantSpec(action, site, "origin"),
    })
  }

  if (site?.registrableDomain) {
    pushGrantOption(grantOptions, {
      id: optionId(["browser", action, "domain", site.registrableDomain]),
      summary: `Allow ${action} actions on ${site.registrableDomain} and subdomains`,
      detail: site.host,
      grantSpec: buildBrowserGrantSpec(action, site, "domain"),
    })
  }

  pushGrantOption(grantOptions, {
    id: optionId(["browser", action, "global"]),
    summary:
      action === "read"
        ? "Allow browser read actions anywhere"
        : "Allow browser write actions anywhere",
    grantSpec: buildBrowserGrantSpec(action, null),
  })

  return {
    kind: "browser" as const,
    requestedToolName: params.visibleToolName,
    toolStableKey:
      params.toolStableKey ||
      `synapse.builtin.browser.${params.visibleToolName}.v1`,
    reason:
      action === "read"
        ? "Browser inspection on the relay requires authorization."
        : "Browser automation on the relay requires authorization.",
    requestedAction,
    grantOptions,
  }
}

function normalizeCommandForMatch(value: unknown) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null
}

function extractCommandPrefix(command: string) {
  if (
    command.includes("\n") ||
    command.includes("&&") ||
    command.includes("||") ||
    command.includes(";") ||
    command.includes("|")
  ) {
    return null
  }
  const tokens = command.split(/\s+/).filter(Boolean)
  let index = 0
  while (index < tokens.length && /^[A-Za-z_]\w*=/.test(tokens[index]!)) {
    index += 1
  }
  const executable = tokens[index]
  if (!executable) {
    return null
  }
  if (DANGEROUS_COMMAND_PREFIXES.has(executable)) {
    return null
  }
  const next = tokens[index + 1]
  if (next && /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(next)) {
    return `${executable} ${next}`
  }
  if (/^[a-zA-Z0-9._-]+$/.test(executable) && !executable.includes("/")) {
    return executable
  }
  return null
}

function buildCommandGrantSpec(
  policy: RelayAuthorizationCommandlinePolicy
): RelayAuthorizationGrantSpec {
  return {
    capability: "commandline",
    commandline: policy,
  }
}

function inferCommandlinePlan(params: {
  toolStableKey?: string
  visibleToolName: string
  toolInput: Record<string, unknown>
}) {
  const command = normalizeCommandForMatch(params.toolInput.command)
  if (!command) {
    return null
  }

  const cwd = normalizeAbsolutePath(params.toolInput.cwd) || undefined
  const requestedAction: RelayAuthorizationRequestedAction = {
    capability: "commandline",
    toolName: params.visibleToolName,
    summary: `Run command ${command}`,
    detail: cwd ? `Working directory: ${cwd}` : undefined,
    commandline: {
      executor: "bash",
      commandMatchType: "exact",
      commandText: command,
      workingDirectory: cwd,
    },
  }

  const grantOptions: RelayAuthorizationGrantOption[] = [
    {
      id: optionId(["commandline", "exact", command, cwd]),
      summary: `Allow exact command ${command}`,
      detail: cwd ? `Working directory: ${cwd}` : undefined,
      grantSpec: buildCommandGrantSpec({
        executor: "bash",
        commandMatchType: "exact",
        commandText: command,
        workingDirectory: cwd,
      }),
    },
  ]

  const prefix = extractCommandPrefix(command)
  if (prefix && prefix !== command) {
    grantOptions.push({
      id: optionId(["commandline", "prefix", prefix, cwd]),
      summary: `Allow command prefix ${prefix} *`,
      detail: cwd ? `Working directory: ${cwd}` : undefined,
      grantSpec: buildCommandGrantSpec({
        executor: "bash",
        commandMatchType: "prefix",
        commandText: prefix,
        workingDirectory: cwd,
      }),
    })
  }

  grantOptions.push({
    id: optionId(["commandline", "tool", "bash", cwd]),
    summary: "Allow bash *",
    detail: cwd ? `Working directory: ${cwd}` : undefined,
    grantSpec: buildCommandGrantSpec({
      executor: "bash",
      commandMatchType: "tool",
      commandText: "bash",
      workingDirectory: cwd,
    }),
  })

  return {
    kind: "commandline" as const,
    requestedToolName: params.visibleToolName,
    toolStableKey:
      params.toolStableKey || "synapse.builtin.commandline.bash.v1",
    reason: "Executing shell commands on the relay requires authorization.",
    requestedAction,
    grantOptions,
  }
}

export function inferRelaySpecialAuthorizationPlan(params: {
  toolStableKey?: string
  visibleToolName: string
  toolInput: Record<string, unknown>
  exposureMetadata?: Record<string, unknown>
}): RelaySpecialAuthorizationPlan | null {
  const builtinKind = normalizeBuiltinKind(
    params.exposureMetadata?.builtinKind ||
      params.exposureMetadata?.builtin_kind ||
      params.exposureMetadata?.kind
  )

  if (builtinKind === "commandline" || params.visibleToolName === "bash") {
    return inferCommandlinePlan(params)
  }

  if (
    builtinKind === "filesystem" ||
    FILESYSTEM_READ_TOOL_NAMES.has(params.visibleToolName) ||
    FILESYSTEM_WRITE_TOOL_NAMES.has(params.visibleToolName)
  ) {
    return inferFilesystemPlan(params)
  }

  if (builtinKind === "cua" || params.visibleToolName.startsWith("desktop_")) {
    return inferCUAPlan(params)
  }

  if (builtinKind === "browser") {
    return inferBrowserPlan(params)
  }

  return null
}
