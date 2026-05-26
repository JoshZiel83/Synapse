import test from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ChildProcess } from "node:child_process"

import { createLocalFsBackend } from "../vfs.js"
import { dispatchRipgrep } from "./ripgrep-runner.js"

function fakeSpawn(lines: string[]) {
  return ((..._args: unknown[]) => {
    const stdout = new EventEmitter() as EventEmitter & {
      setEncoding?: () => void
    }
    const stderr = new EventEmitter()
    const proc = new EventEmitter() as EventEmitter & {
      stdout: typeof stdout
      stderr: typeof stderr
      kill: (sig?: string) => void
    }
    ;(proc as unknown as { stdout: typeof stdout }).stdout = stdout
    ;(proc as unknown as { stderr: typeof stderr }).stderr = stderr
    ;(proc as unknown as { kill: () => void }).kill = () => {}
    setImmediate(() => {
      stdout.emit("data", lines.join("\n") + "\n")
      proc.emit("close", 0)
    })
    return proc as unknown as ChildProcess
  }) as unknown as typeof import("node:child_process").spawn
}

test("dispatchRipgrep mode=content dedupes (path,line,offset,match) and slices offset+limit", async () => {
  const root = mkdtempSync(join(tmpdir(), "synapse-rg-"))
  try {
    writeFileSync(join(root, "a.txt"), "hello")
    const be = createLocalFsBackend({ rootPath: root })
    await be.start()
    // 3 matches in one file, with a duplicate frame to test dedupe.
    const hostA = `${root}/a.txt`
    const m1 = JSON.stringify({
      type: "match",
      data: {
        path: { text: hostA },
        line_number: 1,
        absolute_offset: 0,
        lines: { text: "hello" },
      },
    })
    const m1dup = m1
    const m2 = JSON.stringify({
      type: "match",
      data: {
        path: { text: hostA },
        line_number: 2,
        absolute_offset: 6,
        lines: { text: "world" },
      },
    })
    const m3 = JSON.stringify({
      type: "match",
      data: {
        path: { text: hostA },
        line_number: 3,
        absolute_offset: 12,
        lines: { text: "foo" },
      },
    })
    const out = await dispatchRipgrep({
      mode: "content",
      query: "hello",
      regex: false,
      limit: 2,
      offset: 1,
      allowedPrefixes: ["/"],
      hostRootPath: be.hostRootPath,
      backend: be,
      cfg: { maxOffset: 10000 },
      deps: {
        spawnImpl: fakeSpawn([m1, m1dup, m2, m3]),
        ripgrepPath: "/fake/rg",
      },
    })
    // dedupe → [m1, m2, m3]; slice(1, 3) → [m2, m3]
    assert.equal(out.hits.length, 2)
    assert.equal(out.hits[0]!.line_no, 2)
    assert.equal(out.hits[1]!.line_no, 3)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("dispatchRipgrep drops hits under /.synapse-internal", async () => {
  const root = mkdtempSync(join(tmpdir(), "synapse-rg-"))
  try {
    const be = createLocalFsBackend({ rootPath: root })
    await be.start()
    const internalHit = JSON.stringify({
      type: "match",
      data: {
        path: { text: `${root}/.synapse-internal/tmp/leaked.txt` },
        line_number: 1,
        absolute_offset: 0,
        lines: { text: "secret" },
      },
    })
    const visibleHit = JSON.stringify({
      type: "match",
      data: {
        path: { text: `${root}/visible.txt` },
        line_number: 1,
        absolute_offset: 0,
        lines: { text: "secret" },
      },
    })
    const out = await dispatchRipgrep({
      mode: "content",
      query: "secret",
      regex: false,
      limit: 50,
      offset: 0,
      allowedPrefixes: ["/"],
      hostRootPath: be.hostRootPath,
      backend: be,
      cfg: { maxOffset: 10000 },
      deps: {
        spawnImpl: fakeSpawn([internalHit, visibleHit]),
        ripgrepPath: "/fake/rg",
      },
    })
    assert.equal(out.hits.length, 1)
    assert.equal(out.hits[0]!.path, "/visible.txt")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("dispatchRipgrep mode=content respects boundary-aware allowed_path_prefixes (/foo vs /foobar)", async () => {
  const root = mkdtempSync(join(tmpdir(), "synapse-rg-"))
  try {
    const { mkdirSync } = await import("node:fs")
    mkdirSync(join(root, "foo"))
    mkdirSync(join(root, "foobar"))
    const be = createLocalFsBackend({ rootPath: root })
    await be.start()
    const fooHit = JSON.stringify({
      type: "match",
      data: {
        path: { text: `${root}/foo/x` },
        line_number: 1,
        absolute_offset: 0,
        lines: { text: "m" },
      },
    })
    const foobarHit = JSON.stringify({
      type: "match",
      data: {
        path: { text: `${root}/foobar/x` },
        line_number: 1,
        absolute_offset: 0,
        lines: { text: "m" },
      },
    })
    const out = await dispatchRipgrep({
      mode: "content",
      query: "m",
      regex: false,
      limit: 50,
      offset: 0,
      allowedPrefixes: ["/foo"],
      hostRootPath: be.hostRootPath,
      backend: be,
      cfg: { maxOffset: 10000 },
      deps: {
        spawnImpl: fakeSpawn([fooHit, foobarHit]),
        ripgrepPath: "/fake/rg",
      },
    })
    const paths = out.hits.map((h) => h.path).sort()
    assert.deepEqual(paths, ["/foo/x"])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("dispatchRipgrep mode=path applies query + glob filters", async () => {
  const root = mkdtempSync(join(tmpdir(), "synapse-rg-"))
  try {
    const be = createLocalFsBackend({ rootPath: root })
    await be.start()
    const files = [
      `${root}/notes/intro.md`,
      `${root}/notes/intro.txt`,
      `${root}/src/main.ts`,
      `${root}/other/intro.md`,
    ]
    const out = await dispatchRipgrep({
      mode: "path",
      query: "intro",
      regex: false,
      glob: "notes/**",
      limit: 50,
      offset: 0,
      allowedPrefixes: ["/"],
      hostRootPath: be.hostRootPath,
      backend: be,
      cfg: { maxOffset: 10000 },
      deps: { spawnImpl: fakeSpawn(files), ripgrepPath: "/fake/rg" },
    })
    const paths = out.hits.map((h) => h.path).sort()
    assert.deepEqual(paths, ["/notes/intro.md", "/notes/intro.txt"])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
