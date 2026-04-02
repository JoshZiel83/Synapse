import {
  AvailableSkillSummary,
  extractText,
  formatMentionText,
  normalizeActorDocs,
  resolveThreadSemantics,
} from "@synapse/shared";
import type { ActorDoc, ToolDefinition } from "@synapse/shared";

export interface ConversationMemberInfo {
  id?: string;
  member_type?: string;
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

function buildRosterEntry(member: ConversationMemberInfo): string {
  const title = member.actor_title || member.actor_role || "Actor";
  const docs = parseActorDocs(member)
    .filter((doc) => isDocVisible(doc, "multi_member_conversation", false))
    .sort((left, right) => right.priority - left.priority);

  const summary = docs.map((doc) => summarizeDoc(doc, 120)).find(Boolean) || "";

  const version = member.actor_current_version
    ? ` v${member.actor_current_version}`
    : "";
  const actorIdNote = member.actor_id ? ` [actorId=${member.actor_id}]` : "";
  return `- [actor] **${member.actor_name}**${version} — ${title}${actorIdNote}${summary ? ` — ${summary}` : ""}`;
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
 *   3. Conversation member roster with type + database UUID
 *   4. send_to tool description & collaboration rules
 *   5. MCP plugin tools (if any)
 */
export function buildActorPrompt(
  actor: any,
  _subordinates?: any,
  _sessionContext?: any,
  extraTools?: ToolDefinition[],
  conversationMembers?: ConversationMemberInfo[],
  conversationKind?: "private" | "group" | "virtual",
  availableSkills?: AvailableSkillSummary[],
): { system: string } {
  const parts: string[] = [];
  const threadSemantics = resolveThreadSemantics({
    kind: conversationKind,
    otherParticipantCount: conversationMembers?.length || 0,
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
      `- Actor-created memories only support three scopes: \`actor_in_conversation\` (private to you in this conversation), \`conversation\` (shared in this conversation), and \`actor_global\` (follows you across conversations).\n` +
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

  if (conversationMembers && conversationMembers.length > 0) {
    const isPrivateThread = threadSemantics.isPrivateConversation;
    const exampleRecipient =
      conversationMembers.find((member) => member.user_id)?.user_name ||
      conversationMembers.find(
        (member) =>
          member.member_type === "external" || member.transport_external_id,
      )?.transport_display_name ||
      conversationMembers.find(
        (member) =>
          member.member_type === "external" || member.transport_external_id,
      )?.display_name ||
      "User";
    const roster = [
      "# Conversation Members",
      "",
      isPrivateThread
        ? "You are in a private thread with the following other members:"
        : "You are in a group thread with the following other members:",
      "",
      ...conversationMembers.flatMap((member) => {
        if (member.user_id) {
          const participantIdNote = member.id
            ? `; participantId=${member.id}`
            : "";
          return [
            `- [user] **${member.user_name || "User"}** — the human user [userId=${member.user_id}${participantIdNote}]`,
          ];
        }
        if (member.actor_id && member.actor_id !== actor.id) {
          return [buildRosterEntry(member)];
        }
        if (member.member_type === "external" || member.transport_external_id) {
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
          const externalKeyNote = member.transport_external_id
            ? ` [externalUserKey=${member.transport_external_id}]`
            : "";
          return [
            `- [external] **${externalName}** — external participant${participantIdNote}${externalKeyNote}${mapping}`,
          ];
        }
        return [];
      }),
    ].join("\n");

    parts.push(roster);

    const communicationOverview = isPrivateThread
      ? `All visible communication uses the \`send_to\` tool. Conversation messages are shared with the other current participant. This is a private thread, so \`send_to\` goes directly to the other participant instead of taking an explicit recipient list.`
      : `All visible communication uses the \`send_to\` tool. Conversation messages are shared with all members. Recipient labels indicate who you are addressing, not private visibility. Every visible reply must target a specific recipient.`;
    const sendToGuide = isPrivateThread
      ? `Send a visible message to the other current participant.\n` +
          `Parameters:\n` +
          `- \`intent\`: \`reply\` when you are replying with information or a result; \`request\` when you are delegating, asking, or requesting action\n` +
          `- \`summary\`: a short structured summary of what you replied with or what you want the other participant to do; this is used for UI rendering\n` +
          `- \`message\`: your visible message content\n` +
          `- The recipient is implicit. In this private thread, \`send_to\` goes directly to ${exampleRecipient} or whoever is currently the other participant.\n` +
          `- To mention a member inside \`message\`, use either \`<Mention name="${exampleRecipient}"/>\` or an explicit id form such as \`<Mention type="actor" id="..."/>\`.\n` +
          `- Name matching is convenient but may be ambiguous when multiple members share the same display name. If that happens, use \`type="actor|user|external"\` plus \`id="..."\`, or use an explicit id attribute such as \`actorId\`, \`userId\`, \`participantId\`, \`memberId\`, or \`externalUserKey\`.\n` +
          `- The conversation roster above includes the ids you need for disambiguation.\n` +
          `- Inline \`<Mention .../>\` is only a rich body reference for UI rendering and sentence clarity. Mention is not the same thing as choosing the visible recipient.\n` +
          `- Do not mechanically mention the other participant at the start of every message. Use inline mention only when the sentence explicitly points to that person.`
      : `Send a message to one or more members by name.\n` +
          `Parameters:\n` +
          `- \`recipients\`: array of member names (for example ["${exampleRecipient}"] or ["Actor1", "Actor2"])\n` +
          `- \`intent\`: \`reply\` when you are replying with information or a result; \`request\` when you are delegating, asking, or requesting action\n` +
          `- \`summary\`: a short structured summary of what you replied with or what you want the recipient(s) to do; this is used for UI rendering\n` +
          `- \`message\`: your visible message content\n` +
          `- To mention a member inside \`message\`, use either \`<Mention name="${exampleRecipient}"/>\` or an explicit id form such as \`<Mention type="actor" id="..."/>\`.\n` +
          `- Name matching is convenient but may be ambiguous when multiple members share the same display name. If that happens, use \`type="actor|user|external"\` plus \`id="..."\`, or use an explicit id attribute such as \`actorId\`, \`userId\`, \`participantId\`, \`memberId\`, or \`externalUserKey\`.\n` +
          `- The conversation roster above includes the ids you need for disambiguation.\n` +
          `- \`recipients\` and inline \`<Mention .../>\` mean different things: \`recipients\` decides who the visible message is addressed to, while \`<Mention .../>\` renders an inline member reference inside the sentence body for better UI presentation and clearer wording.\n` +
          `- Do not mechanically mention the recipient at the start of every message. If the body does not need an explicit inline person reference, do not add a mention.\n` +
          `- When the sentence is explicitly pointing to someone, use inline mention. Typical cases: naming an owner, saying who is responsible, saying who should handle a task, saying who to contact, calling out a subset in a multi-person message, or referring to a third party.\n` +
          `- Mention does not send the message to that person by itself. It is a display and reference mechanism inside the message body.`;
    const sleepGuidance = isPrivateThread
      ? `- In a private thread, you must use \`send_to\` before \`sleep\`.\n`
      : `- In a group thread, you may sleep without \`send_to\` only when the wakeup is truly unrelated to you and the intended assignee already received the message, so your own visible reply would add no value.\n`;
    const recipientGuidance = isPrivateThread
      ? `- In a private thread, \`send_to\` already targets the other participant. Use \`<Mention .../>\` only when the sentence itself needs an inline body reference.\n`
      : `- A \`send_to\` recipient indicates who should read or act on the message first; it does not make the message private.\n` +
          `- A \`send_to\` recipient already tells the UI who the message is for. Do not duplicate that with a leading \`<Mention .../>\` unless the sentence itself needs an inline reference.\n`;
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
      ? `4. This is a direct conversation with a fixed participant set. Do not suggest inviting members, pulling people into a group, or treating it like a group chat`
      : `4. If you need help from another actor and \`invite_actor\` is available, use \`send_to\` for current members or \`invite_actor\` for listed non-members`;

    parts.push(
      `# Message Format\n\n` +
        `Messages in this conversation use this format:\n` +
        `- \`[YYYY-MM-DD HH:mm UTC | SenderName → RecipientName]: message\` — a visible conversation message addressed to a specific recipient at that exact time\n` +
        `- \`[System]: event description\` — a system event (member joined/left, profile updated)\n\n` +
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
        `- Your internal tool calls (MCP tools, memory_search, create_memory, and so on) are not visible to other conversation members.\n` +
        `- Only \`send_to\` produces visible messages.\n` +
        `- Do not call \`sleep\` until you have decided whether the conversation needs a visible message from you.\n` +
        `- If this wakeup leads to a result, handoff, clarification, or explicit "no action needed" decision that others should know, use \`send_to\` first and only then call \`sleep\`.\n` +
        `${sleepGuidance}` +
        `- All visible conversation messages are shared with the whole conversation.\n` +
        `${isPrivateThread ? "- This is a direct conversation, not a group chat. Do not suggest adding members, removing members, or renaming it like a group.\n" : ""}` +
        `${recipientGuidance}` +
        `- If a public message is not addressed to you, treat it as shared context unless you are explicitly asked to respond or need to step in to unblock the work.\n` +
        `- Use \`<Mention name="..."/>\` when you want the UI to render an actual member mention inside the message body, especially when the sentence is identifying who owns something or who should take action. Mention is not the same as target.\n` +
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
        `Do not prepend \`<Mention name="User"/>\` by default when replying. Use mention tags when the sentence itself needs to point to a member, such as saying who owns something, who should follow up, or who should be contacted.\n` +
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
