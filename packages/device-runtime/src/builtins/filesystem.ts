// Minimal in-TS filesystem builtin (stub). PR #9 replaces this with the full
// commandline + filesystem behavior; for v3.0 we ship a no-op listing tool so
// the catalog sync end-to-end smoke test (PR #4 / PR #6) has something real.

import type { CatalogProvider } from "../types.js"
import type {
  DeviceCatalogExposure,
  DeviceCatalogTool,
} from "@synapse/device-protocol"

const PROVIDER_KEY = "builtin.filesystem"

const LIST_TOOL: DeviceCatalogTool = {
  stable_key: "filesystem/list",
  name: "list_dir",
  description:
    "List entries under a directory inside the device VFS root. v3.0 skeleton — always returns an empty listing.",
  input_schema: {
    type: "object",
    properties: {
      path: { type: "string" },
    },
    required: [],
  },
}

export interface FilesystemBuiltinOptions {
  /**
   * Root directory exposed; if absent, the builtin reports the exposure as
   * healthy but the list tool returns no entries.
   */
  rootPath?: string
  displayName?: string
}

export function createFilesystemBuiltin(
  opts: FilesystemBuiltinOptions = {}
): CatalogProvider {
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
  }
}
