#!/usr/bin/env bash
# P-F (ingress half) — the Ring-0 edge gate probe, §4.F verification / Phase-4
# gate of docs/trace-correctness-remediation-plan-2026-07-12.md, extended for the
# round-2 trust boundary (§3a A3): the ingress MARKER + the rate LIMITER.
#
# Boots BOTH public edge templates exactly the way the deploy does (template
# mounted at /etc/nginx/templates/default.conf.template, rendered by the nginx
# image's envsubst entrypoint; ratelimit.js bind-mounted into the TLS edge since
# it is not yet baked into the running image) in front of a header-echoing
# upstream that impersonates api/web/mobile-web/verdaccio, then sends requests
# carrying forged `traceparent`/`tracestate`/`baggage`/`sentry-trace` AND a
# forged `x-synapse-trace-ingress` at the public origin and asserts:
#   * STRIP: upstream receives the forged headers as traceparent-ONLY —
#     tracestate/baggage/sentry-trace are stripped on EVERY proxied location,
#     repeated specifically for /ws and / (the proxy_set_header inheritance
#     footgun locations, which declare their own and re-declare the strips);
#   * MARKER: upstream ALWAYS receives `x-synapse-trace-ingress: public` — the
#     nginx-forced value OVERRIDES a forged single copy AND a duplicated copy,
#     on inheriting AND self-declaring locations;
#   * LIMITER: a page-load-shaped burst to /api/ passes clean, a rapid flood
#     yields a 200/429 mix (never 503) with `limiting requests … synapse_api_req`
#     in the edge log; /ws is bounded at its lower burst;
#   * each location still passes its existing headers (X-Forwarded-* on
#     inheriting locations; Upgrade/Connection on the self-declaring ones).
#
# Requirements: docker; openssl on the host; the custom edge image built from
# infrastructure/Dockerfile.nginx present locally (auto-detected by its baked
# /etc/nginx/cdt.js, or pass EDGE_TLS_IMAGE=<repo:tag>); nginx:alpine (pulled
# if absent) for the http-profile edge, the echo upstream and the in-network
# curl runner. Run:
#   bash scripts/trace-probes/p-f-ingress-strip.sh
set -u

SUFFIX="$$"
NET="p-f-ingress-net-${SUFFIX}"
ECHO_C="p-f-ingress-echo-${SUFFIX}"
TLS_C="p-f-ingress-edge-tls-${SUFFIX}"
HTTP_C="p-f-ingress-edge-http-${SUFFIX}"
TMP="$(mktemp -d)"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
TLS_TEMPLATE="${REPO_ROOT}/infrastructure/nginx/public.conf.template"
HTTP_TEMPLATE="${REPO_ROOT}/infrastructure/nginx/public-http.conf.template"

PUBLIC_DOMAIN=synapse.example.com
WWW_DOMAIN=www.synapse.example.com
MOBILE_SHORT_DOMAIN=m.synapse.example.com
MOBILE_DOMAIN=mobile.synapse.example.com
REGISTRY_DOMAIN=registry.synapse.example.com
CERT_NAME=probe

FORGED_TP='00-11111111111111111111111111111111-2222222222222222-01'
FORGED_TS='rojo=00f067aa0ba902b7,congo=t61rcWkgMzE'
FORGED_BAGGAGE='userId=forged,serverNode=DF%2028'
FORGED_SENTRY='11111111111111111111111111111111-2222222222222222-1'
# Forged Ring-0 marker: nginx must OVERRIDE this with "public" on every location.
FORGED_INGRESS='internal'

PASS=0
FAIL=0
check() { # check <label> <0|1 cond as $?-style int>
  if [ "$2" -eq 0 ]; then PASS=$((PASS + 1)); echo "PASS $1"
  else FAIL=$((FAIL + 1)); echo "FAIL $1" >&2; fi
}

cleanup() {
  docker rm -f "$ECHO_C" "$TLS_C" "$HTTP_C" >/dev/null 2>&1
  docker network rm "$NET" >/dev/null 2>&1
  rm -rf "$TMP"
}
trap cleanup EXIT

# ── Edge TLS image: the custom build from infrastructure/Dockerfile.nginx ────
detect_tls_image() {
  if [ -n "${EDGE_TLS_IMAGE:-}" ]; then echo "$EDGE_TLS_IMAGE"; return; fi
  local candidate
  for candidate in $(docker images --format '{{.Repository}}:{{.Tag}}' \
    | grep -E -- '-nginx:latest$'); do
    if docker run --rm --entrypoint sh "$candidate" \
      -c 'test -f /etc/nginx/cdt.js' >/dev/null 2>&1; then
      echo "$candidate"; return
    fi
  done
}
TLS_IMAGE="$(detect_tls_image)"
if [ -z "$TLS_IMAGE" ]; then
  echo "FAIL no custom edge image found — build it (docker compose build web nginx)" \
    "or pass EDGE_TLS_IMAGE=<repo:tag>" >&2
  exit 1
fi
echo "edge TLS image: $TLS_IMAGE"

# ── Echo upstream: one container aliased as all four proxied backends ────────
# add_header with an EMPTY value is skipped, so an absent x-echo-* response
# header means the upstream request header did not arrive.
cat > "$TMP/echo.conf" <<'EOF'
server {
    listen 3001;
    listen 3000;
    listen 80;
    listen 4873;
    location / {
        add_header x-echo-port $server_port always;
        add_header x-echo-host $http_host always;
        add_header x-echo-traceparent $http_traceparent always;
        add_header x-echo-tracestate $http_tracestate always;
        add_header x-echo-baggage $http_baggage always;
        add_header x-echo-sentry-trace $http_sentry_trace always;
        add_header x-echo-ingress $http_x_synapse_trace_ingress always;
        add_header x-echo-upgrade $http_upgrade always;
        add_header x-echo-connection $http_connection always;
        add_header x-echo-xff $http_x_forwarded_for always;
        add_header x-echo-xfproto $http_x_forwarded_proto always;
        add_header x-echo-xrealip $http_x_real_ip always;
        return 200 "ok";
    }
}
EOF

# ── Self-signed cert covering all five public server_names ───────────────────
mkdir -p "$TMP/letsencrypt/live/$CERT_NAME" "$TMP/certbot-www"
openssl req -x509 -newkey rsa:2048 -nodes -days 2 \
  -keyout "$TMP/letsencrypt/live/$CERT_NAME/privkey.pem" \
  -out "$TMP/letsencrypt/live/$CERT_NAME/fullchain.pem" \
  -subj "/CN=$PUBLIC_DOMAIN" \
  -addext "subjectAltName=DNS:$PUBLIC_DOMAIN,DNS:$WWW_DOMAIN,DNS:$MOBILE_SHORT_DOMAIN,DNS:$MOBILE_DOMAIN,DNS:$REGISTRY_DOMAIN" \
  >/dev/null 2>&1
cp "$TMP/letsencrypt/live/$CERT_NAME/fullchain.pem" \
   "$TMP/letsencrypt/live/$CERT_NAME/chain.pem"
chmod -R a+rX "$TMP/letsencrypt"

docker network create "$NET" >/dev/null

docker run -d --name "$ECHO_C" --network "$NET" \
  --network-alias api --network-alias web \
  --network-alias mobile-web --network-alias verdaccio \
  -v "$TMP/echo.conf":/etc/nginx/conf.d/default.conf:ro \
  nginx:alpine >/dev/null

# TLS edge: template + entrypoint envsubst — the exact deploy mechanism
# (docker-compose.yml nginx service).
docker run -d --name "$TLS_C" --network "$NET" \
  -e SYNAPSE_PUBLIC_DOMAIN="$PUBLIC_DOMAIN" \
  -e SYNAPSE_WWW_DOMAIN="$WWW_DOMAIN" \
  -e SYNAPSE_MOBILE_SHORT_DOMAIN="$MOBILE_SHORT_DOMAIN" \
  -e SYNAPSE_MOBILE_DOMAIN="$MOBILE_DOMAIN" \
  -e SYNAPSE_REGISTRY_DOMAIN="$REGISTRY_DOMAIN" \
  -e LETSENCRYPT_CERT_NAME="$CERT_NAME" \
  -v "$TLS_TEMPLATE":/etc/nginx/templates/default.conf.template:ro \
  -v "${REPO_ROOT}/infrastructure/nginx/ratelimit.js":/etc/nginx/ratelimit.js:ro \
  -v "$TMP/letsencrypt":/etc/letsencrypt:ro \
  -v "$TMP/certbot-www":/var/www/certbot:ro \
  "$TLS_IMAGE" >/dev/null

# http-profile edge: stock nginx:alpine, exactly like the nginx-http service.
docker run -d --name "$HTTP_C" --network "$NET" \
  -v "$HTTP_TEMPLATE":/etc/nginx/templates/default.conf.template:ro \
  nginx:alpine >/dev/null

# ── In-network curl (daemon-location agnostic) ───────────────────────────────
curl_edge() { # curl_edge <curl args...> — prints response headers
  docker run --rm --network "$NET" nginx:alpine \
    curl -sk -D- -o /dev/null --max-time 10 "$@"
}
forged=(-H "traceparent: $FORGED_TP" -H "tracestate: $FORGED_TS"
        -H "baggage: $FORGED_BAGGAGE" -H "sentry-trace: $FORGED_SENTRY"
        -H "x-synapse-trace-ingress: $FORGED_INGRESS")

wait_ready() { # wait_ready <label> <curl args...>
  local label="$1"; shift
  local i
  for i in $(seq 1 40); do
    if curl_edge "$@" 2>/dev/null | grep -q ' 200'; then return 0; fi
    sleep 0.5
  done
  echo "FAIL $label never became ready" >&2
  docker logs "$TLS_C" 2>&1 | tail -5 >&2
  docker logs "$HTTP_C" 2>&1 | tail -5 >&2
  exit 1
}
wait_ready "edge-http" "http://$HTTP_C/api/ready"
wait_ready "edge-tls" --connect-to "$PUBLIC_DOMAIN:443:$TLS_C:443" \
  "https://$PUBLIC_DOMAIN/api/ready"

has() { printf '%s' "$1" | grep -qi "$2"; }

assert_case() { # assert_case <label> <headers> <port> <expect_xfwd 0|1> <expect_upgrade 0|1>
  local label="$1" hdrs="$2" port="$3" expect_xfwd="$4" expect_upgrade="$5"
  has "$hdrs" " 200"; check "$label: HTTP 200" $?
  has "$hdrs" "^x-echo-port: $port"; check "$label: routed to :$port" $?
  # THE strip assertions: traceparent-only arrives upstream.
  has "$hdrs" "^x-echo-traceparent: $FORGED_TP"; check "$label: traceparent KEPT" $?
  ! has "$hdrs" "^x-echo-tracestate:"; check "$label: tracestate STRIPPED" $?
  ! has "$hdrs" "^x-echo-baggage:"; check "$label: baggage STRIPPED" $?
  ! has "$hdrs" "^x-echo-sentry-trace:"; check "$label: sentry-trace STRIPPED" $?
  # THE marker assertion: nginx forces `public`, overriding the forged `internal`.
  has "$hdrs" "^x-echo-ingress: public"; check "$label: ingress marker forced to public" $?
  # Existing headers still pass.
  if [ "$expect_xfwd" -eq 1 ]; then
    has "$hdrs" "^x-echo-xff: "; check "$label: X-Forwarded-For passes" $?
    has "$hdrs" "^x-echo-xrealip: "; check "$label: X-Real-IP passes" $?
  fi
  if [ "$expect_upgrade" -eq 1 ]; then
    has "$hdrs" "^x-echo-upgrade: websocket"; check "$label: Upgrade passes" $?
    has "$hdrs" "^x-echo-connection: upgrade"; check "$label: Connection upgrade passes" $?
  fi
}

tls() { # tls <sni-host> <path> <extra curl args...>
  local host="$1" path="$2"; shift 2
  curl_edge --connect-to "$host:443:$TLS_C:443" "${forged[@]}" "$@" \
    "https://$host$path"
}

# ── Negative control: no inbound trace headers ⇒ no x-echo trace headers ─────
h="$(curl_edge "http://$HTTP_C/api/ready")"
has "$h" "^x-echo-host: "; check "control: echo emits present headers" $?
! has "$h" "^x-echo-traceparent:"; check "control: absent header ⇒ absent echo" $?

# ── TLS template: web vhost ──────────────────────────────────────────────────
assert_case "tls web /api/"    "$(tls "$PUBLIC_DOMAIN" /api/probe)"            3001 1 0
assert_case "tls web /ws"      "$(tls "$PUBLIC_DOMAIN" /ws --http1.1 -H 'Upgrade: websocket')" 3001 0 1
assert_case "tls web /_next/"  "$(tls "$PUBLIC_DOMAIN" /_next/probe --http1.1 -H 'Upgrade: websocket')" 3000 0 1
assert_case "tls web /"        "$(tls "$PUBLIC_DOMAIN" /probe --http1.1 -H 'Upgrade: websocket')" 3000 0 1
assert_case "tls web /mobile/" "$(tls "$PUBLIC_DOMAIN" /mobile/probe)"         80   1 0
h="$(tls "$PUBLIC_DOMAIN" /api/probe)"
has "$h" "^x-echo-host: $PUBLIC_DOMAIN"; check "tls web /api/: Host passes" $?
has "$h" "^x-echo-xfproto: https"; check "tls web /api/: X-Forwarded-Proto passes" $?

# ── TLS template: mobile vhost ───────────────────────────────────────────────
assert_case "tls mobile /api/"    "$(tls "$MOBILE_SHORT_DOMAIN" /api/probe)"    3001 1 0
assert_case "tls mobile /ws"      "$(tls "$MOBILE_SHORT_DOMAIN" /ws --http1.1 -H 'Upgrade: websocket')" 3001 0 1
assert_case "tls mobile /mobile/" "$(tls "$MOBILE_SHORT_DOMAIN" /mobile/probe)" 80   1 0

# ── TLS template: registry vhost (self-declaring location /) ─────────────────
assert_case "tls registry /" "$(tls "$REGISTRY_DOMAIN" /probe)" 4873 1 0
h="$(tls "$REGISTRY_DOMAIN" /probe)"
has "$h" "^x-echo-host: $REGISTRY_DOMAIN"; check "tls registry /: Host passes" $?

# ── http-profile template ────────────────────────────────────────────────────
assert_case "http /api/"    "$(curl_edge "${forged[@]}" "http://$HTTP_C/api/probe")"    3001 1 0
assert_case "http /ws"      "$(curl_edge "${forged[@]}" --http1.1 -H 'Upgrade: websocket' "http://$HTTP_C/ws")" 3001 0 1
assert_case "http /_next/"  "$(curl_edge "${forged[@]}" --http1.1 -H 'Upgrade: websocket' "http://$HTTP_C/_next/probe")" 3000 0 1
assert_case "http /"        "$(curl_edge "${forged[@]}" --http1.1 -H 'Upgrade: websocket' "http://$HTTP_C/probe")" 3000 0 1
assert_case "http /mobile/" "$(curl_edge "${forged[@]}" "http://$HTTP_C/mobile/probe")"  80   1 0

# ── Marker: a DUPLICATED forged client copy is also overridden to public ─────
dup="$(curl_edge --connect-to "$PUBLIC_DOMAIN:443:$TLS_C:443" \
  -H "x-synapse-trace-ingress: internal" -H "x-synapse-trace-ingress: forged2" \
  "https://$PUBLIC_DOMAIN/api/dupmarker")"
has "$dup" "^x-echo-ingress: public"; check "marker: duplicated forged copy overridden to public" $?
! has "$dup" "^x-echo-ingress:.*internal"; check "marker: forged value does not leak upstream" $?

# ── Limiter smoke (U2) ───────────────────────────────────────────────────────
# One curl PROCESS with N URLs (keepalive) is fast enough to exhaust the burst;
# a slow one-request-per-container loop never would. sort|uniq -c → "<n> <code>".
flood() { # flood <count> <base> <path-prefix> [extra curl args...]
  local count="$1" base="$2" prefix="$3"; shift 3
  local urls="" i
  for i in $(seq 1 "$count"); do urls="$urls ${base}${prefix}${i}"; done
  docker run --rm --network "$NET" nginx:alpine \
    curl -sk -o /dev/null -w '%{http_code}\n' "$@" $urls 2>/dev/null | sort | uniq -c
}
codecount() { printf '%s\n' "$1" | awk -v c="$2" '$2==c{print $1}'; }

# (a) page-load-shaped burst (30 << burst 200) on a fresh bucket ⇒ zero 429.
small="$(flood 30 "http://$HTTP_C" /api/pl)"
[ "$(codecount "$small" 429)" = "" ]; check "limiter: 30-request page-load burst to /api/ has zero 429" $?

# (b) rapid flood ⇒ a 200/429 MIX, never 503, and the tripped zone is logged.
big="$(flood 400 "http://$HTTP_C" /api/fl)"
[ -n "$(codecount "$big" 200)" ]; check "limiter: /api/ flood yields some 200" $?
[ -n "$(codecount "$big" 429)" ]; check "limiter: /api/ flood yields some 429" $?
[ -z "$(codecount "$big" 503)" ]; check "limiter: /api/ flood never 503 (429 not the default 503)" $?
has "$(docker logs "$HTTP_C" 2>&1)" 'limiting requests.*by zone "synapse_api_req"'
check "limiter: edge log names the synapse_api_req zone" $?

# (c) /ws at its lower burst (50) also shapes a flood.
bigws="$(flood 200 "http://$HTTP_C" /ws)"
[ -n "$(codecount "$bigws" 429)" ]; check "limiter: /ws flood yields some 429 (burst 50)" $?

# (d) TLS edge — the njs /64 key path — also limits (proves js_set works as a
#     limit_req_zone key at runtime, not just parses).
bigtls="$(flood 400 "https://$PUBLIC_DOMAIN" /api/fl --connect-to "$PUBLIC_DOMAIN:443:$TLS_C:443")"
[ -n "$(codecount "$bigtls" 429)" ]; check "limiter: TLS /api/ flood yields some 429 (njs js_set /64 key)" $?
has "$(docker logs "$TLS_C" 2>&1)" 'limiting requests.*by zone "synapse_api_req"'
check "limiter: TLS edge log names the synapse_api_req zone" $?

echo
echo "p-f-ingress-strip: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
