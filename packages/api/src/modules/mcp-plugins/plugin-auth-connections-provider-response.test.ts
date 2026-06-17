import assert from "node:assert/strict"
import test from "node:test"

import {
  PluginAuthError,
  readProviderJsonObjectResponse,
} from "./plugin-auth-connections.js"

test("readProviderJsonObjectResponse accepts only JSON object responses", async () => {
  assert.deepEqual(
    await readProviderJsonObjectResponse(
      new Response('{"access_token":"token"}', {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      "OAuth token response"
    ),
    { access_token: "token" }
  )

  for (const body of ["[1,2,3]", "null", '"scalar"']) {
    await assert.rejects(
      readProviderJsonObjectResponse(
        new Response(body, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
        "OAuth token response"
      ),
      (error) => {
        assert.equal(error instanceof PluginAuthError, true)
        assert.equal((error as PluginAuthError).statusCode, 502)
        assert.equal(
          (error as Error).message,
          "OAuth token response must be a JSON object."
        )
        return true
      }
    )
  }

  await assert.rejects(
    readProviderJsonObjectResponse(
      new Response("{not-json", {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
      "OAuth token response"
    ),
    (error) => {
      assert.equal(error instanceof PluginAuthError, true)
      assert.equal((error as PluginAuthError).statusCode, 400)
      assert.equal(
        (error as Error).message,
        "OAuth token response must be valid JSON."
      )
      return true
    }
  )
})
