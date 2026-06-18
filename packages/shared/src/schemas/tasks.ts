import { z } from "zod"
import {
  CONVERSATION_PARTICIPANT_TYPES,
  PLAN_CHECKLIST_STEP_STATUSES,
  RUNTIME_AUTHORIZATION_GRANT_RETENTIONS,
  RUNTIME_AUTHORIZATION_GRANT_STATUSES,
  RUNTIME_AUTHORIZATION_PRESETS,
  RUNTIME_AUTHORIZATION_REQUEST_MODES,
  TASK_NOTICE_STATUSES,
  TASK_INPUT_QUESTION_TYPES,
  TASK_LIFECYCLE_STATUSES,
  TASK_OUTCOMES,
  TASK_REQUEST_KIND,
  TRANSPORT_KINDS,
} from "../constants/enums.js"
import { SUBJECT_KIND } from "../access/enums.js"
import {
  BrowserPolicySchema,
  CommandlinePolicySchema,
  CUAPolicySchema,
  FilesystemPolicySchema,
  GrantPolicySchema,
} from "../access/policies/index.js"
import { CanonicalContentBlockSchema } from "./chat-content-block.js"
import { IsoInstantStringSchema } from "./datetime.js"
import type {
  RuntimeAuthorizationGrantOption,
  RuntimeAuthorizationPreset,
  RuntimeAuthorizationRequestedAction,
} from "../types/index.js"

// Canonical wire-instant schema (single source of truth — C1): validates + brands.
const timestampSchema = IsoInstantStringSchema

const ConversationEntityRefSchema = z.object({
  participantId: z.string().optional(),
  participantType: z.enum(CONVERSATION_PARTICIPANT_TYPES),
  workspaceMemberId: z.string().optional(),
  actorId: z.string().optional(),
  remoteAgentId: z.string().optional(),
  externalUserKey: z.string().optional(),
  transportAddressId: z.string().optional(),
  transportKind: z.enum(TRANSPORT_KINDS).optional(),
  name: z.string().optional(),
  title: z.string().optional(),
  role: z.string().optional(),
  avatarUrl: z.string().optional(),
  avatarEmoji: z.string().optional(),
})

export const SubjectRefSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal(SUBJECT_KIND.WORKSPACE),
    workspaceId: z.string(),
  }),
  z.object({
    kind: z.literal(SUBJECT_KIND.WORKSPACE_MEMBER),
    memberId: z.string(),
  }),
  z.object({
    kind: z.literal(SUBJECT_KIND.ACTOR),
    actorId: z.string(),
  }),
  z.object({
    kind: z.literal(SUBJECT_KIND.REMOTE_AGENT),
    remoteAgentId: z.string(),
  }),
  z.object({
    kind: z.literal(SUBJECT_KIND.CONVERSATION),
    conversationId: z.string(),
  }),
  z.object({
    kind: z.literal(SUBJECT_KIND.USER),
    userId: z.string(),
  }),
  z.object({
    kind: z.literal(SUBJECT_KIND.EXTERNAL),
    workspaceId: z.string(),
    transportAddressId: z.string(),
  }),
  z.object({
    kind: z.literal(SUBJECT_KIND.PLATFORM),
  }),
])

const TaskInputOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
  preview: z.string().optional(),
})

const TaskInputAnswerSchema = z.object({
  questionId: z.string(),
  selectedOptionIds: z.array(z.string()).optional(),
  selectedOptionLabels: z.array(z.string()).optional(),
  otherText: z.string().optional(),
  text: z.string().optional(),
})

const TaskInputQuestionSummarySchema = z.object({
  id: z.string(),
  header: z.string(),
  type: z.enum(TASK_INPUT_QUESTION_TYPES),
  prompt: z.string(),
  description: z.string().optional(),
  required: z.boolean(),
  options: z.array(TaskInputOptionSchema).optional(),
  allowOther: z.boolean().optional(),
  placeholder: z.string().optional(),
  minSelections: z.number().int().nonnegative().optional(),
  maxSelections: z.number().int().positive().optional(),
  secret: z.boolean().optional(),
  answer: TaskInputAnswerSchema.optional(),
})

const UserInputTaskDetailsSchema = z.object({
  title: z.string(),
  instructions: z.string().optional(),
  questions: z.array(TaskInputQuestionSummarySchema),
})

const PlanChecklistStepSchema = z.object({
  step: z.string(),
  status: z.enum(PLAN_CHECKLIST_STEP_STATUSES),
})

const PlanApprovalTaskDetailsSchema = z.object({
  title: z.string(),
  summary: z.string().optional(),
  planMarkdown: z.string(),
  checklist: z.array(PlanChecklistStepSchema).optional(),
})

const SubjectScopedGrantPolicySchema = GrantPolicySchema.extend({
  subject: SubjectRefSchema,
  scope: SubjectRefSchema.optional(),
  scopeLabel: z.string(),
  retention: z.enum(RUNTIME_AUTHORIZATION_GRANT_RETENTIONS),
  status: z.enum(RUNTIME_AUTHORIZATION_GRANT_STATUSES),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  consumedAt: timestampSchema.optional(),
  revokedAt: timestampSchema.optional(),
})

const RuntimeAuthorizationGrantOptionSchema = z.object({
  id: z.string(),
  summary: z.string(),
  detail: z.string().optional(),
  grantSpec: GrantPolicySchema,
})

const RuntimeAuthorizationBrowserScopeSources = [
  "args",
  "runtime_active_page",
  "runtime_page_id",
  "runtime_all_pages",
  "unknown_tool",
] as const

const RuntimeAuthorizationRequestedActionSchema = z.object({
  capability: GrantPolicySchema.shape.capability,
  toolName: z.string(),
  summary: z.string(),
  detail: z.string().optional(),
  filesystem: FilesystemPolicySchema.extend({
    scopeIsPushdown: z.boolean().optional(),
  }).optional(),
  cua: CUAPolicySchema.optional(),
  browser: BrowserPolicySchema.extend({
    scopeSource: z.enum(RuntimeAuthorizationBrowserScopeSources).optional(),
  }).optional(),
  commandline: CommandlinePolicySchema.optional(),
})

export function parseRuntimeAuthorizationRequestedAction(
  value: unknown
): RuntimeAuthorizationRequestedAction {
  return RuntimeAuthorizationRequestedActionSchema.parse(
    value
  ) as RuntimeAuthorizationRequestedAction
}

export function parseRuntimeAuthorizationGrantOptions(
  value: unknown
): RuntimeAuthorizationGrantOption[] {
  return z
    .array(RuntimeAuthorizationGrantOptionSchema)
    .parse(value) as RuntimeAuthorizationGrantOption[]
}

export function parseRuntimeAuthorizationPresets(
  value: unknown
): RuntimeAuthorizationPreset[] {
  return z
    .array(z.enum(RUNTIME_AUTHORIZATION_PRESETS))
    .parse(value) as RuntimeAuthorizationPreset[]
}

const RuntimeAuthorizationTaskDetailsSchema = z.object({
  requestedToolName: z.string(),
  deviceToolStableKey: z.string(),
  requestedAction: RuntimeAuthorizationRequestedActionSchema,
  reason: z.string(),
  deviceId: z.string(),
  deviceDisplayName: z.string(),
  deviceCapabilityId: z.string(),
  exposureId: z.string(),
  exposureDisplayName: z.string(),
  grantOptions: z.array(RuntimeAuthorizationGrantOptionSchema),
  availablePresets: z.array(z.enum(RUNTIME_AUTHORIZATION_PRESETS)),
  approvedPreset: z.enum(RUNTIME_AUTHORIZATION_PRESETS).optional(),
  approvedGrant: SubjectScopedGrantPolicySchema.optional(),
  requestMode: z.enum(RUNTIME_AUTHORIZATION_REQUEST_MODES),
  sourceRetryNonce: z.string().optional(),
})

export const TaskNoticeSummarySchema = z.object({
  taskId: z.string(),
  toolName: z.string(),
  status: z.enum(TASK_NOTICE_STATUSES),
  summary: z.string(),
  message: z.string().optional(),
  messageBlocks: z.array(CanonicalContentBlockSchema).optional(),
})
export type TaskNoticeSummarySchemaType = z.infer<
  typeof TaskNoticeSummarySchema
>

const TaskSummaryBaseSchema = z.object({
  id: z.string(),
  remoteAgentRunId: z.string().optional(),
  workspaceId: z.string(),
  conversationId: z.string(),
  itemId: z.string().optional(),
  lifecycleStatus: z.enum(TASK_LIFECYCLE_STATUSES),
  outcome: z.enum(TASK_OUTCOMES).optional(),
  revision: z.number().int().nonnegative(),
  requester: ConversationEntityRefSchema.optional(),
  resolvedBy: ConversationEntityRefSchema.optional(),
  resolutionNote: z.string().optional(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  resolvedAt: timestampSchema.optional(),
  expiresAt: timestampSchema.optional(),
  viewerCanResolve: z.boolean(),
})

export const TaskSummarySchema = z.discriminatedUnion("kind", [
  TaskSummaryBaseSchema.extend({
    kind: z.literal(TASK_REQUEST_KIND.USER_INPUT),
    target: ConversationEntityRefSchema.optional(),
    userInput: UserInputTaskDetailsSchema,
  }),
  TaskSummaryBaseSchema.extend({
    kind: z.literal(TASK_REQUEST_KIND.PLAN_APPROVAL),
    target: ConversationEntityRefSchema.optional(),
    planApproval: PlanApprovalTaskDetailsSchema,
  }),
  TaskSummaryBaseSchema.extend({
    kind: z.literal(TASK_REQUEST_KIND.RUNTIME_AUTHORIZATION),
    runtimeAuthorization: RuntimeAuthorizationTaskDetailsSchema,
  }),
])

export type TaskSummarySchemaType = z.infer<typeof TaskSummarySchema>
