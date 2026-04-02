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
  | "chrome"
  | "commandline";

export interface RelaySpecialAuthorizationRequirement {
  kind: RelaySpecialMcpKind;
  effect: RuntimeGrantEffect;
  message: string;
  clientHint: string;
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
    normalized === "chrome" ||
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
      effect: {
        capability: "commandline",
        executor: "bash",
        cwdPrefix,
      },
      message: "Running bash commands on the relay requires user authorization.",
      clientHint:
        "Ask the user whether this command execution should be allowed once, for this actor, for this conversation, or always.",
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
      effect: {
        capability: "filesystem",
        path: resolvedPath,
        access,
      },
      message: `Access to ${resolvedPath} (${accessLabel}) requires user authorization.`,
      clientHint:
        "Ask the user whether this filesystem access should be allowed once, for this actor, for this conversation, or always.",
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
      effect: {
        capability: "cua",
        mode: "control",
      },
      message:
        "Desktop control actions on the relay require user authorization.",
      clientHint:
        "Ask the user whether desktop control should be allowed once, for this actor, for this conversation, or always.",
    };
  }

  if (builtinKind === "chrome") {
    return {
      kind: "chrome",
      effect: {
        capability: "chrome",
        mode: "automation",
      },
      message:
        "Browser automation on the relay requires user authorization.",
      clientHint:
        "Ask the user whether browser automation should be allowed once, for this actor, for this conversation, or always.",
    };
  }

  return null;
}
