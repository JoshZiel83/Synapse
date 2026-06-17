import test from "node:test"
import assert from "node:assert/strict"

import {
  BROWSER_OPERATION_REQUIRED_ACTION,
  BROWSER_TOOL_MAP,
  RUNTIME_AUTHORIZATION_BROWSER_OPERATIONS,
  browserActionCoversOperations,
} from "./browser-tools.js"

test("browser operation action table covers every browser operation", () => {
  for (const operation of RUNTIME_AUTHORIZATION_BROWSER_OPERATIONS) {
    assert.ok(
      BROWSER_OPERATION_REQUIRED_ACTION[operation],
      `missing required action for ${operation}`
    )
  }
})

test("browser write tools are reflected in the operation action table", () => {
  for (const [toolName, descriptor] of Object.entries(BROWSER_TOOL_MAP)) {
    if (descriptor.action === "write") {
      assert.equal(
        BROWSER_OPERATION_REQUIRED_ACTION[descriptor.operation],
        "write",
        `${toolName} requires write action for ${descriptor.operation}`
      )
    }
  }
})

test("browserActionCoversOperations rejects read grants for write operations", () => {
  assert.deepEqual(
    browserActionCoversOperations("read", ["page.read", "page.input"]),
    { ok: false, offending: ["page.input"] }
  )
  assert.deepEqual(browserActionCoversOperations("write", ["page.input"]), {
    ok: true,
  })
})
