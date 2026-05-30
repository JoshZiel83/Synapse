import test from "node:test"
import assert from "node:assert/strict"
import { buildDaemonCommand } from "./daemon-command.js"

test("daemon command pins the private --registry when a public URL is set", () => {
  const cmd = buildDaemonCommand({
    serverUrl: "https://synapse.example.com",
    apiKey: "key-123",
    npmRegistryUrl: "https://npm.example.com/",
  })
  assert.match(cmd, /^npm exec --yes --registry=https:\/\/npm\.example\.com\//)
  assert.match(cmd, /--package=@synapse\/remote-agent-daemon/)
  assert.match(cmd, /-- synapse-remote-agent-daemon /)
  assert.match(cmd, /--server-url https:\/\/synapse\.example\.com/)
  assert.match(cmd, /--api-key key-123/)
})

test("daemon command never points at public npmjs", () => {
  const cmd = buildDaemonCommand({
    serverUrl: "https://synapse.example.com",
    apiKey: "key-123",
    npmRegistryUrl: "https://npm.example.com/",
  })
  assert.ok(
    !/registry\.npmjs\.org/.test(cmd),
    `command must not reference public npmjs: ${cmd}`
  )
  // The whole point: a registry-aware command is emitted, not a bare npx
  // that would default to npmjs.
  assert.ok(!/\bnpx @synapse/.test(cmd), `must not use bare npx: ${cmd}`)
})

test("daemon command falls back to the installed bin when no registry configured", () => {
  const cmd = buildDaemonCommand({
    serverUrl: "https://synapse.example.com",
    apiKey: "key-123",
    npmRegistryUrl: "",
  })
  assert.equal(
    cmd,
    "synapse-remote-agent-daemon --server-url https://synapse.example.com --api-key key-123"
  )
})

test("blank/whitespace registry is treated as unset", () => {
  const cmd = buildDaemonCommand({
    serverUrl: "https://s",
    apiKey: "k",
    npmRegistryUrl: "   ",
  })
  assert.equal(
    cmd,
    "synapse-remote-agent-daemon --server-url https://s --api-key k"
  )
})
