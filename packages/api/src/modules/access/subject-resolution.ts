export {
  isActorActiveConversationParticipant,
  isRemoteAgentActiveConversationParticipant,
  isSubjectActiveConversationParticipant,
  buildRuntimePrincipalContext,
  buildRuntimePrincipalContextOn,
  computeRuntimeScopeSubjectIds,
  computeRuntimeSubjectIdsForVisibility,
  buildConversationCapabilitySubjects,
} from "./repo-subject-resolution.js"

export type { RuntimePrincipalContext } from "./repo-subject-resolution.js"
