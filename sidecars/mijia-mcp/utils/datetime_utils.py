"""Canonical wire-timestamp helper for the mijia-mcp sidecar.

Every timestamp this sidecar emits over the wire (auth metadata, QR-generation
time, device-status `last_update`) MUST be produced here so there is exactly
ONE formatter (C1) and zero naive-local / self-invented formats (C2).

Canonical wire instant: ``YYYY-MM-DDTHH:MM:SS.mmmZ`` (UTC, exactly 3 fractional
digits, trailing ``Z``), matching
``^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$`` — identical to the
TS ``IsoInstantString`` contract and the Rust ``iso_instant_now()`` output.
"""

from datetime import datetime, timezone


def utc_iso_millis() -> str:
    """Return the current instant as a canonical UTC ISO-8601 string.

    ``timespec="milliseconds"`` forces exactly three fractional digits; the
    ``+00:00`` → ``Z`` swap yields the canonical wire shape. Unlike a naive
    local timestamp, this is timezone-aware UTC, so it never emits a local
    time that a downstream parser would misread.
    """
    return (
        datetime.now(timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )
