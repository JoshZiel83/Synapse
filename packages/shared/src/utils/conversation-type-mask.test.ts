import test from "node:test"
import assert from "node:assert/strict"
import {
  resolveConversationTypeKey,
  resolveConversationTypeBit,
  maskAllowsConversationType,
  maskAllowsConversationTypeKey,
  resolveNarrowedConversationTypeMask,
  conversationTypeMaskToKeys,
  normalizeConversationTypeMask,
} from "./index.js"
import {
  CONVERSATION_TYPE_MASK_BITS,
  CONVERSATION_TYPE_MASK_PRESETS,
  DEFAULT_CONVERSATION_TYPE_MASK,
} from "../constants/enums.js"

// resolveConversationTypeKey: (kind, isIm) -> the four derived keys
test("resolveConversationTypeKey: direct/group x native/IM", () => {
  assert.equal(resolveConversationTypeKey("direct", false), "direct")
  assert.equal(resolveConversationTypeKey("group", false), "group")
  assert.equal(resolveConversationTypeKey("direct", true), "im_direct")
  assert.equal(resolveConversationTypeKey("group", true), "im_group")
})

test("resolveConversationTypeKey: unknown/empty kind -> null", () => {
  for (const kind of [null, undefined, "", "private", "virtual", "channel"]) {
    assert.equal(resolveConversationTypeKey(kind, false), null)
    assert.equal(resolveConversationTypeKey(kind, true), null)
  }
})

test("resolveConversationTypeBit: matches the bit table", () => {
  assert.equal(
    resolveConversationTypeBit("direct", false),
    CONVERSATION_TYPE_MASK_BITS.direct
  )
  assert.equal(
    resolveConversationTypeBit("group", true),
    CONVERSATION_TYPE_MASK_BITS.im_group
  )
  assert.equal(resolveConversationTypeBit("nope", false), null)
})

// maskAllowsConversationTypeKey: the pure key form
test("maskAllowsConversationTypeKey: ALL allows every key", () => {
  for (const key of [
    "direct",
    "group",
    "im_direct",
    "im_group",
  ] as const) {
    assert.equal(
      maskAllowsConversationTypeKey(CONVERSATION_TYPE_MASK_PRESETS.ALL, key),
      true
    )
  }
})

test("maskAllowsConversationTypeKey: null key -> false", () => {
  assert.equal(
    maskAllowsConversationTypeKey(CONVERSATION_TYPE_MASK_PRESETS.ALL, null),
    false
  )
})

test("maskAllowsConversationTypeKey: NATIVE_ONLY excludes IM keys", () => {
  const mask = CONVERSATION_TYPE_MASK_PRESETS.NATIVE_ONLY
  assert.equal(maskAllowsConversationTypeKey(mask, "direct"), true)
  assert.equal(maskAllowsConversationTypeKey(mask, "group"), true)
  assert.equal(maskAllowsConversationTypeKey(mask, "im_direct"), false)
  assert.equal(maskAllowsConversationTypeKey(mask, "im_group"), false)
})

test("maskAllowsConversationTypeKey: IM_ONLY excludes native keys", () => {
  const mask = CONVERSATION_TYPE_MASK_PRESETS.IM_ONLY
  assert.equal(maskAllowsConversationTypeKey(mask, "direct"), false)
  assert.equal(maskAllowsConversationTypeKey(mask, "group"), false)
  assert.equal(maskAllowsConversationTypeKey(mask, "im_direct"), true)
  assert.equal(maskAllowsConversationTypeKey(mask, "im_group"), true)
})

test("maskAllowsConversationTypeKey: DIRECT_ONLY / GROUP_ONLY span both origins", () => {
  const direct = CONVERSATION_TYPE_MASK_PRESETS.DIRECT_ONLY
  assert.equal(maskAllowsConversationTypeKey(direct, "direct"), true)
  assert.equal(maskAllowsConversationTypeKey(direct, "im_direct"), true)
  assert.equal(maskAllowsConversationTypeKey(direct, "group"), false)
  assert.equal(maskAllowsConversationTypeKey(direct, "im_group"), false)

  const group = CONVERSATION_TYPE_MASK_PRESETS.GROUP_ONLY
  assert.equal(maskAllowsConversationTypeKey(group, "group"), true)
  assert.equal(maskAllowsConversationTypeKey(group, "im_group"), true)
  assert.equal(maskAllowsConversationTypeKey(group, "direct"), false)
  assert.equal(maskAllowsConversationTypeKey(group, "im_direct"), false)
})

// maskAllowsConversationType: the (mask, kind, isIm) convenience wrapper
test("maskAllowsConversationType: wrapper resolves key then checks", () => {
  assert.equal(
    maskAllowsConversationType(
      CONVERSATION_TYPE_MASK_PRESETS.IM_ONLY,
      "group",
      true
    ),
    true
  )
  assert.equal(
    maskAllowsConversationType(
      CONVERSATION_TYPE_MASK_PRESETS.IM_ONLY,
      "group",
      false
    ),
    false
  )
})

test("maskAllowsConversationType: missing/unknown kind -> false", () => {
  assert.equal(
    maskAllowsConversationType(
      CONVERSATION_TYPE_MASK_PRESETS.ALL,
      null,
      false
    ),
    false
  )
  assert.equal(
    maskAllowsConversationType(
      CONVERSATION_TYPE_MASK_PRESETS.ALL,
      "virtual",
      true
    ),
    false
  )
})

// mask bookkeeping
test("ALL preset is 15 (four keys) and DEFAULT equals ALL", () => {
  assert.equal(CONVERSATION_TYPE_MASK_PRESETS.ALL, 0b1111)
  assert.equal(DEFAULT_CONVERSATION_TYPE_MASK, CONVERSATION_TYPE_MASK_PRESETS.ALL)
})

test("normalizeConversationTypeMask: rejects out-of-range, falls back", () => {
  // bit 16 (old 'virtual') is no longer valid -> fall back to default
  assert.equal(normalizeConversationTypeMask(16), DEFAULT_CONVERSATION_TYPE_MASK)
  assert.equal(normalizeConversationTypeMask(31), DEFAULT_CONVERSATION_TYPE_MASK)
  assert.equal(normalizeConversationTypeMask(0), DEFAULT_CONVERSATION_TYPE_MASK)
  assert.equal(normalizeConversationTypeMask(0b0101), 0b0101)
})

test("conversationTypeMaskToKeys: decodes a mask into its keys", () => {
  assert.deepEqual(conversationTypeMaskToKeys(CONVERSATION_TYPE_MASK_PRESETS.ALL), [
    "direct",
    "group",
    "im_direct",
    "im_group",
  ])
  assert.deepEqual(
    conversationTypeMaskToKeys(CONVERSATION_TYPE_MASK_PRESETS.IM_ONLY),
    ["im_direct", "im_group"]
  )
})

test("resolveNarrowedConversationTypeMask: intersects parent with override", () => {
  const narrowed = resolveNarrowedConversationTypeMask(
    CONVERSATION_TYPE_MASK_PRESETS.ALL,
    CONVERSATION_TYPE_MASK_PRESETS.IM_ONLY
  )
  assert.equal(narrowed, CONVERSATION_TYPE_MASK_PRESETS.IM_ONLY)
  // null override -> parent unchanged
  assert.equal(
    resolveNarrowedConversationTypeMask(
      CONVERSATION_TYPE_MASK_PRESETS.NATIVE_ONLY,
      null
    ),
    CONVERSATION_TYPE_MASK_PRESETS.NATIVE_ONLY
  )
})
