import test from "node:test"
import assert from "node:assert/strict"
import {
  buildCanonicalMessage,
  parseCanonicalMessage,
  serializeCanonicalMessage,
  type CanonicalPart,
} from "./canonical-message.js"
import {
  decodeFromConversationItem,
  encodeForConversationItem,
} from "./canonical-encoding.js"
import {
  degradeForCapabilities,
  type MessageCapabilities,
} from "./degradation.js"

// Roundtrip: voice + video survive serialize → parse cycle.
test("voice part roundtrips with transcript and durationMs", () => {
  const part: CanonicalPart = {
    type: "voice",
    fileRef: { sha256: "f1", mimeType: "audio/silk" },
    durationMs: 4200,
    transcript: "hello world",
  }
  const msg = buildCanonicalMessage([part])
  const round = parseCanonicalMessage(serializeCanonicalMessage(msg))
  assert.equal(round.parts.length, 1)
  assert.deepEqual(round.parts[0], part)
  assert.match(round.plainText, /hello world/)
})

test("video part roundtrips with size + duration", () => {
  const part: CanonicalPart = {
    type: "video",
    fileRef: { sha256: "f2", mimeType: "video/mp4" },
    durationMs: 12000,
    width: 720,
    height: 1280,
  }
  const msg = buildCanonicalMessage([part])
  const round = parseCanonicalMessage(serializeCanonicalMessage(msg))
  assert.deepEqual(round.parts[0], part)
})

// Encoding: voice → file_ref category audio; video → file_ref category video.
test("encodes voice as file_ref category=audio", () => {
  const msg = buildCanonicalMessage([
    {
      type: "voice",
      fileRef: { sha256: "f1", mimeType: "audio/wav" },
      transcript: "hi",
    },
  ])
  const enc = encodeForConversationItem(msg)
  assert.equal(enc.contentBlocks.length, 1)
  const block = enc.contentBlocks[0]
  assert.equal(block.type, "file_ref")
  if (block.type === "file_ref") {
    assert.equal(block.category, "audio")
    assert.equal(block.sha256, "f1")
  }
})

test("encodes video as file_ref category=video", () => {
  const msg = buildCanonicalMessage([
    {
      type: "video",
      fileRef: { sha256: "f2", mimeType: "video/mp4" },
    },
  ])
  const enc = encodeForConversationItem(msg)
  const block = enc.contentBlocks[0]
  assert.equal(block.type, "file_ref")
  if (block.type === "file_ref") assert.equal(block.category, "video")
})

// Decode: file_ref category=audio → voice, category=video → video
test("decodes file_ref audio block to voice part", () => {
  const decoded = decodeFromConversationItem({
    content: "[语音]",
    contentBlocks: [
      {
        type: "file_ref",
        sha256: "f1",
        mimeType: "audio/wav",
        name: "v.wav",
        sizeBytes: 100,
        category: "audio",
      },
    ],
  })
  assert.equal(decoded.parts.length, 1)
  assert.equal(decoded.parts[0].type, "voice")
})

test("decodes file_ref video block to video part", () => {
  const decoded = decodeFromConversationItem({
    content: "[视频]",
    contentBlocks: [
      {
        type: "file_ref",
        sha256: "f2",
        mimeType: "video/mp4",
        name: "v.mp4",
        sizeBytes: 1000,
        category: "video",
      },
    ],
  })
  assert.equal(decoded.parts.length, 1)
  assert.equal(decoded.parts[0].type, "video")
})

// interaction_prompt: roundtrips lossless via metadata path
test("interaction_prompt roundtrips through serialize+parse", () => {
  const part: CanonicalPart = {
    type: "interaction_prompt",
    taskId: "ir-1",
    title: "Approve command?",
    fallbackText: "Please approve in dashboard",
    options: [
      {
        id: "allow-once",
        label: "✅ 允许一次",
        actionToken: "tok-a",
        style: "primary",
      },
      { id: "deny", label: "❌ 拒绝", actionToken: "tok-d", style: "danger" },
    ],
  }
  const msg = buildCanonicalMessage([part])
  const round = parseCanonicalMessage(serializeCanonicalMessage(msg))
  assert.deepEqual(round.parts[0], part)
  assert.match(round.plainText, /Please approve/)
})

test("interaction_prompt missing taskId degrades to system_marker", () => {
  const round = parseCanonicalMessage({
    schemaVersion: 1,
    parts: [
      {
        type: "interaction_prompt",
        fallbackText: "x",
        options: [],
      },
    ],
  })
  assert.equal(round.parts.length, 1)
  assert.equal(round.parts[0].type, "system_marker")
})

test("interaction_prompt fallbackText default + length cap", () => {
  const long = "a".repeat(6000)
  const round = parseCanonicalMessage({
    schemaVersion: 1,
    parts: [
      {
        type: "interaction_prompt",
        taskId: "ir-1",
        fallbackText: long,
        options: [],
      },
    ],
  })
  const part = round.parts[0]
  assert.equal(part.type, "interaction_prompt")
  if (part.type === "interaction_prompt") {
    assert.equal(part.fallbackText.length, 5000)
  }
})

test("interaction_prompt missing fallbackText gets sensible default", () => {
  const round = parseCanonicalMessage({
    schemaVersion: 1,
    parts: [
      {
        type: "interaction_prompt",
        taskId: "ir-1",
        options: [],
      },
    ],
  })
  const part = round.parts[0]
  assert.equal(part.type, "interaction_prompt")
  if (part.type === "interaction_prompt") {
    assert.ok(part.fallbackText.length > 0)
  }
})

test("interaction_prompt options sanitize: drop invalid entries", () => {
  const round = parseCanonicalMessage({
    schemaVersion: 1,
    parts: [
      {
        type: "interaction_prompt",
        taskId: "ir-1",
        fallbackText: "x",
        options: [
          { id: "a", label: "A", actionToken: "t1" }, // ok
          { id: "b", actionToken: "t2" }, // missing label → drop
          { label: "C", actionToken: "t3" }, // missing id → drop
          { id: "d", label: "D" }, // missing token → drop
          "not-an-object", // drop
          null, // drop
        ],
      },
    ],
  })
  const part = round.parts[0]
  assert.equal(part.type, "interaction_prompt")
  if (part.type === "interaction_prompt") {
    assert.equal(part.options.length, 1)
    assert.equal(part.options[0].id, "a")
  }
})

// Encoding: interaction_prompt is rich/control → not in contentBlocks but in canonicalParts
test("interaction_prompt is preserved only in transportMetadata.canonicalParts", () => {
  const msg = buildCanonicalMessage([
    {
      type: "interaction_prompt",
      taskId: "ir-1",
      fallbackText: "approve",
      options: [],
    },
  ])
  const enc = encodeForConversationItem(msg)
  // Plain-text content survives (for legacy readers)
  assert.match(enc.content, /approve/)
  // No file_ref / mention block produced
  assert.equal(enc.contentBlocks.filter((b) => b.type !== "text").length, 0)
  // But canonicalParts has the full part
  assert.equal(enc.transportMetadata.canonicalParts.length, 1)
  assert.equal(
    enc.transportMetadata.canonicalParts[0].type,
    "interaction_prompt"
  )
})

// Degradation: capability flags drive the rewrite
function caps(overrides: Partial<MessageCapabilities>): MessageCapabilities {
  return {
    canEdit: false,
    canReact: false,
    canTyping: false,
    canSendCard: false,
    canStream: false,
    supportsGroup: false,
    supportsMention: false,
    supportsReply: false,
    supportsImage: false,
    supportsFile: false,
    supportsVoice: false,
    supportsVideo: false,
    supportsInteractionPrompt: false,
    maxTextBytes: 5000,
    directMentionPolicy: "attached_only",
    ...overrides,
  }
}

test("degrade: voice without supportsVoice → system_marker w/ transcript", () => {
  const msg = buildCanonicalMessage([
    {
      type: "voice",
      fileRef: { sha256: "f1" },
      transcript: "hi",
    },
  ])
  const out = degradeForCapabilities(msg, caps({}))
  assert.equal(out.parts[0].type, "system_marker")
  if (out.parts[0].type === "system_marker") {
    assert.equal(out.parts[0].marker, "voice_placeholder")
    assert.match(out.parts[0].label ?? "", /hi/)
  }
})

test("degrade: video without supportsVideo → system_marker", () => {
  const msg = buildCanonicalMessage([
    {
      type: "video",
      fileRef: { sha256: "f2" },
    },
  ])
  const out = degradeForCapabilities(msg, caps({}))
  assert.equal(out.parts[0].type, "system_marker")
})

test("degrade: interaction_prompt without supportsInteractionPrompt → text fallback", () => {
  const msg = buildCanonicalMessage([
    {
      type: "interaction_prompt",
      taskId: "ir-1",
      title: "Approve?",
      fallbackText: "Please go to dashboard",
      options: [],
    },
  ])
  const out = degradeForCapabilities(msg, caps({}))
  assert.equal(out.parts[0].type, "text")
  if (out.parts[0].type === "text") {
    assert.match(out.parts[0].text, /Approve\?/)
    assert.match(out.parts[0].text, /Please go to dashboard/)
  }
})

test("degrade: interaction_prompt with supportsInteractionPrompt → kept", () => {
  const msg = buildCanonicalMessage([
    {
      type: "interaction_prompt",
      taskId: "ir-1",
      fallbackText: "approve",
      options: [],
    },
  ])
  const out = degradeForCapabilities(
    msg,
    caps({ supportsInteractionPrompt: true })
  )
  assert.equal(out.parts[0].type, "interaction_prompt")
})
