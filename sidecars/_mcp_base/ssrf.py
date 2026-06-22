"""Net-new fail-closed egress guard (§2.3).

Activated per-adapter via ``AdapterConfig.egress_policy``. The base calls
``policy.assert_allowed(url)`` before any tenant-influenceable outbound fetch
(the only such path today is the xhs publish media download against the known
Synapse storage host).

Two policies:

  * ``ExactHostAllowlist`` (PREFERRED) — exact-hostname allowlist. Because the
    content-store endpoint set is known at deploy time, an exact-host allowlist
    is strictly stronger than an RFC1918 deny-list AND immune to DNS-rebinding
    TOCTOU (a getaddrinfo-then-connect deny-list can be flipped to a private IP
    between the check and the connect; an exact hostname can't be rebound into
    the allowlist).
  * ``DenyPrivateNetworks`` — a deny-list fallback (block RFC1918 / loopback /
    link-local / 169.254.169.254 / non-http(s) schemes), fail-closed, re-checked
    on every redirect hop.

``NoEgress`` is the structural no-op for adapters that never reach a download
path (mijia / bilibili / Notion proxy).
"""

from __future__ import annotations

import ipaddress
import socket
from typing import Protocol, runtime_checkable
from urllib.parse import urlsplit


class EgressError(Exception):
    """Raised (fail-closed) when an outbound URL is not allowed."""


@runtime_checkable
class EgressPolicy(Protocol):
    def assert_allowed(self, url: str) -> None:
        """Raise ``EgressError`` if ``url`` must not be fetched. No return."""
        ...


def _require_http_url(url: str) -> tuple[str, str]:
    """Return (scheme, hostname) for an http(s) URL or raise EgressError."""
    try:
        parts = urlsplit(url)
    except ValueError as exc:  # malformed URL
        raise EgressError(f"unparseable url: {exc}") from exc
    scheme = (parts.scheme or "").lower()
    if scheme not in {"http", "https"}:
        raise EgressError(f"scheme not allowed: {scheme!r}")
    host = parts.hostname
    if not host:
        raise EgressError("url has no host")
    return scheme, host


class NoEgress:
    """Structural no-op: this adapter never makes a tenant-influenceable fetch.

    It still fails closed if ever called — an adapter wired with ``NoEgress``
    should not be reaching a download path at all, so a call here is a bug.
    """

    __slots__ = ()

    def assert_allowed(self, url: str) -> None:
        raise EgressError(
            "NoEgress policy: this adapter must not perform outbound fetches"
        )

    def __repr__(self) -> str:  # pragma: no cover - cosmetic
        return "NoEgress()"


class ExactHostAllowlist:
    """Allow only an exact set of hostnames (case-insensitive).

    Immune to DNS-rebinding TOCTOU: the hostname itself is the gate, so an
    attacker who controls DNS for an attacker hostname can never make that
    hostname *equal* an allowlisted one.
    """

    __slots__ = ("_hosts",)

    def __init__(self, hosts):
        normalized = {str(h).strip().lower().rstrip(".") for h in hosts if str(h).strip()}
        if not normalized:
            # Fail-closed: an empty allowlist forbids everything (never accidentally allow-all).
            normalized = frozenset()
        self._hosts = frozenset(normalized)

    @property
    def hosts(self) -> frozenset[str]:
        return self._hosts

    def assert_allowed(self, url: str) -> None:
        _scheme, host = _require_http_url(url)
        if host.lower().rstrip(".") not in self._hosts:
            raise EgressError(f"host not in allowlist: {host!r}")

    def __repr__(self) -> str:  # pragma: no cover - cosmetic
        return f"ExactHostAllowlist({sorted(self._hosts)!r})"


def _is_blocked_ip(ip: ipaddress._BaseAddress) -> bool:
    if ip.is_loopback or ip.is_link_local or ip.is_private or ip.is_reserved:
        return True
    if ip.is_multicast or ip.is_unspecified:
        return True
    # Cloud metadata endpoint (IMDS): block explicitly even if not otherwise caught.
    if str(ip) in {"169.254.169.254", "fd00:ec2::254"}:
        return True
    return False


class DenyPrivateNetworks:
    """Deny-list fallback: block private / loopback / link-local / IMDS hosts.

    Resolves the hostname and rejects if ANY resolved address is private. This
    is weaker than ``ExactHostAllowlist`` (subject to rebinding between this
    check and the eventual connect), so it is a fallback; the caller must also
    re-check on every redirect hop.
    """

    __slots__ = ("_resolver",)

    def __init__(self, resolver=None):
        # Injectable for tests; defaults to the real getaddrinfo.
        self._resolver = resolver or self._default_resolve

    @staticmethod
    def _default_resolve(host: str) -> list[str]:  # pragma: no cover - network
        infos = socket.getaddrinfo(host, None)
        return [info[4][0] for info in infos]

    def assert_allowed(self, url: str) -> None:
        _scheme, host = _require_http_url(url)
        # A bare IP literal: check directly.
        try:
            literal = ipaddress.ip_address(host)
        except ValueError:
            literal = None
        if literal is not None:
            if _is_blocked_ip(literal):
                raise EgressError(f"blocked address: {host!r}")
            return
        try:
            addrs = self._resolver(host)
        except OSError as exc:
            raise EgressError(f"could not resolve host {host!r}: {exc}") from exc
        if not addrs:
            raise EgressError(f"host {host!r} resolved to no addresses")
        for addr in addrs:
            try:
                ip = ipaddress.ip_address(addr)
            except ValueError:
                raise EgressError(f"unparseable resolved address: {addr!r}")
            if _is_blocked_ip(ip):
                raise EgressError(f"host {host!r} resolves to blocked address {addr}")

    def __repr__(self) -> str:  # pragma: no cover - cosmetic
        return "DenyPrivateNetworks()"
