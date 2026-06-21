"""Per-request tenant + credential header extraction (generalized from
mijia's ``_decode_tenant_headers``).

The credential header NAME is an explicit AdapterConfig field
(``header_auth_name``) — NOT prefix-derived — because Notion's is ``Notion-Token``
(no ``X-``/``-Auth``) and bilibili/xhs use cookie-semantic ``X-Bili-Cookie`` /
``X-Xhs-Cookie``. The ``X-<Name>-Tenant`` and ``X-<Name>-Expose-Raw`` headers ARE
derived from ``header_prefix``.

The credential string is cred-source-agnostic: ``${config:...}`` (plaintext
secret model) and ``${auth_b64:field}`` (auth-driver model) both render to the
same plain string in the credential header; the api side decides the source and
the sidecar only sees the rendered value (§2.8).

``cred_kind`` drives parsing:
  * ``b64_json``   — base64-decode + json.loads + assert dict (mijia).
  * ``raw_string`` — keep the hardening (16KB cap + reject control chars/CRLF +
    optional required-key assertion). NOT just "drop the base64".

A ``DecodedHeaders`` always carries ``auth_hash = sha256(raw)`` (the
per-(tenant,cred) cache + rotation-retire key), the parsed credential, and the
``expose_raw`` flag derived from the AUTHENTICATED request.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
from dataclasses import dataclass
from typing import Any, Optional

from .adapter import AdapterConfig

MAX_AUTH_HEADER_BYTES = 16 * 1024
MAX_TENANT_LEN = 256


class TenantError(Exception):
    """Raised when the per-request tenant/credential headers are unusable."""


@dataclass
class DecodedHeaders:
    tenant: str
    # The parsed credential: a dict for b64_json, the raw string for raw_string.
    cred: Any
    # The raw credential string exactly as received (used for auth_hash and,
    # for raw_string backends, what gets written to disk / injected upstream).
    raw_cred: str
    auth_hash: str
    expose_raw: bool


_TRUTHY = {"1", "true", "yes", "on"}


def _truthy(value: Optional[str]) -> bool:
    return (value or "").strip().lower() in _TRUTHY


def _has_control_chars(s: str) -> bool:
    # Reject C0/C1 controls (incl. CR/LF/NUL) to block header injection into the
    # upstream. Tab is included — credential headers never legitimately carry it.
    for ch in s:
        code = ord(ch)
        if code < 0x20 or code == 0x7F or 0x80 <= code <= 0x9F:
            return True
    return False


def _auth_hash(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:32]


def decode_tenant_headers(headers, config: AdapterConfig) -> DecodedHeaders:
    """Decode the tenant + credential + flag headers per ``config``.

    ``headers`` is anything with a case-insensitive ``.get(name)`` (a Starlette
    ``request.headers`` or a plain dict-like used in tests).
    """
    tenant_header = config.tenant_header()
    tenant = (headers.get(tenant_header) or "").strip()
    if not tenant or len(tenant) > MAX_TENANT_LEN:
        raise TenantError(f"missing or invalid {tenant_header} header")

    raw_cred = headers.get(config.header_auth_name) or ""
    if not raw_cred or len(raw_cred) > MAX_AUTH_HEADER_BYTES:
        raise TenantError(
            f"missing or oversized {config.header_auth_name} header"
        )

    if config.cred_kind == "b64_json":
        cred = _decode_b64_json(raw_cred, config.header_auth_name)
    elif config.cred_kind == "raw_string":
        cred = _decode_raw_string(raw_cred, config)
    else:  # pragma: no cover - guarded by the CredKind Literal
        raise TenantError(f"unknown cred_kind: {config.cred_kind!r}")

    expose_raw = _truthy(headers.get(config.expose_raw_header()))
    return DecodedHeaders(
        tenant=tenant,
        cred=cred,
        raw_cred=raw_cred,
        auth_hash=_auth_hash(raw_cred),
        expose_raw=expose_raw,
    )


def _decode_b64_json(raw: str, header_name: str) -> dict[str, Any]:
    try:
        decoded = base64.b64decode(raw, validate=True)
        obj = json.loads(decoded.decode("utf-8"))
    except (binascii.Error, ValueError, UnicodeDecodeError) as exc:
        raise TenantError(f"{header_name} is not valid base64 JSON") from exc
    if not isinstance(obj, dict):
        raise TenantError(f"{header_name} must decode to a JSON object")
    return obj


def _decode_raw_string(raw: str, config: AdapterConfig) -> str:
    if _has_control_chars(raw):
        raise TenantError(
            f"{config.header_auth_name} contains control characters"
        )
    # Case-insensitive presence check so the gate accepts every credential
    # shape the adapters advertise as valid: the cookie-pair string
    # ("SESSDATA=...; bili_jct=...") AND its lowercase form ("sessdata=...")
    # AND the JSON object ('{"sessdata":"...","bili_jct":"..."}'). A
    # case-sensitive substring on the raw header would fail-closed on a
    # legitimately-formatted lowercase/JSON cookie that the bilibili adapter's
    # _parse_cookie explicitly tolerates.
    raw_lower = raw.lower()
    for key in config.cred_required_keys:
        if key.lower() not in raw_lower:
            raise TenantError(
                f"{config.header_auth_name} missing required key {key!r}"
            )
    return raw
