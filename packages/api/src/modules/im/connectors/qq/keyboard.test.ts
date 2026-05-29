import test from "node:test"
import assert from "node:assert/strict"
import {
  buildQqInteractionKeyboard,
  parseQqInteractionButtonData,
  QQ_BUTTON_ACTION_TYPE_CALLBACK,
  QQ_BUTTON_PERMISSION_EVERYONE,
  QQ_BUTTON_STYLE_DANGER,
  QQ_BUTTON_STYLE_PRIMARY,
} from "./keyboard.js"
import { QQ_MSG_TYPE } from "./types.js"

test("buildQqInteractionKeyboard: single option produces msg_type=2 with one button", () => {
  const payload = buildQqInteractionKeyboard({
    interactionRequestId: "ir-1",
    title: "审批",
    fallbackText: "请处理",
    options: [
      {
        id: "approve",
        label: "✅ 同意",
        actionToken: "tok-1",
        style: "primary",
      },
    ],
  })
  assert.equal(payload.msg_type, QQ_MSG_TYPE.MARKDOWN)
  assert.ok(payload.markdown.content.includes("审批"))
  assert.ok(payload.markdown.content.includes("请处理"))
  assert.equal(payload.keyboard.content.rows.length, 1)
  const btn = payload.keyboard.content.rows[0]!.buttons[0]!
  assert.equal(btn.id, "approve")
  assert.equal(btn.render_data.label, "✅ 同意")
  assert.equal(btn.render_data.style, QQ_BUTTON_STYLE_PRIMARY)
  assert.equal(btn.action.type, QQ_BUTTON_ACTION_TYPE_CALLBACK)
  assert.equal(btn.action.permission.type, QQ_BUTTON_PERMISSION_EVERYONE)
  assert.equal(btn.action.data, "synapse-interaction:tok-1")
  assert.ok(btn.group_id?.startsWith("synapse-interaction-"))
  assert.ok(btn.action.unsupport_tips)
})

test("buildQqInteractionKeyboard: danger style maps to 2", () => {
  const payload = buildQqInteractionKeyboard({
    interactionRequestId: "ir-1",
    fallbackText: "确认删除",
    options: [
      {
        id: "deny",
        label: "❌ 拒绝",
        actionToken: "tok-deny",
        style: "danger",
      },
    ],
  })
  assert.equal(
    payload.keyboard.content.rows[0]!.buttons[0]!.render_data.style,
    QQ_BUTTON_STYLE_DANGER
  )
})

test("buildQqInteractionKeyboard: all buttons share group_id (mutex)", () => {
  const payload = buildQqInteractionKeyboard({
    interactionRequestId: "ir-mutex",
    fallbackText: "选一个",
    options: [
      { id: "a", label: "A", actionToken: "ta" },
      { id: "b", label: "B", actionToken: "tb" },
      { id: "c", label: "C", actionToken: "tc" },
    ],
  })
  const buttons = payload.keyboard.content.rows[0]!.buttons
  assert.equal(buttons.length, 3)
  const gid = buttons[0]!.group_id
  assert.ok(gid?.includes("ir-mutex"))
  for (const b of buttons) assert.equal(b.group_id, gid)
})

test("buildQqInteractionKeyboard: empty options throws", () => {
  assert.throws(() =>
    buildQqInteractionKeyboard({
      interactionRequestId: "ir-1",
      fallbackText: "x",
      options: [],
    })
  )
})

test("buildQqInteractionKeyboard: ≥6 options throws (v1 single-row cap)", () => {
  assert.throws(() =>
    buildQqInteractionKeyboard({
      interactionRequestId: "ir-1",
      fallbackText: "x",
      options: Array.from({ length: 6 }, (_, i) => ({
        id: `o${i}`,
        label: `L${i}`,
        actionToken: `t${i}`,
      })),
    })
  )
})

test("buildQqInteractionKeyboard: missing actionToken throws", () => {
  assert.throws(() =>
    buildQqInteractionKeyboard({
      interactionRequestId: "ir-1",
      fallbackText: "x",
      options: [{ id: "o", label: "L", actionToken: "" }],
    })
  )
})

test("parseQqInteractionButtonData: well-formed payload returns actionToken", () => {
  const res = parseQqInteractionButtonData("synapse-interaction:abc-123")
  assert.deepEqual(res, { actionToken: "abc-123" })
})

test("parseQqInteractionButtonData: missing/empty/non-synapse → null", () => {
  assert.equal(parseQqInteractionButtonData(undefined), null)
  assert.equal(parseQqInteractionButtonData(""), null)
  assert.equal(parseQqInteractionButtonData("foo:bar"), null)
  assert.equal(parseQqInteractionButtonData("synapse-interaction:"), null)
  assert.equal(parseQqInteractionButtonData("synapse-interaction:   "), null)
})
