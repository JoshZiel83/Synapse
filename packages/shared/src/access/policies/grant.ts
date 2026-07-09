import { z } from "zod"
import { RUNTIME_AUTHORIZATION_CAPABILITIES } from "../../constants/enums.js"
import { FilesystemPolicySchema } from "./filesystem.js"
import { CUAPolicySchema } from "./cua.js"
import { BrowserPolicySchema } from "./browser.js"
import { CommandlinePolicySchema } from "./commandline.js"
import { PtyPolicySchema } from "./pty.js"

// GrantPolicy mirrors the wire shape of a single grant spec. The shared
// matcher in `./matchers.ts` (used by both API + device runtime) is the
// canonical implementation; every per-capability sub-policy is optional
// so the matcher functions can route on `capability` plus the populated
// branch.
export const GrantPolicySchema = z.object({
  capability: z.enum(RUNTIME_AUTHORIZATION_CAPABILITIES),
  filesystem: FilesystemPolicySchema.optional(),
  cua: CUAPolicySchema.optional(),
  browser: BrowserPolicySchema.optional(),
  commandline: CommandlinePolicySchema.optional(),
  pty: PtyPolicySchema.optional(),
})

export type GrantPolicy = z.infer<typeof GrantPolicySchema>

// subject-scope-refactor: branch-specific validator. Used by the runtime
// authorizations matcher (three-state) to distinguish:
//   - parse_error: top-level GrantPolicySchema parse failed
//   - missing_branch_payload: capability is set but the corresponding
//     sub-policy is absent (e.g. {capability:"filesystem"} without
//     `filesystem`). Without this branch-specific gate the matcher would
//     silently treat such rows as "no match" and fall back to a wider grant.
//   - schema_mismatch: the corresponding branch is present but invalid.
// Mirrored at the wire layer by the superRefine on
// `RuntimeAuthorizationGrantSpecSchema` in @synapse/device-protocol — both
// validators are exercised by the package-neutral JSON fixtures under
// repo-root `__fixtures__/grant-policy/` to guarantee equivalent semantics.
export type PolicyValidationFailure =
  | { kind: "parse_error"; issues: z.ZodIssue[] }
  | { kind: "missing_branch_payload"; capability: string }
  | { kind: "schema_mismatch"; capability: string; issues: z.ZodIssue[] }

export type PolicyValidationResult =
  | { ok: true; parsed: GrantPolicy }
  | { ok: false; failure: PolicyValidationFailure }

// Base schema for step 1: validates only `capability` (the discriminator). Per-
// capability branches are validated separately in step 3 to give precise
// failure attribution (parse_error vs missing_branch_payload vs schema_mismatch).
const GrantPolicyBaseSchema = z.object({
  capability: z.enum(RUNTIME_AUTHORIZATION_CAPABILITIES),
})

const BRANCH_SCHEMAS = {
  filesystem: FilesystemPolicySchema,
  cua: CUAPolicySchema,
  browser: BrowserPolicySchema,
  commandline: CommandlinePolicySchema,
  pty: PtyPolicySchema,
} as const

export function validateGrantPolicyForCapability(
  policy: unknown
): PolicyValidationResult {
  // Step 1: top-level base parse (discriminator only). Fails if `policy` is not
  // an object, capability is missing, or capability is outside the enum.
  const baseParse = GrantPolicyBaseSchema.safeParse(policy)
  if (!baseParse.success) {
    return {
      ok: false,
      failure: { kind: "parse_error", issues: baseParse.error.issues },
    }
  }
  const cap = baseParse.data.capability as keyof typeof BRANCH_SCHEMAS
  const obj = policy as Record<string, unknown>
  // Step 2: required branch existence check.
  if (obj[cap] === undefined || obj[cap] === null) {
    return {
      ok: false,
      failure: { kind: "missing_branch_payload", capability: cap },
    }
  }
  // Step 3: branch-specific schema parse.
  const branchSchema = BRANCH_SCHEMAS[cap]
  const branchParse = branchSchema.safeParse(obj[cap])
  if (!branchParse.success) {
    return {
      ok: false,
      failure: {
        kind: "schema_mismatch",
        capability: cap,
        issues: branchParse.error.issues,
      },
    }
  }
  // Step 4: full GrantPolicySchema parse (validates other optional branches
  // shapes too — e.g. if a row redundantly carries `filesystem` AND
  // `commandline`, the irrelevant one's shape is still checked). This also
  // gives us the canonical typed `GrantPolicy` to return on success.
  const fullParse = GrantPolicySchema.safeParse(policy)
  if (!fullParse.success) {
    return {
      ok: false,
      failure: {
        kind: "schema_mismatch",
        capability: cap,
        issues: fullParse.error.issues,
      },
    }
  }
  return { ok: true, parsed: fullParse.data }
}
