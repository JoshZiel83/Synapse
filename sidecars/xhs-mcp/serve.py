"""xhs-mcp entrypoint — the THIN serve shim (E1: no front-end code here).

This module builds the declarative ``AdapterConfig`` for the 小红书 per-tenant
backend pool and hands it to the ONE shared front end, ``_mcp_base.app.main``.
There is no ``http_server.py`` and no ``StreamableHTTPSessionManager`` here — the
only front end in the whole repo is ``_mcp_base/app.py``.

xhs needs a tiny per-call pre-hook (publish-media materialize + content limits)
that the base's stock ``GenericProxyAdapter`` does not provide. The base exposes
a clean seam for exactly this: ``_mcp_base.app._build_registry`` honors a
pre-supplied ``GenericProxyAdapter`` *subclass* via ``config.adapter`` for a
proxy backend. So we construct ``XhsProxyAdapter(config)`` (the one proxy
implementation plus the publish pre-hook) and set it on the config — no module
attribute substitution, no shared-base edit, no second front end.
"""

from __future__ import annotations


def main() -> None:
    import _mcp_base.app as base_app

    from adapter.xhs_adapter import XhsProxyAdapter, build_config

    config = build_config()
    # Seam: the base's _build_registry uses config.adapter when it is a
    # GenericProxyAdapter subclass (E3: one proxy implementation + a pre-hook).
    config.adapter = XhsProxyAdapter(config)
    base_app.main(config)


if __name__ == "__main__":
    main()
