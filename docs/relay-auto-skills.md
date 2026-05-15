# Relay Auto-Loaded Skills

## Purpose

Synapse supports a temporary skill surface for `cli-anything-*` capabilities exposed by an MCP relay commandline client.

These skills are:

- not persisted in `installed_skills`
- not bound permanently to a session
- synthesized at runtime from relay capability visibility plus local repo skill files

This document records the current behavior and the April 6, 2026 path-resolution fix.

## Current Runtime Model

### 1. Relay client reports commandline capability metadata

The relay client sends MCP server catalog data through `catalog.sync`.

For the built-in commandline server, the relay metadata includes:

- `builtinKind = "commandline"`
- `cliAnythingCapabilities = [...]`

Each capability item includes:

- `slug`
- `command`
- `module`
- `version`
- `ready`
- `reason`

Important: the relay client reports capability metadata, not a separate skill package payload.

### 2. API filters relay exposures by current session visibility

On the API side, relay auto-loaded skills are only considered when all of the following are true:

- the current actor/session can use the matching `relay_capability`
- the relay exposure is `healthy`
- the relay device has an active session
- the exposure metadata resolves to `builtinKind = "commandline"`
- the `cliAnythingCapabilities[*].ready` flag is `true`

This means auto-loaded skills are gated by the same visibility and authorization surface as the relay capability itself.

Important: the trigger is current visibility, not “the session already used the relay tool once”.

### 3. API intersects relay-ready capabilities with a local allowlist

The API does not trust arbitrary relay-reported slugs as standalone skills.

Instead, it loads a local manifest:

- `relay/managed-command-providers.json`

For each manifest entry, it reads the local skill file:

- `subprojects/cli-anything/<repoDir>/agent-harness/cli_anything/<module>/skills/SKILL.md`

Then it synthesizes a temporary skill:

- `slug = cli-anything-<capability-slug>`
- `sourceKind = relay_auto_loaded`

So the relay chooses which capabilities are ready, but the server still controls which skills exist and what text they contain.

### 4. Temporary skills are merged into available skills

`listVisibleSkills()` merges:

- installed skills
- relay auto-loaded skills

Behavior notes:

- relay auto-loaded skills are temporary runtime entries
- installed skills win on slug collisions
- prompt-builder marks these entries as `(relay auto-loaded)`
- the model can load them through `read_skill`

## Path Bug Fixed On April 6, 2026

### Bug

The previous implementation resolved repo paths from `process.cwd()`.

That broke under normal API startup paths such as:

- `npm run dev -w packages/api`
- `npm run start -w packages/api`

In those cases the Node process cwd becomes:

```text
/home/ubuntu/project/synapse/packages/api
```

So the old code tried to read:

```text
/home/ubuntu/project/synapse/packages/api/relay/cli-anything-wave1.json
/home/ubuntu/project/synapse/packages/api/subprojects/cli-anything/...
```

Those paths do not exist.

### Symptom

The API logged repeated errors like:

```text
[relay-auto-skills] failed to load relay auto skills: ENOENT ... /packages/api/relay/cli-anything-wave1.json
```

### Fix

Repo-root resolution is now derived from module location, not process cwd.

New helper:

- `packages/api/src/config/repo-paths.ts`

Current approach:

- resolve API package root from `import.meta.url`
- resolve repo root from the API package root
- derive `relay/` and `subprojects/` from that stable repo root

Files changed:

- `packages/api/src/config/repo-paths.ts`
- `packages/api/src/config/subprojects.ts`
- `packages/api/src/modules/skills/relay-auto-skills.ts`
- `packages/api/src/config/repo-paths.test.ts`

## Operational Verification On April 6, 2026

### Backend restart

The API service was restarted with:

```bash
sudo -n systemctl restart synapse-api
```

Post-restart checks:

- `synapse-api.service` returned `active`
- `curl http://127.0.0.1:3001/api/v1/auth/me` returned `401`

The `401` is expected for an unauthenticated probe and confirms the backend is serving requests.

### Skill-loader verification

The production build output was exercised directly with cwd forced to `packages/api`:

```js
readRelayAutoLoadedSkill({ skillName: "cli-anything-anygen" })
```

Result:

- load succeeded
- returned skill slug `cli-anything-anygen`
- returned description asset `(description)`
- returned actual skill markdown content from the repo

This validates the path bug fix against the same startup cwd pattern that previously failed.

### Journal verification

Historical journal entries show the old `ENOENT` path bug.

After the April 6, 2026 restart, filtering `journalctl -u synapse-api --since '2026-04-06 18:36:47'` for:

- `relay-auto-skills`
- `packages/api/relay/cli-anything-wave1.json`

returned no matches.

## Current Confidence Level

Confirmed:

- backend restart completed
- backend is responding on port `3001`
- production build can now load relay auto-skill files correctly under `cwd = packages/api`
- the previous `ENOENT` signature did not reappear after restart

Not confirmed in this run:

- a full end-to-end `listVisibleSkills()` result using a live session with a connected healthy relay commandline exposure

At the time of verification, the local database did not provide a usable live sample for that end-to-end check.

## Recommended Ongoing Checks

When validating this area again, use this order:

1. Confirm the relay device is connected and the commandline exposure is `healthy`.
2. Confirm the current actor/session can use the matching `relay_capability`.
3. Confirm the exposure metadata contains `cliAnythingCapabilities[*].ready = true`.
4. Confirm the skill slug appears in the actor prompt as `(relay auto-loaded)`.
5. Confirm `read_skill` can read the generated skill entry successfully.

## Design Constraints To Keep In Mind

- relay auto-loaded skills should remain temporary runtime surface items
- they should stay authorization-scoped to the current actor/session context
- they should not overwrite installed skills
- server-side local manifests should remain the source of truth for skill text and allowed slugs
