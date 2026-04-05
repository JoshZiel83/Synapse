import path from "node:path";
import type {
  RelayAuthorizationApprovalOption,
  RelayAuthorizationBrowserScopeType,
  RelayAuthorizationRequirement,
} from "@synapse/shared/types";

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
]);

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
]);

const CUA_WRITE_TOOL_NAMES = new Set([
  "desktop_move_pointer",
  "desktop_click",
  "desktop_drag",
  "desktop_scroll",
  "desktop_type_text",
  "desktop_press_keys",
]);

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
]);

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
]);

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
]);

export type RelaySpecialMcpKind =
  | "filesystem"
  | "cua"
  | "browser"
  | "commandline";

export interface RelaySpecialAuthorizationPlan {
  kind: RelaySpecialMcpKind;
  requestedToolName: string;
  toolStableKey: string;
  reason: string;
  requiredRequirements: RelayAuthorizationRequirement[];
  approvalOptions: RelayAuthorizationApprovalOption[];
}

type BrowserSiteContext = {
  origin?: string;
  host?: string;
  registrableDomain?: string;
};

function asTrimmedString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function normalizeBuiltinKind(value: unknown): RelaySpecialMcpKind | null {
  const normalized = asTrimmedString(value)?.toLowerCase();
  if (
    normalized === "filesystem" ||
    normalized === "cua" ||
    normalized === "browser" ||
    normalized === "commandline"
  ) {
    return normalized;
  }
  return null;
}

function normalizeAbsolutePath(value: unknown) {
  const text = asTrimmedString(value);
  if (!text || !path.isAbsolute(text)) {
    return null;
  }
  return path.resolve(path.normalize(text));
}

function normalizeDirectoryGrantPrefix(value: string) {
  return path.resolve(path.normalize(value));
}

function requirementId(parts: Array<string | undefined | null>) {
  return parts.filter((value) => typeof value === "string" && value.length > 0).join(":");
}

function pushRequirement(
  requirements: RelayAuthorizationRequirement[],
  requirement: RelayAuthorizationRequirement,
) {
  if (requirements.some((candidate) => candidate.id === requirement.id)) {
    return;
  }
  requirements.push(requirement);
}

function pushApprovalOption(
  options: RelayAuthorizationApprovalOption[],
  option: RelayAuthorizationApprovalOption,
) {
  if (options.some((candidate) => candidate.id === option.id)) {
    return;
  }
  options.push(option);
}

function addFilesystemCommonRequirements(
  requirements: RelayAuthorizationRequirement[],
  options: RelayAuthorizationApprovalOption[],
  accessKind: "filesystem.read" | "filesystem.write",
  directoryPrefixes: string[],
) {
  const accessRequirementId = requirementId([accessKind]);
  pushRequirement(requirements, {
    id: accessRequirementId,
    kind: accessKind,
    summary:
      accessKind === "filesystem.read"
        ? "Allow filesystem reads"
        : "Allow filesystem writes",
  });
  pushApprovalOption(options, {
    id: accessRequirementId,
    kind: accessKind,
    summary:
      accessKind === "filesystem.read"
        ? "Allow filesystem reads"
        : "Allow filesystem writes",
    coversRequirementIds: [accessRequirementId],
    grantSpec: {
      kind: accessKind,
    },
  });

  for (const directoryPrefix of directoryPrefixes) {
    const normalizedPrefix = normalizeDirectoryGrantPrefix(directoryPrefix);
    const directoryRequirementId = requirementId([
      "filesystem.directory",
      normalizedPrefix,
    ]);
    pushRequirement(requirements, {
      id: directoryRequirementId,
      kind: "filesystem.directory",
      pathPrefix: normalizedPrefix,
      summary: `Allow directory ${normalizedPrefix}`,
    });
    pushApprovalOption(options, {
      id: directoryRequirementId,
      kind: "filesystem.directory",
      summary: `Allow directory ${normalizedPrefix}`,
      coversRequirementIds: [directoryRequirementId],
      grantSpec: {
        kind: "filesystem.directory",
        pathPrefix: normalizedPrefix,
      },
    });
  }
}

function collectFilesystemDirectoryPrefixes(
  visibleToolName: string,
  toolInput: Record<string, unknown>,
) {
  const prefixes = new Set<string>();
  const pushPathPrefix = (candidate: unknown, mode: "file" | "directory" | "auto" = "auto") => {
    const resolved = normalizeAbsolutePath(candidate);
    if (!resolved) {
      return;
    }
    let prefix = resolved;
    if (mode === "file") {
      prefix = path.dirname(resolved);
    } else if (mode === "auto") {
      prefix = path.dirname(resolved);
    }
    prefixes.add(normalizeDirectoryGrantPrefix(prefix));
  };

  pushPathPrefix(toolInput.directory_path, "directory");
  pushPathPrefix(toolInput.file_path, "file");
  pushPathPrefix(toolInput.source_path, "file");
  pushPathPrefix(toolInput.destination_path, "file");
  pushPathPrefix(toolInput.target_path, "file");
  pushPathPrefix(toolInput.path, visibleToolName === "LS" || visibleToolName === "DirectoryTree" ? "directory" : "auto");

  const files = Array.isArray(toolInput.files) ? toolInput.files : [];
  for (const file of files) {
    if (file && typeof file === "object") {
      pushPathPrefix((file as Record<string, unknown>).file_path, "file");
    }
  }

  const operations = Array.isArray(toolInput.operations) ? toolInput.operations : [];
  for (const operation of operations) {
    if (operation && typeof operation === "object") {
      pushPathPrefix((operation as Record<string, unknown>).file_path, "file");
    }
  }

  return Array.from(prefixes).sort();
}

function inferFilesystemPlan(params: {
  toolStableKey?: string;
  visibleToolName: string;
  toolInput: Record<string, unknown>;
}) {
  const accessKind = FILESYSTEM_WRITE_TOOL_NAMES.has(params.visibleToolName)
    ? "filesystem.write"
    : FILESYSTEM_READ_TOOL_NAMES.has(params.visibleToolName)
      ? "filesystem.read"
      : null;
  if (!accessKind) {
    return null;
  }

  const directoryPrefixes = collectFilesystemDirectoryPrefixes(
    params.visibleToolName,
    params.toolInput,
  );
  if (directoryPrefixes.length === 0) {
    return null;
  }

  const requiredRequirements: RelayAuthorizationRequirement[] = [];
  const approvalOptions: RelayAuthorizationApprovalOption[] = [];
  addFilesystemCommonRequirements(
    requiredRequirements,
    approvalOptions,
    accessKind,
    directoryPrefixes,
  );

  return {
    kind: "filesystem" as const,
    requestedToolName: params.visibleToolName,
    toolStableKey:
      params.toolStableKey ||
      `synapse.builtin.filesystem.${params.visibleToolName}.v1`,
    reason:
      accessKind === "filesystem.read"
        ? "Reading relay filesystem content requires authorization."
        : "Writing relay filesystem content requires authorization.",
    requiredRequirements,
    approvalOptions,
  };
}

function inferCUAPlan(params: {
  toolStableKey?: string;
  visibleToolName: string;
}) {
  if (!params.visibleToolName.startsWith("desktop_")) {
    return null;
  }

  const modeKind = CUA_WRITE_TOOL_NAMES.has(params.visibleToolName)
    ? "cua.write"
    : "cua.read";
  const requiredRequirements: RelayAuthorizationRequirement[] = [
    {
      id: "cua.tool",
      kind: "cua.tool",
      summary: "Allow desktop tool access",
    },
    {
      id: modeKind,
      kind: modeKind,
      summary:
        modeKind === "cua.write"
          ? "Allow desktop input actions"
          : "Allow desktop observation actions",
    },
  ];
  const approvalOptions: RelayAuthorizationApprovalOption[] = [
    {
      id: "cua.tool",
      kind: "cua.tool",
      summary: "Allow desktop tool access",
      coversRequirementIds: ["cua.tool"],
      grantSpec: {
        kind: "cua.tool",
      },
    },
    {
      id: modeKind,
      kind: modeKind,
      summary:
        modeKind === "cua.write"
          ? "Allow desktop input actions"
          : "Allow desktop observation actions",
      coversRequirementIds: [modeKind],
      grantSpec: {
        kind: modeKind,
      },
    },
  ];

  return {
    kind: "cua" as const,
    requestedToolName: params.visibleToolName,
    toolStableKey:
      params.toolStableKey || `synapse.builtin.cua.${params.visibleToolName}.v1`,
    reason:
      modeKind === "cua.write"
        ? "Desktop input on the relay requires authorization."
        : "Desktop observation on the relay requires authorization.",
    requiredRequirements,
    approvalOptions,
  };
}

function normalizeHost(value: string) {
  return value.trim().toLowerCase();
}

function isIpv4(host: string) {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);
}

function inferRegistrableDomain(host: string) {
  const normalized = normalizeHost(host);
  if (!normalized || normalized === "localhost" || isIpv4(normalized)) {
    return null;
  }
  const labels = normalized.split(".").filter(Boolean);
  if (labels.length < 2) {
    return null;
  }
  return labels.slice(-2).join(".");
}

function inferBrowserSiteContext(
  toolInput: Record<string, unknown>,
): BrowserSiteContext | null {
  const rawUrl =
    asTrimmedString(toolInput.url) ||
    asTrimmedString(toolInput.page_url) ||
    asTrimmedString(toolInput.pageUrl) ||
    asTrimmedString(toolInput.browser_url) ||
    asTrimmedString(toolInput.browserUrl);
  if (!rawUrl) {
    return null;
  }

  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname ? normalizeHost(parsed.hostname) : undefined;
    const origin =
      parsed.origin && parsed.origin !== "null"
        ? parsed.origin
        : `${parsed.protocol}${host ? `//${host}` : ""}`;
    return {
      origin,
      host,
      registrableDomain: host ? inferRegistrableDomain(host) || undefined : undefined,
    };
  } catch {
    return null;
  }
}

function addBrowserSiteRequirements(
  requirements: RelayAuthorizationRequirement[],
  options: RelayAuthorizationApprovalOption[],
  site: BrowserSiteContext,
) {
  const requirementIdValue = requirementId([
    "browser.site",
    site.origin,
    site.host,
    site.registrableDomain,
  ]);
  pushRequirement(requirements, {
    id: requirementIdValue,
    kind: "browser.site",
    browserOrigin: site.origin,
    browserHost: site.host,
    browserRegistrableDomain: site.registrableDomain,
    summary: site.host
      ? `Allow browser site ${site.host}`
      : `Allow browser origin ${site.origin}`,
  });

  const addSiteOption = (
    scopeType: RelayAuthorizationBrowserScopeType,
    summary: string,
  ) => {
    pushApprovalOption(options, {
      id: requirementId([scopeType, site.origin, site.host, site.registrableDomain]),
      kind: "browser.site",
      summary,
      coversRequirementIds: [requirementIdValue],
      grantSpec: {
        kind: "browser.site",
        browserScopeType: scopeType,
        browserOrigin: site.origin,
        browserHost: site.host,
        browserRegistrableDomain: site.registrableDomain,
      },
    });
  };

  if (site.host) {
    addSiteOption("host", `Allow host ${site.host}`);
    if (site.registrableDomain) {
      addSiteOption(
        "domain",
        `Allow domain ${site.registrableDomain} and subdomains`,
      );
    }
    return;
  }
  if (site.origin) {
    addSiteOption("origin", `Allow origin ${site.origin}`);
  }
}

function inferBrowserPlan(params: {
  toolStableKey?: string;
  visibleToolName: string;
  toolInput: Record<string, unknown>;
}) {
  const toolName = params.visibleToolName;
  const modeKind = BROWSER_READ_TOOL_NAMES.has(toolName)
    ? "browser.read"
    : BROWSER_WRITE_TOOL_NAMES.has(toolName)
      ? "browser.write"
      : "browser.write";

  const requiredRequirements: RelayAuthorizationRequirement[] = [
    {
      id: "browser.tool",
      kind: "browser.tool",
      summary: "Allow browser tool access",
    },
    {
      id: modeKind,
      kind: modeKind,
      summary:
        modeKind === "browser.read"
          ? "Allow browser read actions"
          : "Allow browser write actions",
    },
  ];
  const approvalOptions: RelayAuthorizationApprovalOption[] = [
    {
      id: "browser.tool",
      kind: "browser.tool",
      summary: "Allow browser tool access",
      coversRequirementIds: ["browser.tool"],
      grantSpec: {
        kind: "browser.tool",
      },
    },
    {
      id: modeKind,
      kind: modeKind,
      summary:
        modeKind === "browser.read"
          ? "Allow browser read actions"
          : "Allow browser write actions",
      coversRequirementIds: [modeKind],
      grantSpec: {
        kind: modeKind,
      },
    },
  ];

  const site = inferBrowserSiteContext(params.toolInput);
  if (site) {
    addBrowserSiteRequirements(requiredRequirements, approvalOptions, site);
  }

  return {
    kind: "browser" as const,
    requestedToolName: toolName,
    toolStableKey:
      params.toolStableKey || `synapse.builtin.browser.${toolName}.v1`,
    reason:
      modeKind === "browser.read"
        ? "Browser inspection on the relay requires authorization."
        : "Browser automation on the relay requires authorization.",
    requiredRequirements,
    approvalOptions,
  };
}

function normalizeCommandForMatch(value: unknown) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function extractCommandPrefix(command: string) {
  if (command.includes("\n") || command.includes("&&") || command.includes("||") || command.includes(";") || command.includes("|")) {
    return null;
  }
  const tokens = command.split(/\s+/).filter(Boolean);
  let index = 0;
  while (index < tokens.length && /^[A-Za-z_]\w*=/.test(tokens[index]!)) {
    index += 1;
  }
  const executable = tokens[index];
  if (!executable) {
    return null;
  }
  if (DANGEROUS_COMMAND_PREFIXES.has(executable)) {
    return null;
  }
  const next = tokens[index + 1];
  if (next && /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(next)) {
    return `${executable} ${next}`;
  }
  if (/^[a-zA-Z0-9._-]+$/.test(executable) && !executable.includes("/")) {
    return executable;
  }
  return null;
}

function inferCommandlinePlan(params: {
  toolStableKey?: string;
  visibleToolName: string;
  toolInput: Record<string, unknown>;
}) {
  const command = normalizeCommandForMatch(params.toolInput.command);
  if (!command) {
    return null;
  }

  const requiredRequirements: RelayAuthorizationRequirement[] = [
    {
      id: "commandline.tool",
      kind: "commandline.tool",
      summary: "Allow command execution tools",
    },
    {
      id: requirementId(["commandline.command", "bash", command]),
      kind: "commandline.command",
      commandExecutor: "bash",
      commandText: command,
      summary: `Allow command ${command}`,
    },
  ];

  const approvalOptions: RelayAuthorizationApprovalOption[] = [
    {
      id: "commandline.tool",
      kind: "commandline.tool",
      summary: "Allow command execution tools",
      coversRequirementIds: ["commandline.tool"],
      grantSpec: {
        kind: "commandline.tool",
      },
    },
    {
      id: requirementId(["commandline.command", "exact", command]),
      kind: "commandline.command",
      summary: `Allow exact command ${command}`,
      coversRequirementIds: [requirementId(["commandline.command", "bash", command])],
      grantSpec: {
        kind: "commandline.command",
        commandExecutor: "bash",
        commandMatchType: "exact",
        commandText: command,
      },
    },
  ];

  const cwd = normalizeAbsolutePath(params.toolInput.cwd);
  if (cwd) {
    const cwdRequirementId = requirementId(["commandline.directory", cwd]);
    requiredRequirements.push({
      id: cwdRequirementId,
      kind: "commandline.directory",
      pathPrefix: cwd,
      summary: `Allow working directory ${cwd}`,
    });
    approvalOptions.push({
      id: cwdRequirementId,
      kind: "commandline.directory",
      summary: `Allow working directory ${cwd}`,
      coversRequirementIds: [cwdRequirementId],
      grantSpec: {
        kind: "commandline.directory",
        pathPrefix: cwd,
      },
    });
  }

  const prefix = extractCommandPrefix(command);
  if (prefix && prefix !== command) {
    approvalOptions.push({
      id: requirementId(["commandline.command", "prefix", prefix]),
      kind: "commandline.command",
      summary: `Allow command prefix ${prefix} *`,
      coversRequirementIds: [requirementId(["commandline.command", "bash", command])],
      grantSpec: {
        kind: "commandline.command",
        commandExecutor: "bash",
        commandMatchType: "prefix",
        commandText: prefix,
      },
    });
  }

  return {
    kind: "commandline" as const,
    requestedToolName: params.visibleToolName,
    toolStableKey:
      params.toolStableKey || "synapse.builtin.commandline.bash.v1",
    reason: "Executing shell commands on the relay requires authorization.",
    requiredRequirements,
    approvalOptions,
  };
}

export function inferRelaySpecialAuthorizationPlan(params: {
  toolStableKey?: string;
  visibleToolName: string;
  toolInput: Record<string, unknown>;
  exposureMetadata?: Record<string, unknown>;
}): RelaySpecialAuthorizationPlan | null {
  const builtinKind = normalizeBuiltinKind(
    params.exposureMetadata?.builtinKind ||
      params.exposureMetadata?.builtin_kind ||
      params.exposureMetadata?.kind,
  );

  if (builtinKind === "commandline" || params.visibleToolName === "bash") {
    return inferCommandlinePlan(params);
  }

  if (
    builtinKind === "filesystem" ||
    FILESYSTEM_READ_TOOL_NAMES.has(params.visibleToolName) ||
    FILESYSTEM_WRITE_TOOL_NAMES.has(params.visibleToolName)
  ) {
    return inferFilesystemPlan(params);
  }

  if (builtinKind === "cua" || params.visibleToolName.startsWith("desktop_")) {
    return inferCUAPlan(params);
  }

  if (builtinKind === "browser") {
    return inferBrowserPlan(params);
  }

  return null;
}
