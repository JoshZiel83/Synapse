// Leaf entrypoint: @synapse/device-runtime/builtin-presentation
//
// Aggregates every builtin tool's presentation descriptor into one lookup keyed
// by the presentation stableKey (`${exposure_stable_key}/${visible_tool_name}`).
//
// PURE DATA — this module imports ONLY the per-builtin *.presentation.ts files
// (each of which imports only the descriptor TYPE from @synapse/shared).
// It deliberately does NOT import any runtime builtin (filesystem.ts, etc.), so
// the API can import this leaf without pulling in VFS / terminal / sidecar /
// tunnel / semver. The dependency-purity test in
// builtin-presentation.test.ts enforces this.

import type { ToolPresentationDescriptor } from "@synapse/shared/tool-presentation"
import { FILESYSTEM_PRESENTATION } from "../builtins/filesystem.presentation.js"
import { COMMANDLINE_PRESENTATION } from "../builtins/commandline.presentation.js"
import { BROWSER_PRESENTATION } from "../builtins/browser.presentation.js"
import { CUA_PRESENTATION } from "../builtins/cua.presentation.js"
import { CHROME_PRESENTATION } from "../builtins/chrome.presentation.js"

export const BUILTIN_PRESENTATION: Record<string, ToolPresentationDescriptor> =
  {
    ...FILESYSTEM_PRESENTATION,
    ...COMMANDLINE_PRESENTATION,
    ...BROWSER_PRESENTATION,
    ...CUA_PRESENTATION,
    ...CHROME_PRESENTATION,
  }

/** Look up a builtin descriptor by presentation stableKey; undefined if none. */
export function getBuiltinPresentation(
  stableKey: string
): ToolPresentationDescriptor | undefined {
  return BUILTIN_PRESENTATION[stableKey]
}
