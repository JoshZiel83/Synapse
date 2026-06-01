import { lookup } from "node:dns/promises"
import { lookup as lookupCb } from "node:dns"
import ipaddr from "ipaddr.js"
import { Agent, type Dispatcher } from "undici"

/**
 * SSRF protection for server-initiated downloads (inbound media ingest, etc.).
 *
 * The danger: a URL supplied by a remote party (an IM platform, a webhook, a
 * user) is fetched by our server, so it can be aimed at internal addresses
 * (169.254.169.254 cloud metadata, 127.0.0.1 admin ports, 10.x/192.168.x
 * services). We defend by resolving the hostname and refusing any address that
 * is not a normal public unicast address.
 *
 * This check ALWAYS runs (independent of any host allowlist) so that an empty
 * allowlist no longer means "no protection".
 */

/**
 * ipaddr.js range categories that are NOT safe to fetch from a server.
 * "unicast" is the only allowed category for global addresses; everything
 * below is link-local, loopback, private, reserved, multicast, etc.
 */
const BLOCKED_RANGES = new Set([
  "unspecified", // 0.0.0.0 / ::
  "broadcast", // 255.255.255.255
  "multicast",
  "linkLocal", // 169.254.0.0/16, fe80::/10 (incl. cloud metadata 169.254.169.254)
  "loopback", // 127.0.0.0/8, ::1
  "private", // 10/8, 172.16/12, 192.168/16
  "reserved",
  "carrierGradeNat", // 100.64.0.0/10
  "uniqueLocal", // fc00::/7
  "ipv4Mapped",
  "rfc6145",
  "rfc6052",
  "6to4",
  "teredo",
])

function isBlockedAddress(addr: ipaddr.IPv4 | ipaddr.IPv6): boolean {
  const range = addr.range()
  if (BLOCKED_RANGES.has(range)) return true
  // An IPv4-mapped IPv6 (::ffff:127.0.0.1) must be judged on its v4 form.
  if (addr.kind() === "ipv6") {
    const v6 = addr as ipaddr.IPv6
    if (v6.isIPv4MappedAddress()) {
      return isBlockedAddress(v6.toIPv4Address())
    }
  }
  return false
}

/** True if a literal IP string is a safe, public address. */
function isPublicAddress(address: string): boolean {
  if (!ipaddr.isValid(address)) return false
  return !isBlockedAddress(ipaddr.parse(address))
}

/**
 * Throws if `hostname` is — or resolves to — a non-public address. Accepts a
 * bare hostname or an IP literal. Performs a DNS lookup (all records) for
 * names; checks the literal directly for IPs.
 *
 * NOTE: this is a pre-flight check. On its own it has a TOCTOU/DNS-rebinding
 * gap (the name could resolve differently when fetch later connects). Pair it
 * with `ssrfSafeDispatcher` (below), which re-validates the address the socket
 * actually connects to, to close that window.
 */
export async function assertPublicHost(hostname: string): Promise<void> {
  const host = hostname.toLowerCase()

  if (ipaddr.isValid(host)) {
    if (!isPublicAddress(host)) {
      throw new Error(`blocked non-public address: ${host}`)
    }
    return
  }

  let resolved: Array<{ address: string }>
  try {
    resolved = await lookup(host, { all: true })
  } catch {
    throw new Error(`could not resolve host: ${host}`)
  }
  if (resolved.length === 0) {
    throw new Error(`host did not resolve: ${host}`)
  }
  for (const { address } of resolved) {
    if (!ipaddr.isValid(address)) continue
    if (isBlockedAddress(ipaddr.parse(address))) {
      throw new Error(
        `host ${host} resolves to a blocked non-public address (${address})`
      )
    }
  }
}

/**
 * An undici dispatcher (usable as fetch's `dispatcher`) whose DNS resolution
 * REJECTS any resolved address that is not public. Because the validation runs
 * inside the connect-time lookup, the address that passes the check is the same
 * one the socket connects to — closing the DNS-rebinding / TOCTOU window that a
 * pre-flight `assertPublicHost` alone leaves open.
 *
 * Created lazily and shared (one connection pool). `allowPrivate` returns a
 * plain Agent with normal DNS for trusted/internal/test downloads.
 */
let cachedSafeDispatcher: Agent | null = null
let cachedPlainDispatcher: Agent | null = null

export function ssrfSafeDispatcher(allowPrivate = false): Dispatcher {
  if (allowPrivate) {
    cachedPlainDispatcher ??= new Agent()
    return cachedPlainDispatcher
  }
  cachedSafeDispatcher ??= new Agent({
    connect: {
      lookup: (hostname, options, callback) => {
        lookupCb(hostname, { ...options, all: true }, (err, addresses) => {
          if (err) {
            callback(err, "", 0)
            return
          }
          const list = Array.isArray(addresses)
            ? addresses
            : [{ address: addresses as unknown as string, family: 4 }]
          for (const entry of list) {
            if (!isPublicAddress(entry.address)) {
              callback(
                new Error(
                  `SSRF: refusing to connect to non-public address ${entry.address} (${hostname})`
                ),
                "",
                0
              )
              return
            }
          }
          // Hand undici the validated address set; the family arg is ignored
          // when `all` results are returned via the array form.
          callback(
            null,
            list.map((e) => ({ address: e.address, family: e.family }))
          )
        })
      },
    },
  })
  return cachedSafeDispatcher
}
