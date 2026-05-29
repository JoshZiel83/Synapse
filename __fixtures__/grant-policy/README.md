# Grant policy validation fixtures (package-neutral)

These JSON files are the canonical case set for the runtime authorization grant
policy branch-specific validator. They are consumed by:

- `packages/shared/src/access/policies/grant.test.ts`
  — exercises `validateGrantPolicyForCapability` (camelCase API path)
- `packages/device-protocol/src/schemas.test.ts`
  — exercises `RuntimeAuthorizationGrantSpecSchema.safeParse`
  (snake_case wire path)

Both sides MUST agree on every `expect` field. The keys here are camelCase
where the camelCase / snake_case shape is identical, and per-capability sub-
policies are written in snake_case so the wire side can consume them
directly; the API side re-keys the per-capability sub-policies through its
adapter (`packages/shared/src/access/policies/{filesystem,browser,cua,commandline}.ts`)
before re-encoding.

Add new cases here when the validator gains or tightens a rule. Adding fixtures
only on one side leads to silent semantic drift between the API matcher and
the device wire schema — exactly what `subject-scope-refactor` was designed
to prevent.
