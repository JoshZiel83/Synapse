import {
  AvailableSkillSummary,
  extractText,
  formatMentionText,
  normalizeActorDocs,
  resolveThreadSemantics,
} from "@synapse/shared";
import type { ActorDoc, ToolDefinition } from "@synapse/shared";

export interface ConversationParticipantInfo {
  id?: string;
  participant_kind?: string;
  actor_id?: string;
  user_id?: string;
  actor_name?: string;
  actor_title?: string;
  actor_role?: string;
  user_name?: string;
  display_name?: string;
  transport_display_name?: string;
  transport_external_id?: string;
  linked_user_name?: string;
  user_id_ref?: string;
  session_status?: string;
  actor_docs?: ActorDoc[];
  actor_can_represent_user?: boolean;
  actor_current_version?: number;
}

function parseJsonArray<T>(value: unknown): T[] {
  if (!value) return [];
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T[];
    } catch {
      return [];
    }
  }
  return Array.isArray(value) ? (value as T[]) : [];
}

function actorSource(actor: any) {
  return actor.definition ?? actor.snapshot ?? actor;
}

function parseActorDocs(actor: any): ActorDoc[] {
  const source = actorSource(actor);
  return normalizeActorDocs(
    parseJsonArray<ActorDoc>(source.docs ?? actor.actor_docs),
  );
}

function isDocVisible(
  doc: ActorDoc,
  mode: "direct_conversation" | "multi_member_conversation",
  includeInternal: boolean,
): boolean {
  if (doc.visibility === "always") return true;
  if (doc.visibility === "internal_only") return includeInternal;
  if (mode === "multi_member_conversation") {
    return doc.visibility === "multi_member_only";
  }
  return doc.visibility === "direct_only";
}

function blocksToPromptText(blocks: ActorDoc["content"]): string {
  return blocks
    .map((block: ActorDoc["content"][number]) => {
      if (block.type === "text") return block.text;
      if (block.type === "mention") return formatMentionText(block);
      return `[File reference: ${block.originalName} (${block.category}) <FileRef id="${block.fileId}"/>]`;
    })
    .join("\n")
    .trim();
}

function summarizeDoc(doc: ActorDoc, maxLength = 160): string {
  const text = extractText(doc.content).replace(/\s+/g, " ").trim();
  if (text) {
    return text.length > maxLength
      ? `${text.slice(0, maxLength - 1)}...`
      : text;
  }

  const file = doc.content.find(
    (
      block: ActorDoc["content"][number],
    ): block is Extract<ActorDoc["content"][number], { type: "file_ref" }> =>
      block.type === "file_ref",
  );
  return file ? `Attached file: ${file.originalName}` : "";
}

function renderDocSections(
  actor: any,
  mode: "direct_conversation" | "multi_member_conversation",
): string {
  const visibleDocs = parseActorDocs(actor)
    .filter((doc) => isDocVisible(doc, mode, true))
    .sort((left, right) => right.priority - left.priority);

  if (visibleDocs.length === 0) return "";

  return visibleDocs
    .map((doc) => {
      const content = blocksToPromptText(doc.content);
      if (!content) return "";
      return `## ${doc.title}\n${content}`;
    })
    .filter(Boolean)
    .join("\n\n");
}

function buildRosterEntry(member: ConversationParticipantInfo): string {
  const title = member.actor_title || member.actor_role || "Actor";
  const docs = parseActorDocs(member)
    .filter((doc) => isDocVisible(doc, "multi_member_conversation", false))
    .sort((left, right) => right.priority - left.priority);

  const summary = docs.map((doc) => summarizeDoc(doc, 120)).find(Boolean) || "";

  const version = member.actor_current_version
    ? ` v${member.actor_current_version}`
    : "";
  const participantIdNote = member.id ? ` [participantId=${member.id}]` : "";
  return `- [actor] **${member.actor_name}**${version} — ${title}${participantIdNote}${summary ? ` — ${summary}` : ""}`;
}

function toolBaseName(toolName: string): string {
  const parts = toolName.split("__");
  return parts[parts.length - 1] || toolName;
}

function hasToolBaseName(
  tools: ToolDefinition[] | undefined,
  names: string[],
): boolean {
  if (!tools || tools.length === 0) return false;
  const targetNames = new Set(names);
  return tools.some((tool) => targetNames.has(toolBaseName(tool.name)));
}

function buildToolRoutingGuidance(
  tools: ToolDefinition[] | undefined,
): string {
  if (!tools || tools.length === 0) return "";

  const lines: string[] = [];

  if (
    hasToolBaseName(tools, [
      "View",
      "ViewMany",
      "GetFile",
      "GlobTool",
      "GrepTool",
      "SearchFiles",
    ])
  ) {
    lines.push(
      "- When relay filesystem tools are available, prefer `View` or `ViewMany` for inspection, `GetFile` for original bytes, `GlobTool` for filename or path discovery, `GrepTool` for regex content search, and `SearchFiles` for indexed broad discovery. Do not default to shell `cat`, `find`, or `grep`.",
    );
  }

  if (hasToolBaseName(tools, ["bash"])) {
    lines.push(
      "- Reserve relay `bash` for shell commands that dedicated tools cannot handle. The bundled commandline runtime already places git, node, python, ffmpeg, and cli-anything wrappers on PATH.",
    );
    lines.push(
      "- Relay `bash` accepts `execution_mode`. Use `execution_mode: \"async\"` for long-running shell or CLI jobs when you do not need the final output in the current reasoning step. Synapse will create a background task now and wake you later with the result.",
    );
  }

  if (
    hasToolBaseName(tools, [
      "desktop_capture_display",
      "desktop_capture_overview",
      "desktop_click",
      "desktop_drag",
      "desktop_move_pointer",
      "desktop_scroll",
      "desktop_type_text",
    ])
  ) {
    lines.push(
      "- For desktop automation, take a fresh display capture before coordinate-based actions and recapture if the UI or display layout changes. Recompute coordinates from the newest image instead of reusing stale ones.",
    );
  }

  if (
    hasToolBaseName(tools, [
      "list_pages",
      "select_page",
      "take_snapshot",
      "take_screenshot",
      "navigate_page",
      "click",
      "navigate",
      "screenshot",
    ])
  ) {
    lines.push(
      "- For browser automation, identify the target page with `list_pages` and `select_page` when available, prefer `take_snapshot` for structured page inspection, and use screenshots only when pixel-level visual inspection matters.",
    );
  }

  if (lines.length === 0) return "";

  return `# Tool Routing\n` + lines.join("\n");
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
  conversationKind?: "private" | "group" | "virtual",
  availableSkills?: AvailableSkillSummary[],
): { system: string } {
  const parts: string[] = [];
  const threadSemantics = resolveThreadSemantics({
    kind: conversationKind,
    otherParticipantCount: conversationParticipants?.length || 0,
  });
  const mode: "direct_conversation" | "multi_member_conversation" =
    threadSemantics.isGroupConversation
      ? "multi_member_conversation"
      : "direct_conversation";
  const source = actorSource(actor);
  const actorName = source.name || actor.name || "Actor";
  const actorTitle =
    source.title || source.role || actor.title || actor.role || "Actor";
  const actorVersion = actor.current_version ?? actor.currentVersion ?? 1;
  const canRepresentUser = Boolean(
    source.canRepresentUser ??
    actor.can_represent_user ??
    actor.canRepresentUser,
  );

  parts.push(
    `# Your Identity\n` +
      `You are **${actorName}** (${actorTitle}).\n` +
      `Current actor version: v${actorVersion}.\n` +
      `${
        canRepresentUser
          ? "You may represent the user only when the permission system allows it, and you must still follow your representation guidelines."
          : "You are not automatically allowed to speak on behalf of the user. If representation would matter, ask or defer."
      }\n\n` +
      renderDocSections(actor, mode),
  );

  const specialties = Array.isArray(source.specialties)
    ? source.specialties
    : parseJsonArray<string>(source.specialties ?? actor.specialties);
  if (specialties.length > 0) {
    parts.push(
      `## Your Structured Specialties\n` +
        specialties.map((specialty: string) => `- \`${specialty}\``).join("\n"),
    );
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
      `- If memory appears uncertain or conflicts with current evidence, say so explicitly instead of guessing.`,
  );

  if (availableSkills && availableSkills.length > 0) {
    parts.push(
      `# Available Skills\n` +
        `These skills are available on demand. Do not assume their detailed contents are already loaded.\n` +
        `If one skill clearly matches the task, call \`read_skill\` to read its description or a referenced attachment before using it.\n` +
        availableSkills
          .map((skill) => `- \`${skill.slug}\`${skill.sourceKind === "relay_auto_loaded" ? " (relay auto-loaded)" : ""}: ${skill.description}`)
          .join("\n"),
    );
  }

  const toolRoutingGuidance = buildToolRoutingGuidance(extraTools);
  if (toolRoutingGuidance) {
    parts.push(toolRoutingGuidance);
  }

  if (conversationParticipants && conversationParticipants.length > 0) {
    const isPrivateThread = threadSemantics.isPrivateConversation;
    const exampleRecipient =
      conversationParticipants.find((member) => member.user_id)?.user_name ||
      conversationParticipants.find(
        (member) =>
          member.participant_kind === "external" || member.transport_external_id,
      )?.transport_display_name ||
      conversationParticipants.find(
        (member) =>
          member.participant_kind === "external" || member.transport_external_id,
      )?.display_name ||
      "User";
    const roster = [
      "# Conversation Participants",
      "",
      isPrivateThread
        ? "You are in a private thread with the following other participants:"
        : "You are in a group thread with the following other participants:",
      "The XML `<conversation_manifest>` is the authoritative roster. Use `participantId` from that manifest for `<mention .../>`.",
      "",
      ...conversationParticipants.flatMap((member) => {
        if (member.user_id) {
          const participantIdNote = member.id
            ? ` [participantId=${member.id}]`
            : "";
          return [
            `- [workspace_member] **${member.user_name || "User"}** — workspace member${participantIdNote}`,
          ];
        }
        if (member.actor_id && member.actor_id !== actor.id) {
          return [buildRosterEntry(member)];
        }
        if (member.participant_kind === "external" || member.transport_external_id) {
          const externalName =
            member.transport_display_name ||
            member.display_name ||
            member.linked_user_name ||
            "External participant";
          const mapping = member.linked_user_name
            ? `; linked workspace user: ${member.linked_user_name}`
            : "";
          const participantIdNote = member.id
            ? ` [participantId=${member.id}]`
            : "";
          return [
            `- [external] **${externalName}** — external participant${participantIdNote}${mapping}`,
          ];
        }
        return [];
      }),
    ].join("\n");

    parts.push(roster);

    const communicationOverview = isPrivateThread
      ? `All visible communication uses the \`send_to\` tool. Conversation messages are shared with the other current participant. This is a private thread, so the peer is implicit and you do not provide recipient parameters.`
      : `All visible communication uses the \`send_to\` tool. Conversation messages are shared with the whole conversation. In group threads, mentioning someone inside the message body does not make the message private; it only creates an explicit inline participant reference.`;
    const sendToGuide = isPrivateThread
      ? `Send a visible message to the other current participant.\n` +
          `Parameters:\n` +
          `- \`intent\`: \`reply\` when you are replying with information or a result; \`request\` when you are delegating, asking, or requesting action\n` +
          `- \`summary\`: a short structured summary of what you replied with or what you want the other participant to do; this is used for UI rendering\n` +
          `- \`replyToRef\`: optional short message reference such as \`m_1775264233848001\` from the XML context when you are replying to a specific visible message\n` +
          `- \`message\`: your visible message content\n` +
          `- The recipient is implicit. In this private thread, \`send_to\` goes directly to ${exampleRecipient} or whoever is currently the other participant.\n` +
          `- Prefer \`<mention participantId="..."/>\`. You may also use \`<mention name="${exampleRecipient}"/>\` when the roster name is unique.\n` +
          `- Use inline mention only when the sentence itself explicitly points to that person. Do not mechanically mention the other participant at the start of every message.`
      : `Send a visible group message.\n` +
          `Parameters:\n` +
          `- \`intent\`: \`reply\` when you are replying with information or a result; \`request\` when you are delegating, asking, or requesting action\n` +
          `- \`summary\`: a short structured summary of what you replied with or what you want someone to do; this is used for UI rendering\n` +
          `- \`replyToRef\`: optional short message reference such as \`m_1775264233848001\` from the XML context when you are replying to a specific visible message\n` +
          `- \`message\`: your visible message content\n` +
          `- The message remains visible to the whole conversation. There is no recipient or target parameter for ordinary messages.\n` +
          `- Prefer \`<mention participantId="..."/>\`. You may also use \`<mention name="${exampleRecipient}"/>\` when the roster name is unique.\n` +
          `- Use inline mention only when the sentence explicitly points to someone: ownership, responsibility, follow-up, or who should handle a task.\n` +
          `- Mention inside the body does not make the message private and does not replace \`replyToRef\`.`;
    const sleepGuidance = isPrivateThread
      ? `- In a private thread, you must use \`send_to\` before \`sleep\`.\n`
      : `- In a group thread, you may sleep without \`send_to\` only when the wakeup is truly unrelated to you and the intended assignee already received the message, so your own visible reply would add no value.\n`;
    const mentionGuidance = isPrivateThread
      ? `- In a private thread, \`send_to\` already goes to the other participant. Use \`<mention .../>\` only when the sentence itself needs an inline participant reference.\n`
      : `- In a group thread, an unmentioned \`send_to\` message is a general group message.\n` +
          `- Use \`<mention .../>\` only when the sentence explicitly points to a participant. Mention does not create a private audience.\n`;
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
    ].join("\n");
    const workflowStepFour = isPrivateThread
      ? `4. This is a direct conversation with a fixed participant set. Do not suggest inviting participants, pulling people into a group, or treating it like a group chat`
      : `4. If you need help from another actor and \`invite_actor\` is available, use \`send_to\` for current participants or \`invite_actor\` for listed non-participants`;

    parts.push(
        `# Message Context\n\n` +
        `Visible conversation context is provided as XML-wrapped messages.\n` +
        `- Every visible message has an \`itemId\` and usually a short \`ref\` such as \`m_1775264233848001\`.\n` +
        `- Use \`participantId\` values from \`<conversation_manifest>\` for inline mentions. You do not need raw actorId, userId, or workspaceMemberId.\n` +
        `- Use \`replyToRef\` with \`send_to\` when you are replying to a specific visible message.\n` +
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
        `${isPrivateThread ? "- This is a direct conversation, not a group chat. Do not suggest adding participants, removing participants, or renaming it like a group.\n" : ""}` +
        `${mentionGuidance}` +
        `- If a public message is not addressed to you, treat it as shared context unless you are explicitly asked to respond or need to step in to unblock the work.\n` +
        `- Use message \`ref\` values from the XML context when you need to reply to a specific earlier message.\n` +
        `- Body mentions are inline participant references for sentence clarity. They are not a target filter and they do not replace \`replyToRef\`.\n` +
        `- Never rely on outdated roster assumptions. The system may insert profile-version events when another actor changes.`,
    );
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
        `Mention is an inline body reference for better UI presentation, not a generic addressee marker and not the same as sending the message to that person. Otherwise write normal text.`,
    );
  }

  if (extraTools && extraTools.length > 0) {
    parts.push(
      `# Available Plugin Tools\n\n` +
        `You have the following MCP plugin tools:\n` +
        extraTools
          .map((tool) => `- \`${tool.name}\`: ${tool.description}`)
          .join("\n") +
        `\n\nUse these tools when the user's request requires them. Tool names use namespace format (org__plugin__tool).`,
    );
  }

  return { system: parts.join("\n\n") };
}
