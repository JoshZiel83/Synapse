import { test } from "node:test"
import assert from "node:assert/strict"

import {
  ALWAYS_INJECT_ENV,
  buildUtf8Env,
  createUtf8StreamCollector,
  InvalidAllowedEnvError,
  lookupEnv,
  sanitizePathEnv,
} from "./utf8.js"

test("buildUtf8Env: keeps SAFE_BASE keys and strips dangerous by default", () => {
  const env = buildUtf8Env(
    {
      PATH: "/usr/bin:/bin",
      HOME: "/home/u",
      LD_PRELOAD: "/evil/lib.so",
      NODE_OPTIONS: "--inspect",
      LANG: "en_US.UTF-8",
    },
    { allowedEnv: [], platform: "linux" }
  )
  assert.equal(env.PATH, "/usr/bin:/bin")
  assert.equal(env.HOME, "/home/u")
  assert.equal(env.LD_PRELOAD, undefined)
  assert.equal(env.NODE_OPTIONS, undefined)
  assert.equal(env.LANG, "en_US.UTF-8")
  // ALWAYS_INJECT_ENV applied
  for (const [k, v] of Object.entries(ALWAYS_INJECT_ENV)) {
    assert.equal(env[k], v)
  }
})

test("buildUtf8Env: allowedEnv whitelists dangerous variable", () => {
  const env = buildUtf8Env(
    { PATH: "/usr/bin", NODE_OPTIONS: "--inspect" },
    { allowedEnv: ["NODE_OPTIONS"], platform: "linux" }
  )
  assert.equal(env.NODE_OPTIONS, "--inspect")
})

test("buildUtf8Env: PATH/Path in allowedEnv throws InvalidAllowedEnvError", () => {
  assert.throws(
    () =>
      buildUtf8Env(
        { PATH: "/usr/bin" },
        { allowedEnv: ["PATH"], platform: "linux" }
      ),
    (err) =>
      err instanceof InvalidAllowedEnvError &&
      /PATH\/Path is reserved/.test(err.message)
  )
  assert.throws(
    () =>
      buildUtf8Env(
        { PATH: "/usr/bin" },
        { allowedEnv: ["Path"], platform: "win32" }
      ),
    (err) => err instanceof InvalidAllowedEnvError
  )
})

test("buildUtf8Env: mixed-case Path variants ALL rejected (case-insensitive)", () => {
  // Windows env lookup is case-insensitive, so we must reject every spelling.
  for (const key of ["PaTh", "pAth", "PATh", "path", "PATH", "PATh"]) {
    assert.throws(
      () =>
        buildUtf8Env(
          { Path: "C:\\Windows" },
          { allowedEnv: [key], platform: "win32" }
        ),
      (err) => err instanceof InvalidAllowedEnvError,
      `case variant ${key} should be rejected`
    )
  }
})

test("buildUtf8Env: LC_ALL=C is dropped on Linux to let LANG/LC_CTYPE win", () => {
  const env = buildUtf8Env(
    { PATH: "/usr/bin", LC_ALL: "C", LANG: "C", LC_CTYPE: "C" },
    { allowedEnv: [], platform: "linux" }
  )
  assert.equal(env.LC_ALL, undefined)
  assert.equal(env.LANG, "C.UTF-8")
  assert.equal(env.LC_CTYPE, "C.UTF-8")
})

test("buildUtf8Env: zh_CN.UTF-8 is preserved", () => {
  const env = buildUtf8Env(
    { PATH: "/usr/bin", LANG: "zh_CN.UTF-8", LC_CTYPE: "zh_CN.UTF-8" },
    { allowedEnv: [], platform: "linux" }
  )
  assert.equal(env.LANG, "zh_CN.UTF-8")
  assert.equal(env.LC_CTYPE, "zh_CN.UTF-8")
})

test("buildUtf8Env: Darwin uses en_US.UTF-8 fallback (not C.UTF-8)", () => {
  const env = buildUtf8Env(
    { PATH: "/usr/bin", LANG: "C" },
    { allowedEnv: [], platform: "darwin" }
  )
  assert.equal(env.LANG, "en_US.UTF-8")
})

test("buildUtf8Env: Windows preserves PATH (case-insensitive lookup of Path)", () => {
  const env = buildUtf8Env(
    { Path: "C:\\Windows\\System32" },
    { allowedEnv: [], platform: "win32" }
  )
  assert.equal(env.PATH, "C:\\Windows\\System32")
})

test("buildUtf8Env: Windows does not run UTF-8 locale overrides", () => {
  const env = buildUtf8Env(
    { Path: "C:\\Windows\\System32" },
    { allowedEnv: [], platform: "win32" }
  )
  assert.equal(env.LANG, undefined)
  assert.equal(env.LC_CTYPE, undefined)
})

test("buildUtf8Env: final PATH sanitization strips empty and relative entries", () => {
  const env = buildUtf8Env(
    { PATH: ":/usr/bin:.:relative/bin:/bin" },
    { allowedEnv: [], platform: "linux" }
  )
  assert.equal(env.PATH, "/usr/bin:/bin")
})

test("sanitizePathEnv: POSIX skips empty and relative", () => {
  assert.equal(
    sanitizePathEnv(":/usr/bin:.:relative/bin:/bin", "linux"),
    "/usr/bin:/bin"
  )
  assert.equal(sanitizePathEnv(".:/usr/bin", "linux"), "/usr/bin")
})

test("sanitizePathEnv: Windows uses path.win32 semantics", () => {
  assert.equal(
    sanitizePathEnv(";C:\\bin;.\\local;C:\\Windows", "win32"),
    "C:\\bin;C:\\Windows"
  )
  assert.equal(sanitizePathEnv("relative\\bin;C:\\bin", "win32"), "C:\\bin")
})

test("sanitizePathEnv: empty input returns empty string", () => {
  assert.equal(sanitizePathEnv("", "linux"), "")
})

test("lookupEnv: Windows case-insensitive lookup", () => {
  assert.equal(lookupEnv({ Path: "C:\\bin" }, "PATH", "win32"), "C:\\bin")
  assert.equal(lookupEnv({ path: "C:\\bin" }, "PATH", "win32"), "C:\\bin")
})

test("lookupEnv: POSIX exact match", () => {
  assert.equal(lookupEnv({ PATH: "/usr/bin" }, "PATH", "linux"), "/usr/bin")
  assert.equal(lookupEnv({ Path: "/usr/bin" }, "PATH", "linux"), undefined)
})

test("createUtf8StreamCollector: multi-byte across chunk boundary", () => {
  // "你好" is U+4F60 + U+597D, three bytes each in UTF-8.
  const utf8 = Buffer.from("你好世界", "utf-8")
  const collector = createUtf8StreamCollector()
  // Split deliberately mid-codepoint.
  collector.feed(utf8.subarray(0, 2))
  collector.feed(utf8.subarray(2, 7))
  collector.feed(utf8.subarray(7))
  const result = collector.finish()
  assert.equal(result, "你好世界")
  assert.ok(!result.includes("�"))
})

test("createUtf8StreamCollector: empty input", () => {
  const collector = createUtf8StreamCollector()
  assert.equal(collector.finish(), "")
})

test("createUtf8StreamCollector: truncation mid-codepoint does NOT emit replacement char (user repro)", () => {
  // The user pinned this exact case: maxBytes=1 + 你 (3-byte UTF-8) had
  // been producing "�" — a replacement character at the truncation
  // boundary. Truncation is OUR doing (the per-stream cap), so the
  // honest result is to silently drop the dangling codepoint rather
  // than render corruption. The non-truncated path still calls
  // decoder.end() so a genuinely corrupted stream still surfaces �.
  const collector = createUtf8StreamCollector({ maxBytes: 1 })
  collector.feed(Buffer.from("你", "utf-8"))
  const out = collector.finish()
  assert.equal(out, "", "kept-stdout must be empty, not '\u{FFFD}'")
  assert.ok(!out.includes("\u{FFFD}"), `must not contain U+FFFD; got ${out}`)
  assert.equal(collector.truncated(), true)
  assert.equal(
    collector.bytesDropped(),
    2,
    "2 of the 3 bytes were dropped after the cap"
  )
})

test("createUtf8StreamCollector: truncation just past codepoint boundary keeps clean codepoints", () => {
  // 你好 = 6 bytes (3+3). maxBytes=3 keeps exactly the first codepoint.
  const collector = createUtf8StreamCollector({ maxBytes: 3 })
  collector.feed(Buffer.from("你好", "utf-8"))
  assert.equal(collector.finish(), "你")
  assert.equal(collector.truncated(), true)
  assert.equal(collector.bytesDropped(), 3)
})

test("createUtf8StreamCollector: truncation 1 byte short of codepoint drops the incomplete one", () => {
  // 你好 = 6 bytes. maxBytes=4 keeps 你 (3 bytes) + 1 partial byte of 好.
  // The partial byte must NOT flush as U+FFFD.
  const collector = createUtf8StreamCollector({ maxBytes: 4 })
  collector.feed(Buffer.from("你好", "utf-8"))
  const out = collector.finish()
  assert.equal(out, "你", `expected '你', got '${out}'`)
  assert.ok(!out.includes("\u{FFFD}"))
  assert.equal(collector.truncated(), true)
})

test("createUtf8StreamCollector: NON-truncated stream ending mid-codepoint still flushes U+FFFD (genuine corruption)", () => {
  // Distinguished from the truncation case: if a stream really ends
  // mid-codepoint (process killed mid-byte, network truncation), the
  // replacement character is honest signal. Only suppressed when WE
  // caused the cut via the cap.
  const collector = createUtf8StreamCollector() // unbounded
  // Feed only the first 2 bytes of 你 (a 3-byte codepoint).
  collector.feed(Buffer.from("你", "utf-8").subarray(0, 2))
  const out = collector.finish()
  assert.equal(collector.truncated(), false, "we didn't cap; not 'truncated'")
  assert.ok(
    out.includes("\u{FFFD}"),
    `genuinely corrupt stream should surface U+FFFD; got '${out}'`
  )
})
