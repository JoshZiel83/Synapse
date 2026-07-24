# `/schemas/vendor` — vendored third-party JSON Schemas

Upstream JSON Schemas vendored **locally** so editor validation of the config
files they describe works offline and behind restricted networks (no reliance on
`schemastore.org` / `raw.githubusercontent.com`, which are not reliably reachable
everywhere). They are third-party artifacts — do not hand-edit; refresh from
upstream instead.

Refresh all vendored schemas:

```bash
npm run schema:refresh-vendored
```

(The script that does this is
[`scripts/refresh-vendored-schemas.mjs`](../../scripts/refresh-vendored-schemas.mjs);
it lists each schema's canonical source URL.)

## Inventory

| File                       | Describes             | Upstream source                                                                               |
| -------------------------- | --------------------- | --------------------------------------------------------------------------------------------- |
| `compose-spec.schema.json` | `docker-compose*.yml` | `https://raw.githubusercontent.com/compose-spec/compose-spec/master/schema/compose-spec.json` |

> Vendored copies are pinned to whatever upstream served at fetch time and are
> marked `linguist-vendored` in `.gitattributes` so they don't skew language
> stats or drown PR review. Bump them intentionally via the refresh script.
