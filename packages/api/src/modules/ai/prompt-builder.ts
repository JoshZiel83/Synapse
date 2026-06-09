import {
  AvailableSkillSummary,
  extractText,
  formatMentionText,
  normalizeActorDocs,
  resolveThreadSemantics,
} from "@synapse/shared"
import type { ActorDoc, ToolDefinition } from "@synapse/shared"
import type { SessionCollaborationMode } from "@synapse/shared/types"
import {
  isGroupConversationKind,
  isPlanAwaitingApprovalCollaborationMode,
  isPlanCollaborationMode,
  isPlanDraftingCollaborationMode,
} from "@synapse/shared/utils"
import { sortAvailableSkillsForDiscovery } from "../skills/discovery-order.js"
import { buildReplyToRefUsageGuidance } from "./session-tool-guidance.js"

export interface ConversationParticipantInfo {
  id?: string
  participant_type?: string
  actor_id?: string
  user_id?: string
  participant_name?: string
  participant_title?: string
  participant_role?: string
  user_name?: string
  display_name?: string
  transport_display_name?: string
  transport_external_id?: string
  linked_user_name?: string
  user_id_ref?: string
  session_status?: string
  actor_docs?: ActorDoc[]
  actor_can_represent_user?: boolean
  actor_current_version?: number
}

function parseJsonArray<T>(value: unknown): T[] {
  if (!value) return []
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T[]
    } catch {
      return []
    }
  }
  return Array.isArray(value) ? (value as T[]) : []
}

function actorSource(actor: any) {
  return actor.definition ?? actor.snapshot ?? actor
}

function parseActorDocs(actor: any): ActorDoc[] {
  const source = actorSource(actor)
  return normalizeActorDocs(
    parseJsonArray<ActorDoc>(source.docs ?? actor.actor_docs)
  )
}

function isDocVisible(
  doc: ActorDoc,
  mode: "direct_conversation" | "multi_member_conversation",
  includeInternal: boolean
): boolean {
  if (doc.visibility === "always") return true
  if (doc.visibility === "internal_only") return includeInternal
  if (mode === "multi_member_conversation") {
    return doc.visibility === "multi_member_only"
  }
  return doc.visibility === "direct_only"
}

function blocksToPromptText(blocks: ActorDoc["content"]): string {
  return blocks
    .map((block: ActorDoc["content"][number]) => {
      if (block.type === "text") return block.text
      if (block.type === "mention") return formatMentionText(block)
      return `[File reference: ${block.name} (${block.category}) at ${block.path ?? `sha256:${block.sha256}`}]`
    })
    .join("\n")
    .trim()
}

function summarizeDoc(doc: ActorDoc, maxLength = 160): string {
  const text = extractText(doc.content).replace(/\s+/g, " ").trim()
  if (text) {
    return text.length > maxLength ? `${text.slice(0, maxLength - 1)}...` : text
  }

  const file = doc.content.find(
    (
      block: ActorDoc["content"][number]
    ): block is Extract<ActorDoc["content"][number], { type: "file_ref" }> =>
      block.type === "file_ref"
  )
  return file ? `Attached file: ${file.name}` : ""
}

function renderDocSections(
  actor: any,
  mode: "direct_conversation" | "multi_member_conversation"
): string {
  const visibleDocs = parseActorDocs(actor)
    .filter((doc) => isDocVisible(doc, mode, true))
    .sort((left, right) => right.priority - left.priority)

  if (visibleDocs.length === 0) return ""

  return visibleDocs
    .map((doc) => {
      const content = blocksToPromptText(doc.content)
      if (!content) return ""
      return `## ${doc.title}\n${content}`
    })
    .filter(Boolean)
    .join("\n\n")
}

function buildRosterEntry(member: ConversationParticipantInfo): string {
  const title = member.participant_title || member.participant_role || "Actor"
  const displayName =
    member.participant_name || member.display_name || "Unknown actor"
  const docs = parseActorDocs(member)
    .filter((doc) => isDocVisible(doc, "multi_member_conversation", false))
    .sort((left, right) => right.priority - left.priority)

  const summary = docs.map((doc) => summarizeDoc(doc, 120)).find(Boolean) || ""

  const version = member.actor_current_version
    ? ` v${member.actor_current_version}`
    : ""
  const participantIdNote = member.id ? ` [participantId=${member.id}]` : ""
  return `- [actor] **${displayName}**${version} — ${title}${participantIdNote}${summary ? ` — ${summary}` : ""}`
}

function buildToolRoutingGuidance(tools: ToolDefinition[] | undefined): string {
  // Device-runtime v3.0: the legacy tool-routing guidance that hand-rolled
  // advice for `View` / `bash` / `desktop_capture_display` /
  // `take_snapshot` (the old Relay builtin surface — `request_authorization`,
  // `execution_mode`, etc.) has been removed. Those tool names + arg
  // shapes are being redefined as part of the device-runtime cutover and
  // the previous prompts would push the model to emit calls that don't
  // exist on the new surface. A future PR (#N3 — Tool Surface Spec) will
  // ship device-generic prompts once the v3 tool catalog is finalized.
  void tools
  return ""
}

function hasHumanConversationParticipant(
  participants: ConversationParticipantInfo[] | undefined
): boolean {
  if (!participants || participants.length === 0) return false
  return participants.some(
    (participant) =>
      Boolean(participant.user_id) ||
      participant.participant_type === "external" ||
      Boolean(participant.transport_external_id)
  )
}

export function buildRequestUserInputGuidance(
  isPrivateConversation: boolean
): string {
  const targetingRule = isPrivateConversation
    ? "- In a direct conversation with one user, the recipient is implicit."
    : "- In a group conversation, use the exact `targetParticipantId` for the intended recipient."

  return (
    `# Requesting User Input\n` +
    `Use \`request_user_input\` only when the answer cannot be discovered from local context and the response will materially change the work.\n` +
    `- Explore the repo and current state first. Do not ask the user for facts you can inspect yourself.\n` +
    `- Ask short, specific questions about requirements, preferences, or tradeoffs. Prefer one question and do not exceed four.\n` +
    `- For choice questions, offer only meaningful options, put any recommended option first, and use \`allowOther\` instead of inventing an \`Other\` option.\n` +
    `- Do not use \`request_user_input\` for status checks, courtesy confirmations, or plan approval.\n` +
    `${targetingRule}`
  )
}

export function buildPlanModeGuidance(
  collaborationMode: Extract<
    SessionCollaborationMode,
    "plan_drafting" | "plan_awaiting_approval"
  >
): string {
  if (isPlanAwaitingApprovalCollaborationMode(collaborationMode)) {
    return (
      `# Collaboration Mode\n` +
      `Current collaboration mode: \`plan_awaiting_approval\`.\n` +
      `A plan approval request is already pending. Do not keep drafting, do not ask for approval again, and do not continue implementation.\n` +
      `Do not use normal assistant text or \`request_user_input\` to ask whether the plan is okay. Wait for the approval result to move the session back to drafting or default mode.`
    )
  }

  return (
    `# Collaboration Mode\n` +
    `Current collaboration mode: \`plan_drafting\`.\n` +
    `You are planning, not executing. User requests to "go ahead" do not cancel this mode.\n` +
    `Start with targeted read-only exploration to understand the existing system, then use \`request_user_input\` only for requirements, preferences, or tradeoffs you cannot resolve from the repo alone.\n` +
    `Use \`update_plan\` only to maintain the checklist for this plan. It is not approval and it does not ask the user whether to proceed.\n` +
    `Use \`exit_plan_mode\` only when the implementation plan is complete enough for approval: it should cover what will change, which existing code or patterns to reuse, and how the work will be verified.\n` +
    `Do not request plan approval through normal assistant text or \`request_user_input\`. If you are effectively asking "is this plan okay?" or "should I proceed?", call \`exit_plan_mode\` instead.`
  )
}

/**
 * Build the system prompt for an actor in a conversation.
 * Structure:
 *   1. Actor identity & profile documents
 *   2. Memory usage rules
 *   3. Conversation participant roster with type + database UUID
 *   4. send_to tool description & collaboration rules
 *   5. MCP plugin tools (if any)
 */
export function buildActorPrompt(
  actor: any,
  _subordinates?: any,
  _sessionContext?: any,
  extraTools?: ToolDefinition[],
  conversationParticipants?: ConversationParticipantInfo[],
  conversationKind?: "direct" | "group",
  availableSkills?: AvailableSkillSummary[],
  collaborationMode: SessionCollaborationMode = "default"
): { system: string } {
  const parts: string[] = []
  const threadSemantics = resolveThreadSemantics({
    kind: conversationKind,
    otherParticipantCount: conversationParticipants?.length || 0,
  })
  const mode: "direct_conversation" | "multi_member_conversation" =
    threadSemantics.isGroupConversation
      ? "multi_member_conversation"
      : "direct_conversation"
  const source = actorSource(actor)
  const actorName =
    source.displayName || source.name || actor.displayName || "Actor"
  const actorTitle =
    source.title || source.role || actor.title || actor.role || "Actor"
  const actorVersion = actor.current_version ?? actor.currentVersion ?? 1
  const canRepresentUser = Boolean(
    source.canRepresentUser ??
    actor.can_represent_user ??
    actor.canRepresentUser
  )

  parts.push(
    `# Your Identity\n` +
      `You are **${actorName}** (${actorTitle}).\n` +
      `Current actor version: v${actorVersion}.\n` +
      `${
        canRepresentUser
          ? "You may represent the user only when the permission system allows it, and you must still follow your representation guidelines."
          : "You are not automatically allowed to speak on behalf of the user. If representation would matter, ask or defer."
      }\n\n` +
      renderDocSections(actor, mode)
  )

  const specialties = Array.isArray(source.specialties)
    ? source.specialties
    : parseJsonArray<string>(source.specialties ?? actor.specialties)
  if (specialties.length > 0) {
    parts.push(
      `## Your Structured Specialties\n` +
        specialties.map((specialty: string) => `- \`${specialty}\``).join("\n")
    )
  }

  parts.push(
    `# Memory Usage\n` +
      `The system may automatically recall established memories for you as structured context.\n` +
      `Use these rules:\n` +
      `- Treat recalled memories as durable facts, preferences, decisions, procedures, relationships, or artifacts.\n` +
      `- If the current task depends on history, decisions, user preferences, or durable facts, consult recalled memories first.\n` +
      `- If recalled memories are insufficient, use \`memory_search\` to search deeper.\n` +
      `- Use \`create_memory\` only for stable and established information that should persist beyond the current turn.\n` +
      `- If the user explicitly asks you to remember something, save it immediately once the statement is complete and unambiguous. If the request is incomplete or ambiguous, ask a short clarification question first.\n` +
      `- Good memory candidates include durable user profile facts, stable preferences, validated working conventions, durable decisions, reusable procedures, persistent relationships, and external reference pointers.\n` +
      `- Do not save ephemeral task state, current-turn logistics, temporary plans, repo facts that can be derived from files or git, or secrets such as passwords, tokens, or private credentials.\n` +
      `- Write memory as a reusable standalone statement rather than a raw chat quote. Replace pronouns with explicit names or roles, include concrete entities, and convert relative dates to absolute dates when time matters.\n` +
      `- For preference, decision, procedure, or summary memories, include the rationale and how it should be applied when that context is available.\n` +
      `- Avoid duplicate saves. Only create a new memory when the information is genuinely new, materially clearer, or worth preserving independently.\n` +
      `- Actor-created memories support three visibility modes: \`participant_private\` (private to you in this conversation), \`conversation_shared\` (shared in this conversation), and \`actor_private\` (follows you across conversations).\n` +
      `- Prefer \`actor_private\` for stable cross-conversation facts about the user or your long-lived working relationship, \`conversation_shared\` for facts all participants in this conversation should share, and \`participant_private\` for narrow context that only you need inside this conversation.\n` +
      `- Keep \`importance\` near the default unless the memory is likely to shape future behavior repeatedly. Use high \`confidence\` only when the fact was stated explicitly, directly observed, or otherwise well established.\n` +
      `- When useful, provide a short \`textDigest\` that makes retrieval easy. Prefer explicit subject-plus-predicate wording over pronouns.\n` +
      `- In a direct one-to-one conversation with a workspace user, recalled memory and \`memory_search\` may also include that user's personal workspace memory.\n` +
      `- If you store a file-backed memory, include the exact FileRef string such as <FileRef id="..."/> in the memory content, and include a concise textual summary or \`textDigest\` so it can be retrieved later.\n` +
      `- If memory appears uncertain or conflicts with current evidence, say so explicitly instead of guessing.`
  )

  if (availableSkills && availableSkills.length > 0) {
    const orderedSkills = sortAvailableSkillsForDiscovery(availableSkills)
    parts.push(
      `# Available Skills\n` +
        `These skills are available on demand. Do not assume their detailed contents are already loaded.\n` +
        `If one skill clearly matches the task, call \`read_skill\` to read its description or a referenced attachment before using it.\n` +
        orderedSkills
          .map(
            (skill) =>
              `- \`${skill.name}\` (\`${skill.instanceId}\`): ${skill.description}`
          )
          .join("\n")
    )
  }

  if (hasHumanConversationParticipant(conversationParticipants)) {
    parts.push(
      buildRequestUserInputGuidance(threadSemantics.isDirectConversation)
    )
  }

  if (
    isGroupConversationKind(conversationKind) &&
    isPlanCollaborationMode(collaborationMode)
  ) {
    throw new Error("Plan mode is only available in direct conversations.")
  }

  if (
    isPlanDraftingCollaborationMode(collaborationMode) ||
    isPlanAwaitingApprovalCollaborationMode(collaborationMode)
  ) {
    parts.push(
      buildPlanModeGuidance(
        collaborationMode as Extract<
          SessionCollaborationMode,
          "plan_drafting" | "plan_awaiting_approval"
        >
      )
    )
  }

  const toolRoutingGuidance = buildToolRoutingGuidance(extraTools)
  if (toolRoutingGuidance) {
    parts.push(toolRoutingGuidance)
  }

  if (conversationParticipants && conversationParticipants.length > 0) {
    const isDirectThread = threadSemantics.isDirectConversation
    const exampleRecipient =
      conversationParticipants.find((member) => member.user_id)?.user_name ||
      conversationParticipants.find(
        (member) =>
          member.participant_type === "external" || member.transport_external_id
      )?.transport_display_name ||
      conversationParticipants.find(
        (member) =>
          member.participant_type === "external" || member.transport_external_id
      )?.display_name ||
      "User"
    const roster = [
      "# Conversation Participants",
      "",
      isDirectThread
        ? "You are in a direct thread with the following other participants:"
        : "You are in a group thread with the following other participants:",
      "The XML `<conversation_manifest>` is the authoritative roster. Use `participantId` from that manifest for `<mention .../>`.",
      "",
      ...conversationParticipants.flatMap((member) => {
        if (member.user_id) {
          const participantIdNote = member.id
            ? ` [participantId=${member.id}]`
            : ""
          return [
            `- [workspace_member] **${member.user_name || "User"}** — workspace member${participantIdNote}`,
          ]
        }
        if (member.actor_id && member.actor_id !== actor.id) {
          return [buildRosterEntry(member)]
        }
        if (
          member.participant_type === "external" ||
          member.transport_external_id
        ) {
          const externalName =
            member.transport_display_name ||
            member.display_name ||
            member.linked_user_name ||
            "External participant"
          const mapping = member.linked_user_name
            ? `; linked workspace user: ${member.linked_user_name}`
            : ""
          const participantIdNote = member.id
            ? ` [participantId=${member.id}]`
            : ""
          return [
            `- [external] **${externalName}** — external participant${participantIdNote}${mapping}`,
          ]
        }
        return []
      }),
    ].join("\n")

    parts.push(roster)

    const communicationOverview = isDirectThread
      ? `All visible communication uses the \`send_to\` tool. Conversation messages are shared with the other current participant. This is a direct thread, so the peer is implicit and you do not provide recipient parameters.`
      : `All visible communication uses the \`send_to\` tool. Conversation messages are shared with the whole conversation. In group threads, mentioning someone inside the message body does not make the message private; it only creates an explicit inline participant reference.`
    const sendToGuide = isDirectThread
      ? `Send a visible message to the other current participant.\n` +
        `Parameters:\n` +
        `- \`intent\`: \`reply\` when you are replying with information or a result; \`request\` when you are delegating, asking, or requesting action\n` +
        `- \`summary\`: a short structured summary of what you replied with or what you want the other participant to do; this is used for UI rendering\n` +
        `- ${buildReplyToRefUsageGuidance("direct")}\n` +
        `- \`message\`: your visible message content\n` +
        `- The recipient is implicit. In this direct thread, \`send_to\` goes directly to ${exampleRecipient} or whoever is currently the other participant.\n` +
        `- Prefer \`<mention participantId="..."/>\`. You may also use \`<mention name="${exampleRecipient}"/>\` when the roster name is unique.\n` +
        `- Use inline mention only when the sentence itself explicitly points to that person. Do not mechanically mention the other participant at the start of every message.`
      : `Send a visible group message.\n` +
        `Parameters:\n` +
        `- \`intent\`: \`reply\` when you are replying with information or a result; \`request\` when you are delegating, asking, or requesting action\n` +
        `- \`summary\`: a short structured summary of what you replied with or what you want someone to do; this is used for UI rendering\n` +
        `- ${buildReplyToRefUsageGuidance("group")}\n` +
        `- \`message\`: your visible message content\n` +
        `- The message remains visible to the whole conversation. There is no recipient or target parameter for ordinary messages.\n` +
        `- Prefer \`<mention participantId="..."/>\`. You may also use \`<mention name="${exampleRecipient}"/>\` when the roster name is unique.\n` +
        `- Use inline mention only when the sentence explicitly points to someone: ownership, responsibility, follow-up, or who should handle a task.\n` +
        `- Mention inside the body does not make the message private and does not replace \`replyToRef\`.`
    const sleepGuidance = isDirectThread
      ? `- In a direct thread, you must use \`send_to\` before \`sleep\`.\n`
      : `- In a group thread, you may sleep without \`send_to\` only when the wakeup is truly unrelated to you and the intended assignee already received the message, so your own visible reply would add no value.\n`
    const mentionGuidance = isDirectThread
      ? `- In a direct thread, \`send_to\` already goes to the other participant. Use \`<mention .../>\` only when the sentence itself needs an inline participant reference.\n`
      : `- In a group thread, an unmentioned \`send_to\` message is a general group message.\n` +
        `- Use \`<mention .../>\` only when the sentence explicitly points to a participant. Mention does not create a private audience.\n`
    const otherToolLines = [
      `- \`get_current_time\`: Get the current wall-clock time when timing matters or you need to reference "now"`,
      ...(threadSemantics.isGroupConversation
        ? [
            `- \`invite_actor\` (when available): Invite one or more currently listed candidate actors into this conversation when the current roster lacks a needed skill`,
          ]
        : []),
      `- \`sleep\`: When you have finished your work, call sleep. You will be automatically woken when someone sends you a message`,
      `- \`memory_search\`: Search durable memories when recalled context is insufficient`,
      `- \`create_memory\`: Save a durable established fact for future reference`,
      ...(availableSkills && availableSkills.length > 0
        ? [
            "- `read_skill`: Load an available skill package on demand when a listed skill clearly applies",
          ]
        : []),
    ].join("\n")
    const workflowStepFour = isDirectThread
      ? `4. This is a direct conversation with a fixed participant set. Do not suggest inviting participants, pulling people into a group, or treating it like a group chat`
      : `4. If you need help from another actor and \`invite_actor\` is available, use \`send_to\` for current participants or \`invite_actor\` for listed non-participants`

    parts.push(
      `# Message Context\n\n` +
        `Visible conversation context is provided as XML-wrapped messages.\n` +
        `- Every visible message has an \`itemId\` and usually a short \`ref\` such as \`m_1775264233848001\`.\n` +
        `- Use \`participantId\` values from \`<conversation_manifest>\` for inline mentions. You do not need raw actorId, userId, or workspaceMemberId.\n` +
        `- Use \`replyToRef\` only when the reply target needs to be anchored explicitly; do not add it mechanically just because refs are available.\n` +
        `- Inside message bodies, prefer \`<mention participantId="..."/>\`. You may use \`<mention name="..."/>\` only when the roster name is unique.\n` +
        `- Message bodies may include real file or image blocks. Do not assume every attachment was flattened to text.\n\n` +
        `# Communication\n\n` +
        `${communicationOverview}\n\n` +
        `## send_to\n` +
        `${sendToGuide}\n\n` +
        `## Other tools\n` +
        `${otherToolLines}\n\n` +
        `## Workflow\n` +
        `1. Read the current shared conversation context and identify whether someone is asking you to act\n` +
        `2. Do the work using your tools and profile\n` +
        `3. Use \`send_to\` to reply to whoever sent you the message (user or actor), and set \`intent\` plus \`summary\` correctly\n` +
        `${workflowStepFour}\n` +
        `5. When done, call \`sleep\` so you can be woken only when needed\n\n` +
        `## Important\n` +
        `- **You MUST use \`send_to\` to reply.** Plain text output is internal reasoning only.\n` +
        `- Your internal tool calls (MCP tools, memory_search, create_memory, and so on) are not visible to other conversation participants.\n` +
        `- Only \`send_to\` produces visible messages.\n` +
        `- Do not call \`sleep\` until you have decided whether the conversation needs a visible message from you.\n` +
        `- If this wakeup leads to a result, handoff, clarification, or explicit "no action needed" decision that others should know, use \`send_to\` first and only then call \`sleep\`.\n` +
        `${sleepGuidance}` +
        `- All visible conversation messages are shared with the whole conversation.\n` +
        `${isDirectThread ? "- This is a direct conversation, not a group chat. Do not suggest adding participants, removing participants, or renaming it like a group.\n" : ""}` +
        `${mentionGuidance}` +
        `- If a public message is not addressed to you, treat it as shared context unless you are explicitly asked to respond or need to step in to unblock the work.\n` +
        `- Use message \`ref\` values from the XML context when you need to reply to a specific earlier message.\n` +
        `- Body mentions are inline participant references for sentence clarity. They are not a target filter and they do not replace \`replyToRef\`.\n` +
        `- Never rely on outdated roster assumptions. The system may insert profile-version events when another actor changes.`
    )
  } else {
    parts.push(
      `# Working Mode\n\n` +
        `You are working in a conversation with no additional participant roster.\n` +
        `Handle the task directly. Do not defer obvious work.\n` +
        `Use recalled memory when the task depends on durable facts or prior decisions, and use \`memory_search\` if you need deeper retrieval.\n` +
        `Use \`get_current_time\` when the task depends on the current time or date.\n` +
        `${availableSkills && availableSkills.length > 0 ? "When a listed available skill clearly matches the task, load it with `read_skill` before using it.\n" : ""}` +
        `If you need to emit a visible conversation reply, use \`send_to\` with an optional \`replyToRef\` from the XML context.\n` +
        `Prefer \`<mention participantId="..."/>\` for inline participant references. You may use \`<mention name="..."/>\` only when the name is unique.\n` +
        `Mention is an inline body reference for better UI presentation, not a generic addressee marker and not the same as sending the message to that person. Otherwise write normal text.`
    )
  }

  if (extraTools && extraTools.length > 0) {
    parts.push(
      `# Available Plugin Tools\n\n` +
        `You have the following MCP plugin tools:\n` +
        extraTools
          .map((tool) => `- \`${tool.name}\`: ${tool.description}`)
          .join("\n") +
        `\n\nUse these tools when the user's request requires them. Call each tool by exactly the name shown above.`
    )
  }

  return { system: parts.join("\n\n") }
}
