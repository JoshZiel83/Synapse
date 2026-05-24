/**
 * S28: the mobile chat service worker must not redeclare
 * mergeQueueStateForSave — shared owns the canonical
 * "worker reconciles its flush back into the queue" semantics
 * (packages/shared/src/chat-queue/index.ts). Pre-S28 the mobile worker
 * had its own 60-line copy that drifted from web; if shared's merge
 * fixes a concurrency bug, the mobile copy didn't get it.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const mobileWorkerPath = path.resolve(
  here,
  "..",
  "..",
  "..",
  "..",
  "mobile-app",
  "src",
  "workers",
  "chat-service-worker.ts"
)

test("mobile chat-service-worker imports mergeQueueStateForSave from shared", async () => {
  const body = await readFile(mobileWorkerPath, "utf8")
  assert.match(
    body,
    /import \{[^}]*mergeQueueStateForSave[^}]*\}\s+from\s+"@shared"/s,
    "mobile chat-service-worker must import mergeQueueStateForSave from @shared"
  )
})

test("mobile chat-service-worker does not redeclare mergeQueueStateForSave locally", async () => {
  const body = await readFile(mobileWorkerPath, "utf8")
  assert.equal(
    /function mergeQueueStateForSave\b/.test(body),
    false,
    "mobile chat-service-worker.ts must not declare a local mergeQueueStateForSave — use the shared one"
  )
})
