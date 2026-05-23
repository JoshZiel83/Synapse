/**
 * S31: web + mobile SW broadcast / IDB / sync-tag constants must come
 * from @synapse/shared. Until this stage each client redeclared its
 * own value (web "synapse.web.chat.worker" / "synapse-web-chat-queue",
 * mobile "synapse.chat.worker" / "synapse-chat-web-queue"), so the two
 * clients literally lived in different IDB databases and broadcast on
 * different channels even though they were doing the same job. Now both
 * are aliased back to the canonical shared values.
 *
 * Note we don't pin the literal value here — that's deliberate. Pinning
 * "synapse-chat-queue" everywhere would make a future rename a two-test
 * change for no real coverage. The actual invariant is "all four
 * constants resolve to the same string."
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { execFileSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  CHAT_QUEUE_BROADCAST_CHANNEL,
  CHAT_QUEUE_DB_NAME,
  CHAT_SERVICE_WORKER_SYNC_TAG,
  CHAT_SERVICE_WORKER_PERIODIC_SYNC_TAG,
} from "@synapse/shared"

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, "..", "..", "..", "..")

const webSwConstantsPath = path.join(
  repoRoot,
  "packages",
  "web-next",
  "lib",
  "chat-service-worker-constants.ts"
)
const webPersistencePath = path.join(
  repoRoot,
  "packages",
  "web-next",
  "lib",
  "chat-persistence.ts"
)
const mobileStorageKeysPath = path.join(
  repoRoot,
  "packages",
  "mobile-app",
  "src",
  "lib",
  "storage-keys.ts"
)
const mobileQueueStoragePath = path.join(
  repoRoot,
  "packages",
  "mobile-app",
  "src",
  "lib",
  "chat-web-queue-storage.ts"
)

test("shared chat-queue constants are well-formed", () => {
  // Sanity guards so the rest of the test doesn't pass on accident.
  assert.ok(
    typeof CHAT_QUEUE_BROADCAST_CHANNEL === "string" &&
      CHAT_QUEUE_BROADCAST_CHANNEL.length > 0
  )
  assert.ok(
    typeof CHAT_QUEUE_DB_NAME === "string" && CHAT_QUEUE_DB_NAME.length > 0
  )
  assert.ok(
    typeof CHAT_SERVICE_WORKER_SYNC_TAG === "string" &&
      CHAT_SERVICE_WORKER_SYNC_TAG.length > 0
  )
  assert.ok(
    typeof CHAT_SERVICE_WORKER_PERIODIC_SYNC_TAG === "string" &&
      CHAT_SERVICE_WORKER_PERIODIC_SYNC_TAG.length > 0
  )
})

test("web SW constants module re-exports / aliases from @synapse/shared", async () => {
  const body = await readFile(webSwConstantsPath, "utf8")
  assert.match(
    body,
    /from\s+"@synapse\/shared"/,
    "web chat-service-worker-constants.ts must source values from @synapse/shared"
  )
  assert.equal(
    /=\s*"synapse\.web\.chat\.worker"/.test(body),
    false,
    "web must no longer hardcode 'synapse.web.chat.worker' — alias to CHAT_QUEUE_BROADCAST_CHANNEL"
  )
  assert.equal(
    /=\s*"synapse-web-chat-sync"/.test(body),
    false,
    "web must no longer hardcode 'synapse-web-chat-sync' — alias to CHAT_SERVICE_WORKER_SYNC_TAG"
  )
})

test("web chat-persistence sources CHAT_QUEUE_DB_NAME from @synapse/shared", async () => {
  const body = await readFile(webPersistencePath, "utf8")
  assert.match(
    body,
    /import \{[^}]*CHAT_QUEUE_DB_NAME[^}]*\}\s+from\s+"@synapse\/shared"/s,
    "chat-persistence.ts must import CHAT_QUEUE_DB_NAME from @synapse/shared"
  )
  assert.equal(
    /=\s*"synapse-web-chat-queue"/.test(body),
    false,
    "chat-persistence.ts must not redeclare the IDB name; it has to alias the shared constant"
  )
})

test("mobile storage-keys aliases the SW constants to the shared values", async () => {
  const body = await readFile(mobileStorageKeysPath, "utf8")
  assert.match(
    body,
    /import \{[^}]*CHAT_QUEUE_BROADCAST_CHANNEL[^}]*\}\s+from\s+"@shared"/s,
    "mobile storage-keys.ts must import CHAT_QUEUE_BROADCAST_CHANNEL from @shared"
  )
  assert.equal(
    /=\s*"synapse\.chat\.worker"/.test(body),
    false,
    "mobile must no longer hardcode 'synapse.chat.worker' — alias the shared channel"
  )
})

test("mobile chat-web-queue-storage aliases CHAT_QUEUE_DB_NAME from @shared", async () => {
  const body = await readFile(mobileQueueStoragePath, "utf8")
  assert.match(
    body,
    /import \{[^}]*CHAT_QUEUE_DB_NAME[^}]*\}\s+from\s+"@shared"/s
  )
  assert.equal(
    /=\s*"synapse-chat-web-queue"/.test(body),
    false,
    "mobile chat-web-queue-storage.ts must not redeclare the IDB name"
  )
})

test("bundled service workers carry the shared chat-queue strings", async () => {
  // Both clients have a pre-built SW bundle that the browser loads
  // (web: public/web-chat-service-worker.js, mobile: public/chat-service-worker.js).
  // The S31 source-level guards above don't catch a stale bundle —
  // grep the artifact directly for the canonical CHAT_QUEUE_BROADCAST_CHANNEL
  // string so a forgotten `npm run build:chat-worker` is caught in CI.
  const webBundle = await readFile(
    path.join(
      repoRoot,
      "packages",
      "web-next",
      "public",
      "web-chat-service-worker.js"
    ),
    "utf8"
  )
  const mobileBundle = await readFile(
    path.join(
      repoRoot,
      "packages",
      "mobile-app",
      "public",
      "chat-service-worker.js"
    ),
    "utf8"
  )
  assert.ok(
    webBundle.includes(CHAT_QUEUE_BROADCAST_CHANNEL),
    `web SW bundle must contain "${CHAT_QUEUE_BROADCAST_CHANNEL}" — run \`npm run build:chat-worker -w packages/web-next\` and commit`
  )
  assert.ok(
    mobileBundle.includes(CHAT_QUEUE_BROADCAST_CHANNEL),
    `mobile SW bundle must contain "${CHAT_QUEUE_BROADCAST_CHANNEL}" — run \`npm run build:chat-worker\` in packages/mobile-app and commit`
  )
  // Sanity: the old per-client strings must not survive in either bundle.
  assert.equal(
    webBundle.includes("synapse.web.chat.worker"),
    false,
    "web SW bundle still contains stale 'synapse.web.chat.worker' string"
  )
  assert.equal(
    mobileBundle.includes("synapse.chat.worker"),
    false,
    "mobile SW bundle still contains stale 'synapse.chat.worker' string"
  )
})

test("zod does NOT leak into either SW bundle", async () => {
  // S34 moved CanonicalContentBlockSchema into @synapse/shared but
  // initially exported it from the root barrel — at which point every
  // module that imports from `@synapse/shared` / `@shared` (including
  // the chat service workers via the queue constants) transitively
  // dragged zod into the worker bundles, ballooning them by hundreds
  // of kB. S36 moved the schemas to the `/schemas` subpath so this
  // doesn't happen. Guard the invariant so a future "let me just add
  // X to the root barrel" doesn't quietly bloat the workers again.
  const webBundle = await readFile(
    path.join(
      repoRoot,
      "packages",
      "web-next",
      "public",
      "web-chat-service-worker.js"
    ),
    "utf8"
  )
  const mobileBundle = await readFile(
    path.join(
      repoRoot,
      "packages",
      "mobile-app",
      "public",
      "chat-service-worker.js"
    ),
    "utf8"
  )
  for (const [name, bundle] of [
    ["web", webBundle] as const,
    ["mobile", mobileBundle] as const,
  ]) {
    // zod's runtime exposes its namespace as `z.ZodObject`, `z.ZodEnum`,
    // etc.; bundlers rename `z` but the class names survive. Grep for
    // a representative name that doesn't collide with anything else
    // shipped in the SW.
    assert.equal(
      /\bZodDiscriminatedUnion\b|\bZodEffects\b/.test(bundle),
      false,
      `${name} SW bundle contains zod runtime — something in @synapse/shared / @shared root barrel is dragging zod in. Use the @synapse/shared/schemas subpath instead.`
    )
  }
})

test("regenerating the SW bundles produces no diff vs the committed artifacts", async () => {
  // If someone changes a shared module the SW transitively imports but
  // forgets to re-run `npm run build:chat-worker`, the committed bundle
  // silently drifts from the source. This test forces a regeneration
  // and compares byte-for-byte against the on-disk artifact. Catches
  // the exact S31 / S36 mistake at PR time.
  const webBundlePath = path.join(
    repoRoot,
    "packages",
    "web-next",
    "public",
    "web-chat-service-worker.js"
  )
  const mobileBundlePath = path.join(
    repoRoot,
    "packages",
    "mobile-app",
    "public",
    "chat-service-worker.js"
  )

  const webBefore = await readFile(webBundlePath, "utf8")
  const mobileBefore = await readFile(mobileBundlePath, "utf8")

  execFileSync("npm", ["run", "build:chat-worker", "-w", "packages/web-next"], {
    cwd: repoRoot,
    stdio: "ignore",
  })
  execFileSync("npm", ["run", "build:chat-worker"], {
    cwd: path.join(repoRoot, "packages", "mobile-app"),
    stdio: "ignore",
  })

  const webAfter = await readFile(webBundlePath, "utf8")
  const mobileAfter = await readFile(mobileBundlePath, "utf8")

  assert.equal(
    webAfter,
    webBefore,
    "web SW bundle drifted from source — run `npm run build:chat-worker -w packages/web-next` and commit"
  )
  assert.equal(
    mobileAfter,
    mobileBefore,
    "mobile SW bundle drifted from source — run `npm run build:chat-worker` in packages/mobile-app and commit"
  )
})
