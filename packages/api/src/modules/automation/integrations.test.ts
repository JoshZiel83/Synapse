import assert from "node:assert/strict"
import test from "node:test"

import {
  registerIntegrationWebhook,
  type ResolvedIntegrationInstallation,
} from "./integrations.js"
import { parseAutomationProviderJsonObjectText } from "./provider-response-codec.js"

function githubInstallation(): ResolvedIntegrationInstallation {
  return {
    id: "installation-1",
    workspaceId: "00000000-0000-4000-8000-000000000001",
    provider: "github",
    orgSlug: "github",
    itemSlug: "github",
    configData: {
      apiKey: "gh-token",
      apiBaseUrl: "https://api.github.example",
    },
  }
}

async function withFetch<T>(
  handler: typeof fetch,
  run: () => Promise<T>
): Promise<T> {
  const originalFetch = globalThis.fetch
  globalThis.fetch = handler
  try {
    return await run()
  } finally {
    globalThis.fetch = originalFetch
  }
}

test("parseAutomationProviderJsonObjectText accepts only provider JSON objects", () => {
  assert.deepEqual(
    parseAutomationProviderJsonObjectText(
      JSON.stringify({ id: 123 }),
      "GitHub API response"
    ),
    { id: 123 }
  )

  assert.throws(
    () =>
      parseAutomationProviderJsonObjectText("{not-json", "GitHub API response"),
    /GitHub API response must be valid JSON/
  )

  for (const body of ["[1,2,3]", "null", '"ok"']) {
    assert.throws(
      () => parseAutomationProviderJsonObjectText(body, "GitHub API response"),
      /GitHub API response must be a JSON object/
    )
  }
})

test("registerIntegrationWebhook requires object provider create responses", async () => {
  await withFetch(
    (async () =>
      new Response(JSON.stringify({ id: 42 }), {
        status: 201,
        headers: { "content-type": "application/json" },
      })) as typeof fetch,
    async () => {
      const id = await registerIntegrationWebhook({
        installation: githubInstallation(),
        sourceKeys: ["github.push"],
        targetKind: "repository",
        targetId: "openai/synapse",
        targetLabel: "openai/synapse",
        callbackUrl: "https://api.example/automation",
        secret: "secret",
        name: "Synapse webhook",
        description: "Automation webhook",
      })
      assert.equal(id, "42")
    }
  )

  await withFetch(
    (async () =>
      new Response("[1,2,3]", {
        status: 201,
        headers: { "content-type": "application/json" },
      })) as typeof fetch,
    async () => {
      await assert.rejects(
        registerIntegrationWebhook({
          installation: githubInstallation(),
          sourceKeys: ["github.push"],
          targetKind: "repository",
          targetId: "openai/synapse",
          targetLabel: "openai/synapse",
          callbackUrl: "https://api.example/automation",
          secret: "secret",
          name: "Synapse webhook",
          description: "Automation webhook",
        }),
        /GitHub API response must be a JSON object/
      )
    }
  )
})
