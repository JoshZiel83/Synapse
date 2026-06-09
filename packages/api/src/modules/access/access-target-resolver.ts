/**
 * D3: Async resolver — takes an application-layer AccessTarget (now always
 * `ScopedSubjectTarget`) and validates / passes it through to the storage
 * layer. Scope eligibility is validated at this boundary so misuse fails
 * fast.
 */

import type { AccessTarget } from "@synapse/shared/types"
import { isScopeEligibleSubject } from "@synapse/shared"
import type { AutomationEventSourceBindingTarget } from "./bindings.js"

export async function resolveAccessGrantTarget(input: {
  workspaceId: string
  target: AccessTarget
}): Promise<AutomationEventSourceBindingTarget> {
  if (input.target.scope && !isScopeEligibleSubject(input.target.scope)) {
    throw new Error(
      `scope_subject_id must be workspace | conversation, got ${input.target.scope.kind}`
    )
  }
  return input.target
}
