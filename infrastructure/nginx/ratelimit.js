// Ring-0 rate-limit CLIENT KEY (njs) — the key for limit_req_zone /
// limit_conn_zone in public.conf.template. Wired as
//   js_import synapse_ratelimit from /etc/nginx/ratelimit.js;
//   js_set    $synapse_client_key synapse_ratelimit.clientKey;
// and every public zone keys on $synapse_client_key.
//
// WHY njs and not a map/regex (adjudication-2 R4): a single IPv6 allocation is a
// /64 (routers hand out one /64 per customer), so keying IPv6 per full address
// would give ONE attacker 2^64 free identities. The /64 must be derived from the
// address STRUCTURE — a textual "first four groups" regex silently gets the
// COMPRESSED forms wrong (`::1`, `fe80::1`, `2001:db8::1` have fewer than four
// literal groups before the first `::`), so we expand `::` here instead.
//
//   * IPv4 (and IPv4-mapped IPv6 `::ffff:a.b.c.d` / deprecated `::a.b.c.d`):
//     keyed on the full IPv4 address — those are single IPv4 clients.
//   * pure IPv6: keyed on the /64 prefix (first four hextets, zero-padded).
//
// Reads $remote_addr, so it honors any realip rewrite already applied. Empty is
// never returned (remote_addr is always set); an empty key would disable the
// limit for that request.

function prefix64(addr) {
  // Embedded IPv4 tail ⇒ IPv4-mapped/-compatible: key on the real IPv4 client.
  if (addr.indexOf(".") >= 0) {
    return addr.substring(addr.lastIndexOf(":") + 1)
  }
  // Pure IPv6. Split on the single `::` (zero-run), expand it to full 8 groups.
  var head = addr
  var tail = ""
  var dc = addr.indexOf("::")
  if (dc >= 0) {
    head = addr.substring(0, dc)
    tail = addr.substring(dc + 2)
  }
  var headGroups = head === "" ? [] : head.split(":")
  var tailGroups = tail === "" ? [] : tail.split(":")
  var missing = 8 - headGroups.length - tailGroups.length
  if (missing < 0) missing = 0
  var groups = []
  var i
  for (i = 0; i < headGroups.length; i++) groups.push(headGroups[i])
  for (i = 0; i < missing; i++) groups.push("0")
  for (i = 0; i < tailGroups.length; i++) groups.push(tailGroups[i])
  // First four hextets = /64; zero-pad each to 4 hex so the key is canonical.
  var key = ""
  for (i = 0; i < 4; i++) {
    var g = groups[i] || "0"
    while (g.length < 4) g = "0" + g
    key += (i ? ":" : "") + g
  }
  return key
}

function clientKey(r) {
  var addr = r.variables.remote_addr || ""
  if (addr.indexOf(":") < 0) return addr // IPv4
  return prefix64(addr)
}

export default { clientKey }
