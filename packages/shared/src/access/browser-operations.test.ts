import assert from "node:assert/strict"
import test from "node:test"

import {
  BROWSER_EXPOSURE_TOOLS,
  BROWSER_TOOL_MAP,
} from "@synapse/device-protocol/browser-tools"
import { BROWSER_OPERATION_REQUIRED_ACTION } from "../constants/enums.js"
import {
  BROWSER_MANUAL_GRANT_OPERATIONS_BY_EXPOSURE,
  SUPPORTED_BROWSER_MANUAL_GRANT_OPERATIONS,
  browserActionForOperations,
  browserOperationsForExposureStableKey,
  isBrowserWriteOperation,
} from "./browser-operations.js"

function uniqueSorted(values: readonly string[]) {
  return [...new Set(values)].sort()
}

test("manual browser grant operations stay aligned with browser exposure tool map", () => {
  for (const [exposure, tools] of Object.entries(BROWSER_EXPOSURE_TOOLS)) {
    const expected = uniqueSorted(
      tools.map((tool) => BROWSER_TOOL_MAP[tool]?.operation).filter(Boolean)
    )
    const actual = uniqueSorted(
      BROWSER_MANUAL_GRANT_OPERATIONS_BY_EXPOSURE[exposure] ?? []
    )
    assert.deepEqual(actual, expected, exposure)
    assert.deepEqual(
      uniqueSorted(
        browserOperationsForExposureStableKey(`builtin/browser/${exposure}`)
      ),
      expected,
      exposure
    )
  }
})

test("manual browser grant fallback uses only operations from supported exposures", () => {
  const fromExposures = uniqueSorted(
    Object.values(BROWSER_MANUAL_GRANT_OPERATIONS_BY_EXPOSURE).flat()
  )
  assert.deepEqual(
    uniqueSorted(SUPPORTED_BROWSER_MANUAL_GRANT_OPERATIONS),
    fromExposures
  )
  assert.deepEqual(
    uniqueSorted(browserOperationsForExposureStableKey(null)),
    fromExposures
  )
  assert.deepEqual(
    uniqueSorted(
      browserOperationsForExposureStableKey("builtin/browser/unknown")
    ),
    fromExposures
  )
})

test("manual browser grant action derivation follows operation action table", () => {
  for (const operation of SUPPORTED_BROWSER_MANUAL_GRANT_OPERATIONS) {
    assert.equal(
      isBrowserWriteOperation(operation),
      BROWSER_OPERATION_REQUIRED_ACTION[operation] === "write",
      operation
    )
  }
  assert.equal(
    browserActionForOperations(["page.read", "console.read"]),
    "read"
  )
  assert.equal(browserActionForOperations(["page.read", "page.input"]), "write")
})
