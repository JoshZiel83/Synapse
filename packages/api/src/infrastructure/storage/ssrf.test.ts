import test from "node:test"
import assert from "node:assert/strict"
import { assertPublicHost } from "./ssrf.js"

test("rejects loopback IPv4 literal", async () => {
  await assert.rejects(() => assertPublicHost("127.0.0.1"), /non-public/)
})

test("rejects private IPv4 ranges", async () => {
  for (const ip of ["10.0.0.5", "192.168.1.1", "172.16.5.4"]) {
    await assert.rejects(() => assertPublicHost(ip), /non-public/)
  }
})

test("rejects link-local + cloud metadata address", async () => {
  await assert.rejects(() => assertPublicHost("169.254.169.254"), /non-public/)
})

test("rejects unspecified + carrier-grade NAT", async () => {
  await assert.rejects(() => assertPublicHost("0.0.0.0"), /non-public/)
  await assert.rejects(() => assertPublicHost("100.64.1.1"), /non-public/)
})

test("rejects IPv6 loopback and link-local", async () => {
  await assert.rejects(() => assertPublicHost("::1"), /non-public/)
  await assert.rejects(() => assertPublicHost("fe80::1"), /non-public/)
})

test("rejects IPv4-mapped IPv6 loopback (::ffff:127.0.0.1)", async () => {
  await assert.rejects(() => assertPublicHost("::ffff:127.0.0.1"), /non-public/)
})

test("accepts a public IPv4 literal", async () => {
  await assert.doesNotReject(() => assertPublicHost("1.1.1.1"))
  await assert.doesNotReject(() => assertPublicHost("8.8.8.8"))
})

test("accepts a public IPv6 literal", async () => {
  await assert.doesNotReject(() => assertPublicHost("2606:4700:4700::1111"))
})
