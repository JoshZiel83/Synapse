// Filesystem builtin (§4.5 / spec §10). v3.0 ships a VFS-backed list_dir tool
// when the operator supplies a rootPath; without one the exposure is still
// advertised but list_dir reports "no root configured" so the operator sees
// it on the dashboard and wires a path.

import type {
  CatalogProvider,
  CatalogToolInvocationResult,
} from "../types.js"
import type {
  DeviceCatalogExposure,
  DeviceCatalogTool,
} from "@synapse/device-protocol"
import { createLocalFsBackend, type VfsBackend } from "../vfs.js"
import { toolErrorResult } from "../mcp-host.js"

const PROVIDER_KEY = "builtin.filesystem"

const LIST_TOOL: DeviceCatalogTool = {
  stable_key: "filesystem/list",
  name: "list_dir",
  description:
    "List entries under a directory inside the device VFS root. Path is resolved against rootPath; .. traversal is rejected.",
  input_schema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path relative to rootPath" },
    },
    required: [],
  },
}

export interface FilesystemBuiltinOptions {
  /**
   * Root directory exposed; if absent, list_dir reports a runtime_constraint
   * error so the operator sees the misconfiguration on the dashboard.
   */
  rootPath?: string
  displayName?: string
}

export function createFilesystemBuiltin(
  opts: FilesystemBuiltinOptions = {}
): CatalogProvider {
  let backend: VfsBackend | null = null
  let started = false

  async function ensureBackend(): Promise<VfsBackend | null> {
    if (!opts.rootPath) return null
    if (!backend) backend = createLocalFsBackend({ rootPath: opts.rootPath })
    if (!started) {
      await backend.start()
      started = true
    }
    return backend
  }

  return {
    providerKey: PROVIDER_KEY,
    async describeExposures(): Promise<DeviceCatalogExposure[]> {
      return [
        {
          stable_key: "builtin/filesystem",
          display_name: opts.displayName ?? "Filesystem",
          transport: "builtin",
          builtin_kind: "filesystem",
          metadata: {
            rootPath: opts.rootPath ?? null,
            schemaVersion: 1,
          },
          tools: [LIST_TOOL],
        },
      ]
    },
    async invokeTool(input): Promise<CatalogToolInvocationResult> {
      if (input.toolName !== "list_dir") {
        return toolErrorResult({
          code: "invalid_request",
          message: `filesystem builtin does not handle ${input.toolName}`,
        })
      }
      // Device-side runtime authorization: list_dir is a read; require at
      // least one filesystem grant_spec with access in {read, write} whose
      // path_prefixes cover the requested path. Without this, an envelope
      // signed with empty grant_specs would silently list the root.
      const path =
        typeof input.args["path"] === "string"
          ? (input.args["path"] as string)
          : "/"
      if (input.envelope) {
        const fsGrants = (
          input.envelope.runtime_authorization?.grant_specs ?? []
        ).filter((g) => g.capability === "filesystem" && g.filesystem)
        const allowed = fsGrants.some((g) =>
          fsPolicyAllows(g.filesystem!, "read", path)
        )
        if (!allowed) {
          return toolErrorResult({
            code: "permission_denied",
            message: `list_dir(${path}) not covered by any filesystem grant`,
          })
        }
      }
      const fs = await ensureBackend()
      if (!fs) {
        return toolErrorResult({
          code: "runtime_constraint",
          message: "filesystem builtin has no rootPath configured",
        })
      }
      try {
        const entries = await fs.list(path)
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ path, entries }, null, 2),
            },
          ],
          _meta: { entry_count: entries.length },
        }
      } catch (err) {
        return toolErrorResult({
          code: "runtime_constraint",
          message: `list_dir failed: ${(err as Error).message}`,
        })
      }
    },
  }
}

function fsPolicyAllows(
  policy: { access: "read" | "write"; path_prefixes: string[] },
  needed: "read" | "write",
  path: string
): boolean {
  // write implies read; read does not imply write.
  if (needed === "write" && policy.access !== "write") return false
  if (policy.path_prefixes.length === 0) return false
  // Normalize the candidate so trailing-slash differences don't sneak past
  // (path "/etc/passwd" against prefix "/etc" → match; "/etcd" should NOT).
  const normalized = path.endsWith("/") ? path : path
  return policy.path_prefixes.some((prefix) => {
    if (prefix === path) return true
    const withSep = prefix.endsWith("/") ? prefix : prefix + "/"
    return normalized.startsWith(withSep)
  })
}
