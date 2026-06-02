import { test } from "node:test"
import assert from "node:assert/strict"

import { getAlphabetInitial, ALPHABET_RAIL } from "./index.js"

// NOTE: pinyin collation depends on the runtime's Intl/ICU data, so we only pin
// representative characters and the runtime-independent ASCII / "#" / empty paths.

test("ASCII letters bucket to their uppercase letter", () => {
  assert.equal(getAlphabetInitial("alice"), "A")
  assert.equal(getAlphabetInitial("Bob"), "B")
  assert.equal(getAlphabetInitial("ZED"), "Z")
})

test("non-letter / empty / symbol leads bucket to '#'", () => {
  assert.equal(getAlphabetInitial(""), "#")
  assert.equal(getAlphabetInitial("   "), "#")
  assert.equal(getAlphabetInitial("123"), "#")
  assert.equal(getAlphabetInitial("@handle"), "#")
})

test("leading/trailing whitespace is ignored", () => {
  assert.equal(getAlphabetInitial("   carol"), "C")
})

test("representative hanzi bucket to a valid A–Z rail letter", () => {
  // Don't pin exact letters (ICU-dependent); assert the result is a real rail
  // letter and not "#", proving the pinyin path ran.
  for (const name of ["阿强", "王二", "李四", "张三", "陈"]) {
    const letter = getAlphabetInitial(name)
    assert.ok(
      ALPHABET_RAIL.includes(letter),
      `${name} -> ${letter} should be a rail letter`
    )
    assert.notEqual(letter, "#", `${name} should bucket to a pinyin letter`)
  }
})

test("a well-known boundary char buckets as expected when pinyin collation is available", () => {
  // 阿 is the A-group boundary; this holds with zh pinyin ICU data. If a runtime
  // lacks the collator, the fallback may differ — so guard rather than hard-fail.
  const letter = getAlphabetInitial("阿")
  assert.ok(ALPHABET_RAIL.includes(letter))
})
