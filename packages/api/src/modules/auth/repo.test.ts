import assert from "node:assert/strict"
import test from "node:test"

import { withTestDb } from "../../test/helpers/db.js"
import { selectOAuthVerificationStateByIdentifier } from "./repo.js"

function futureExpiry(): Date {
  return new Date(Date.now() + 10 * 60_000)
}

test("selectOAuthVerificationStateByIdentifier decodes OAuth state at repo exit", async () => {
  await withTestDb(async (db) => {
    await db
      .insertInto("verification")
      .values({
        identifier: "state-valid",
        value: JSON.stringify({
          oauthState: "state-valid",
          expiresAt: Date.now() + 600_000,
          callbackURL: "synapse:///",
        }),
        expiresAt: futureExpiry(),
      })
      .execute()

    const record = await selectOAuthVerificationStateByIdentifier(
      "state-valid",
      db
    )

    assert.equal(record?.state.oauthState, "state-valid")
    assert.equal(record?.state.callbackURL, "synapse:///")
  })
})

test("selectOAuthVerificationStateByIdentifier rejects malformed OAuth state JSON at repo exit", async () => {
  await withTestDb(async (db) => {
    await db
      .insertInto("verification")
      .values({
        identifier: "state-malformed",
        value: "not json",
        expiresAt: futureExpiry(),
      })
      .execute()

    assert.equal(
      await selectOAuthVerificationStateByIdentifier("state-malformed", db),
      null
    )
  })
})

test("selectOAuthVerificationStateByIdentifier rejects non-object OAuth state JSON at repo exit", async () => {
  await withTestDb(async (db) => {
    await db
      .insertInto("verification")
      .values({
        identifier: "state-array",
        value: JSON.stringify(["not-object"]),
        expiresAt: futureExpiry(),
      })
      .execute()

    assert.equal(
      await selectOAuthVerificationStateByIdentifier("state-array", db),
      null
    )
  })
})
