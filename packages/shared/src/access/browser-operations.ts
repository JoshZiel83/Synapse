import {
  BROWSER_OPERATION_REQUIRED_ACTION,
  RUNTIME_AUTHORIZATION_BROWSER_OPERATIONS,
  type BrowserOperation,
  type BrowserOperationRequiredAction,
} from "../constants/enums.js"

export const BROWSER_MANUAL_GRANT_OPERATIONS_BY_EXPOSURE = {
  navigation: ["page.read", "page.navigate"],
  read: ["page.read", "screenshot.capture", "console.read"],
  input: ["page.input"],
  network: ["network.list", "network.body.read"],
  performance: ["performance.trace"],
  script: ["script.evaluate"],
  // Exposures are advertised as coming soon but have no grantable tools today.
  extensions: [],
  webmcp: [],
} as const satisfies Record<string, readonly BrowserOperation[]>

export const SUPPORTED_BROWSER_MANUAL_GRANT_OPERATIONS = Array.from(
  new Set(Object.values(BROWSER_MANUAL_GRANT_OPERATIONS_BY_EXPOSURE).flat())
) as BrowserOperation[]
const operationsByExposure: Record<string, readonly BrowserOperation[]> =
  BROWSER_MANUAL_GRANT_OPERATIONS_BY_EXPOSURE

export function browserOperationsForExposureStableKey(
  stableKey: string | null | undefined
): readonly BrowserOperation[] {
  const match = stableKey?.match(/^builtin\/browser\/(.+)$/)
  if (!match) {
    return SUPPORTED_BROWSER_MANUAL_GRANT_OPERATIONS
  }
  return (
    operationsByExposure[match[1]] ?? SUPPORTED_BROWSER_MANUAL_GRANT_OPERATIONS
  )
}

export function isBrowserWriteOperation(operation: BrowserOperation): boolean {
  return BROWSER_OPERATION_REQUIRED_ACTION[operation] === "write"
}

export function browserActionForOperations(
  operations: Iterable<BrowserOperation>
): BrowserOperationRequiredAction {
  for (const operation of operations) {
    if (isBrowserWriteOperation(operation)) {
      return "write"
    }
  }
  return "read"
}

export function isSupportedBrowserManualGrantOperation(
  operation: unknown
): operation is BrowserOperation {
  return (
    typeof operation === "string" &&
    (SUPPORTED_BROWSER_MANUAL_GRANT_OPERATIONS as readonly string[]).includes(
      operation
    ) &&
    (RUNTIME_AUTHORIZATION_BROWSER_OPERATIONS as readonly string[]).includes(
      operation
    )
  )
}
