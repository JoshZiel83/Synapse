import assert from "node:assert/strict"
import test from "node:test"
import { normalizeFileAssetJoinRow, type FileAssetDbRow } from "./repo.js"
import {
  normalizeFileParseOutputRow,
  type FileParseOutputDbRow,
} from "./repo-parse.js"

test("normalizeFileAssetJoinRow decodes file origin details at repo exit", () => {
  const row = normalizeFileAssetJoinRow({
    detailsJson: JSON.stringify({ source: "composer" }),
  } as FileAssetDbRow)

  assert.deepEqual(row.details, { source: "composer" })
})

test("normalizeFileAssetJoinRow rejects malformed origin details at repo exit", () => {
  assert.throws(
    () =>
      normalizeFileAssetJoinRow({
        detailsJson: "not json",
      } as FileAssetDbRow),
    /file asset detailsJson must be valid JSON/
  )
})

test("normalizeFileAssetJoinRow rejects non-object origin details at repo exit", () => {
  assert.throws(
    () =>
      normalizeFileAssetJoinRow({
        detailsJson: JSON.stringify(["not-object"]),
      } as FileAssetDbRow),
    /file asset detailsJson must be a JSON object/
  )
})

test("normalizeFileParseOutputRow decodes structured output JSON at repo exit", () => {
  const row = normalizeFileParseOutputRow({
    structuredJson: JSON.stringify({ numPages: 3 }),
  } as FileParseOutputDbRow)

  assert.deepEqual(row.structuredJson, { numPages: 3 })
})

test("normalizeFileParseOutputRow preserves absent or non-object structured output as undefined", () => {
  assert.equal(
    normalizeFileParseOutputRow({
      structuredJson: null,
    } as FileParseOutputDbRow).structuredJson,
    undefined
  )
  assert.equal(
    normalizeFileParseOutputRow({
      structuredJson: JSON.stringify(["not-object"]),
    } as FileParseOutputDbRow).structuredJson,
    undefined
  )
})
