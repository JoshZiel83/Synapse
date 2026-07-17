"""Shared code for ALL Python sidecars (`sidecars/_shared`).

Deliberately dependency-light: modules here may only rely on the stdlib plus
packages every consuming sidecar already pins (OTel imports are lazy). The
images flat-COPY this package next to the app (`COPY sidecars/_shared/
./_shared/`), so it is importable as the top-level package `_shared` both
in-container and from the repo (with `sidecars/` on `sys.path`).
"""
