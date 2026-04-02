# Subprojects

All vendored third-party repositories must live under `subprojects/` as git submodules.

Current convention:

- one repository per direct child directory
- runtime code must resolve subproject paths from `subprojects/<name>`
- application code must not read from `.refer/`

Current subprojects:

- `subprojects/cli-anything`
