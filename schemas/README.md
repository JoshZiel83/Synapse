# `/schemas` — JSON Schemas for Synapse config files

These schemas power **editor autocomplete + inline validation** on Synapse's
human-edited config files (VS Code, and any editor with JSON Schema support).
They are mapped to their target files from the repo-root
[`.vscode/settings.json`](../.vscode/settings.json), using **local,
workspace-relative paths only** (no remote URLs — validation works offline and
behind restricted networks).

## Layout

| Path                   | Origin                                                                          | Editable by hand?                    |
| ---------------------- | ------------------------------------------------------------------------------- | ------------------------------------ |
| `*.schema.json`        | **Generated** from Zod by `npm run schema:gen`                                  | ❌ regenerated + drift-checked in CI |
| `vendor/*.schema.json` | **Vendored** third-party schemas (see [`vendor/README.md`](./vendor/README.md)) | ❌ refreshed from upstream           |

## Single source of truth

Zod is authoritative. Every generated `*.schema.json` is derived from a Zod
schema registered in
[`packages/api/scripts/gen-config-schemas.mts`](../packages/api/scripts/gen-config-schemas.mts).

```bash
npm run schema:gen        # regenerate all committed schemas from their Zod sources
npm run guard:schemas     # CI no-drift check (fails if a committed schema is stale)
```

`guard:schemas` runs both in the api `pretest` chain and in the CI boundary gate
(`scripts/verify-boundary.sh`), so a schema left out of sync with its Zod source
fails the build.

## What editor validation does and does not cover

Generated with `target: 'draft-7'` and `io: 'input'`:

- **Covered:** field names, types, enums, string patterns, numeric bounds,
  required vs optional — i.e. the _shape_ of the config.
- **Not covered:** cross-field rules declared with Zod `.superRefine()` (e.g.
  "a selected provider requires its sidecar URL", "at most one default group").
  Those are, by design, not expressible in JSON Schema and stay enforced at
  runtime by Zod. Editor validation is a fast first line of defense, not the
  full contract.

`draft-7` is deliberate: VS Code's JSON language service and `redhat.vscode-yaml`
fully support draft-04..07 but only partially support the 2019-09 / 2020-12
dialects that `z.toJSONSchema` emits by default.

See `docs/config-json-schema-extraction-plan-2026-07-24.md` for the full design.
