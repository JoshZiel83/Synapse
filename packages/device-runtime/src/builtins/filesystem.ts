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
      const fs = await ensureBackend()
      if (!fs) {
        return toolErrorResult({
          code: "runtime_constraint",
          message: "filesystem builtin has no rootPath configured",
        })
      }
      const path =
        typeof input.args["path"] === "string"
          ? (input.args["path"] as string)
          : "/"
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
