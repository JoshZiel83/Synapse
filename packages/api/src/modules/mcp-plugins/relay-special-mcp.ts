import path from "node:path";
import type { RuntimeGrantEffect } from "@synapse/shared/types";

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

const CUA_CONTROL_TOOL_NAMES = new Set([
  "desktop_move_pointer",
  "desktop_click",
  "desktop_drag",
  "desktop_scroll",
  "desktop_type_text",
  "desktop_press_keys",
]);

export type RelaySpecialMcpKind =
  | "filesystem"
  | "cua"
  | "browser"
  | "commandline";

export interface RelaySpecialAuthorizationRequirement {
  kind: RelaySpecialMcpKind;
  toolStableKey: string;
  contractKey: string;
  effect: RuntimeGrantEffect;
  displayPayload: Record<string, unknown>;
  reason: string;
}

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

function inferFilesystemAccess(params: {
  visibleToolName: string;
  structuredAccess?: string;
  toolInput: Record<string, unknown>;
}): "read" | "write" | "read_write" | null {
  const structuredAccess = params.structuredAccess?.trim().toLowerCase();
  if (structuredAccess === "read" || structuredAccess === "ro") {
    return "read";
  }
  if (structuredAccess === "write") {
    return "write";
  }
  if (structuredAccess === "read_write" || structuredAccess === "rw") {
    return "read_write";
  }

  if (FILESYSTEM_WRITE_TOOL_NAMES.has(params.visibleToolName)) {
    return "write";
  }
  if (FILESYSTEM_READ_TOOL_NAMES.has(params.visibleToolName)) {
    return "read";
  }
  if (
    Object.prototype.hasOwnProperty.call(params.toolInput, "content") ||
    Object.prototype.hasOwnProperty.call(params.toolInput, "destination_path") ||
    Object.prototype.hasOwnProperty.call(params.toolInput, "old_string") ||
    Object.prototype.hasOwnProperty.call(params.toolInput, "new_string") ||
    Object.prototype.hasOwnProperty.call(params.toolInput, "operations") ||
    Object.prototype.hasOwnProperty.call(params.toolInput, "updates") ||
    Object.prototype.hasOwnProperty.call(params.toolInput, "target_path")
  ) {
    return "write";
  }

  return null;
}

function inferFilesystemPath(toolInput: Record<string, unknown>) {
  const candidates = [
    toolInput.directory_path,
    toolInput.file_path,
    toolInput.path,
    toolInput.destination_path,
    toolInput.source_path,
    toolInput.target_path,
  ];
  for (const candidate of candidates) {
    const value = asTrimmedString(candidate);
    if (value && path.isAbsolute(value)) {
      return path.normalize(value);
    }
  }
  return null;
}

export function inferRelaySpecialAuthorizationRequirement(params: {
  toolStableKey?: string;
  visibleToolName: string;
  toolInput: Record<string, unknown>;
  exposureMetadata?: Record<string, unknown>;
}): RelaySpecialAuthorizationRequirement | null {
  const builtinKind = normalizeBuiltinKind(
    params.exposureMetadata?.builtinKind ||
      params.exposureMetadata?.builtin_kind ||
      params.exposureMetadata?.kind,
  );

  if (builtinKind === "commandline" || params.visibleToolName === "bash") {
    const cwdPrefix = asTrimmedString(params.toolInput.cwd);
    return {
      kind: "commandline",
      toolStableKey:
        params.toolStableKey || "synapse.builtin.commandline.bash.v1",
      contractKey: "relay_builtin.commandline.exec",
      effect: {
        capability: "commandline",
        executor: "bash",
        cwdPrefix,
      },
      displayPayload: {
        executor: "bash",
        cwdPrefix: cwdPrefix || null,
      },
      reason: "Running shell commands on the relay requires user authorization.",
    };
  }

  if (
    builtinKind === "filesystem" ||
    FILESYSTEM_READ_TOOL_NAMES.has(params.visibleToolName) ||
    FILESYSTEM_WRITE_TOOL_NAMES.has(params.visibleToolName)
  ) {
    const access = inferFilesystemAccess({
      visibleToolName: params.visibleToolName,
      structuredAccess: undefined,
      toolInput: params.toolInput,
    });
    const resolvedPath = inferFilesystemPath(params.toolInput);
    if (!access || !resolvedPath) {
      return null;
    }
    const accessLabel =
      access === "read_write" ? "read and write" : access;
    return {
      kind: "filesystem",
      toolStableKey:
        params.toolStableKey ||
        `synapse.builtin.filesystem.${params.visibleToolName}.v1`,
      contractKey: "relay_builtin.filesystem.path_access",
      effect: {
        capability: "filesystem",
        path: resolvedPath,
        access,
      },
      displayPayload: {
        path: resolvedPath,
        access,
        accessLabel,
      },
      reason: `Access to ${resolvedPath} (${accessLabel}) requires user authorization.`,
    };
  }

  if (
    builtinKind === "cua" ||
    params.visibleToolName.startsWith("desktop_")
  ) {
    if (!CUA_CONTROL_TOOL_NAMES.has(params.visibleToolName)) {
      return null;
    }
    return {
      kind: "cua",
      toolStableKey:
        params.toolStableKey ||
        `synapse.builtin.cua.${params.visibleToolName}.v1`,
      contractKey: "relay_builtin.cua.control",
      effect: {
        capability: "cua",
        mode: "control",
      },
      displayPayload: {
        mode: "control",
      },
      reason: "Desktop control actions on the relay require user authorization.",
    };
  }

  if (builtinKind === "browser") {
    return {
      kind: "browser",
      toolStableKey:
        params.toolStableKey ||
        `synapse.builtin.browser.${params.visibleToolName}.v1`,
      contractKey: "relay_builtin.browser.automation",
      effect: {
        capability: "browser",
        mode: "automation",
      },
      displayPayload: {
        mode: "automation",
      },
      reason: "Browser automation on the relay requires user authorization.",
    };
  }

  return null;
}
