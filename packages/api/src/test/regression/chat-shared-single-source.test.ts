/**
 * S21: chat module must not redeclare protocol literal unions.
 *
 * The participant-type literal set is owned by shared
 * (CONVERSATION_PARTICIPANT_TYPE / ConversationParticipantType). Any
 * `"actor" | "remote_agent" | "workspace_member" as const` redeclaration
 * in chat module source is a regression — it bypasses the shared single
 * source and lets the chat literal drift away from the actual DB enum.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const chatModuleDir = path.resolve(here, "..", "..", "modules", "chat")

const filesToCheck = ["direct-binding.ts", "participant-activation.ts"] as const

test("chat module sources participant-type literals from @synapse/shared", async () => {
  for (const file of filesToCheck) {
    const full = path.join(chatModuleDir, file)
    const body = await readFile(full, "utf8")
    const matches = body.match(
      /"(workspace_member|actor|remote_agent|external|system)"\s+as\s+const/g
    )
    assert.equal(
      matches,
      null,
      `${file} still redeclares participant-type literals with "x as const": ${(matches ?? []).join(", ")}`
    )
  }
})

test("chat direct-binding imports CONVERSATION_PARTICIPANT_TYPE from shared", async () => {
  const body = await readFile(
    path.join(chatModuleDir, "direct-binding.ts"),
    "utf8"
  )
  assert.match(
    body,
    /import \{[^}]*CONVERSATION_PARTICIPANT_TYPE[^}]*\}\s+from\s+"@synapse\/shared"/,
    "direct-binding.ts must import CONVERSATION_PARTICIPANT_TYPE from @synapse/shared"
  )
})
