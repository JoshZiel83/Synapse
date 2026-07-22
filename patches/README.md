# patches/

Dependency patches applied by [patch-package](https://github.com/ds300/patch-package),
replayed by `scripts/apply-patches.mjs` (the root `postinstall`, an explicit
build-time step in every image that installs the root `package-lock.json`, and
the host gate in `scripts/verify-boundary.sh`).

## Why this file exists

Git cannot track an empty directory. `scripts/apply-patches.mjs` treats an
**absent** `patches/` directory as the signal that an image forgot its
`COPY patches/ patches/` — `patch-package --error-on-fail` exits 0 when
`patches/` is missing, so that absence is the only reliable catcher. This
committed `README.md` keeps git carrying the directory, so a landed
`COPY patches/` always brings at least this file: **directory present ⇒ the COPY
happened; directory absent ⇒ it did not.** A present but patch-less directory is
therefore not a failure — only an absent one is.

## Adding or regenerating a patch

`scripts/apply-patches.mjs` is version-agnostic: it globs `patches/*.patch` and
derives the target package and its content markers from each patch body. It
never names a filename, package, version, or symbol, so adding, bumping, or
regenerating a patch needs no change to the script, the Dockerfiles, or the host
gate. One constraint: each modified target file in a patch must contain at least
one added (`+`) line of 12+ characters, or the applier fails closed with "no
assertable marker" (a whitespace- or comment-only patch cannot be proven applied
by substring and needs a stronger check taught to the applier).
