import test from "node:test"
import assert from "node:assert/strict"
import { createBrowserBuiltin, listCdpTargets } from "./browser.js"

test("browser builtin reports navigate + read-text tools", async () => {
  const builtin = createBrowserBuiltin({ cdpEndpoint: "http://127.0.0.1:9222" })
  const exposures = await builtin.describeExposures()
  assert.equal(exposures[0]!.builtin_kind, "browser")
  const names = exposures[0]!.tools.map((t) => t.name).sort()
  assert.deepEqual(names, ["browser_navigate", "browser_read_text"])
  assert.equal(exposures[0]!.metadata?.cdpEndpoint, "http://127.0.0.1:9222")
})

test("listCdpTargets filters by type='page'", async () => {
  const mockFetch: typeof fetch = (async () =>
    new Response(
      JSON.stringify([
        {
          id: "a",
          type: "page",
          url: "about:blank",
          webSocketDebuggerUrl: "ws://x",
        },
        {
          id: "b",
          type: "background_page",
          url: "x",
          webSocketDebuggerUrl: "ws://y",
        },
      ]),
      { status: 200 }
    )) as unknown as typeof fetch
  const targets = await listCdpTargets("http://127.0.0.1:9222", mockFetch)
  assert.equal(targets.length, 1)
  assert.equal(targets[0]!.id, "a")
})
