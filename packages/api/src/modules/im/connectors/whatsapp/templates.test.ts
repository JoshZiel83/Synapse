import test from "node:test"
import assert from "node:assert/strict"
import { buildTemplateMessage } from "./templates.js"

test("buildTemplateMessage: shapes a minimal template body", () => {
  const body = buildTemplateMessage({
    to: "15551230000",
    templateName: "hello_world",
    languageCode: "en_US",
  })
  assert.deepEqual(body, {
    to: "15551230000",
    type: "template",
    template: { name: "hello_world", language: { code: "en_US" } },
  })
})

test("buildTemplateMessage: includes components when provided", () => {
  const body = buildTemplateMessage({
    to: "p",
    templateName: "order_update",
    languageCode: "en",
    components: [
      { type: "body", parameters: [{ type: "text", text: "A123" }] },
    ],
  })
  const template = body.template as Record<string, unknown>
  assert.deepEqual(template.components, [
    { type: "body", parameters: [{ type: "text", text: "A123" }] },
  ])
})

test("buildTemplateMessage: omits empty components array", () => {
  const body = buildTemplateMessage({
    to: "p",
    templateName: "n",
    languageCode: "en",
    components: [],
  })
  const template = body.template as Record<string, unknown>
  assert.equal("components" in template, false)
})
