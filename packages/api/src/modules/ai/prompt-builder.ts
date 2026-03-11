import type { Memory, ToolDefinition } from '@synapse/shared';

export interface GroupMemberInfo {
  actor_id?: string;
  user_id?: string;
  actor_name?: string;
  actor_title?: string;
  actor_role?: string;
  user_name?: string;
  user_id_ref?: string;
  session_status?: string;
  // Extended fields for richer member descriptions
  actor_charter?: string;
  actor_skills?: { name: string; description: string }[];
}

/**
 * Build the system prompt for an actor in a group chat.
 * Structure:
 *   1. Actor identity & responsibilities (from versioned data at join time)
 *   2. Memories
 *   3. Group member roster with type + database UUID
 *   4. send_to tool description & collaboration rules
 *   5. MCP plugin tools (if any)
 */
export function buildActorPrompt(
  actor: any, // DB row or versioned actor data with snake_case fields
  memories: Memory[],
  _subordinates?: any,
  _sessionContext?: any,
  extraTools?: ToolDefinition[],
  groupMembers?: GroupMemberInfo[],
): { system: string } {
  const parts: string[] = [];

  // ── 1. Identity ──
  parts.push(
    `# Your Identity\n` +
    `You are **${actor.name}** (${actor.title || actor.role}).\n\n` +
    actor.system_prompt + '\n\n' +
    `## Your Charter (Responsibilities)\n` +
    actor.charter,
  );

  // Skills
  const skills: any[] = typeof actor.skills === 'string' ? JSON.parse(actor.skills) : (actor.skills || []);
  if (skills.length > 0) {
    parts.push(
      `## Your Skills\n` +
      skills.map((s: any) => `- **${s.name}**: ${s.description}`).join('\n'),
    );
  }

  // ── 2. Memories ──
  if (memories.length > 0) {
    parts.push(
      `# Your Memories\n` +
      memories.map((m) => `- [${m.category}] ${m.content}`).join('\n'),
    );
  }

  // ── 3. Group context ──
  if (groupMembers && groupMembers.length > 0) {
    let roster = '# Group Members\n\nYou are in a group chat with the following members:\n\n';

    for (const member of groupMembers) {
      if (member.user_id) {
        roster += `- [user] **${member.user_name || 'User'}** — the human user\n`;
      } else if (member.actor_id && member.actor_id !== actor.id) {
        const title = member.actor_title || member.actor_role || 'Actor';
        roster += `- [actor] **${member.actor_name}** — ${title}`;
        if (member.actor_charter) {
          const brief = member.actor_charter.split('\n')[0].substring(0, 120);
          roster += ` — ${brief}`;
        }
        roster += '\n';
      }
    }

    parts.push(roster);

    // ── 4. Communication rules ──
    parts.push(
      `# Message Format\n\n` +
      `Messages in the group chat use this format:\n` +
      `- \`[SenderName → RecipientName]: message\` — a directed message\n` +
      `- \`[System]: event description\` — a system event (member joined/left, profile updated)\n\n` +

      `# Communication\n\n` +
      `All communication uses the \`send_to\` tool. There is no broadcast — every message must have a specific recipient.\n\n` +

      `## send_to\n` +
      `Send a message to one or more members by name.\n` +
      `Parameters:\n` +
      `- \`recipients\`: array of member names (e.g. ["${groupMembers.find(m => m.user_id)?.user_name || 'User'}"] or ["Actor1", "Actor2"])\n` +
      `- \`message\`: your message content\n\n` +

      `## Other tools\n` +
      `- \`invite_actor\`: Invite a new actor to join this group when you need a skill no current member has\n` +
      `- \`sleep\`: When you have finished your work, call sleep. You will be automatically woken when someone sends you a message\n` +
      `- \`create_memory\`: Save important information for future reference\n\n` +

      `## Workflow\n` +
      `1. Read the message directed at you\n` +
      `2. Do the work using your tools and capabilities\n` +
      `3. Use \`send_to\` to reply to whoever sent you the message (user or actor)\n` +
      `4. If you need help from another actor, use \`send_to\` to ask them\n` +
      `5. When done, call \`sleep\` — you'll be woken when needed again\n\n` +

      `## Important\n` +
      `- **You MUST use \`send_to\` to reply.** Plain text output is internal reasoning only — nobody can see it.\n` +
      `- Your internal tool calls (MCP tools, create_memory, etc.) are NOT visible to the group\n` +
      `- Only \`send_to\` produces visible messages — ALWAYS use it to communicate your response\n` +
      `- You can only see messages sent directly to you. Other actors' conversations are private.\n` +
      `- NEVER reply with plain text alone. You MUST call \`send_to\` for every response.`,
    );
  } else {
    // Non-group (solo) mode
    parts.push(
      `# Working Mode\n\n` +
      `You are working independently (no group context). Handle all tasks yourself directly.\n` +
      `Provide complete, thorough responses. Do NOT say you will do something later — do it now.`,
    );
  }

  // ── 5. MCP plugin tools ──
  if (extraTools && extraTools.length > 0) {
    parts.push(
      `# Available Plugin Tools\n\n` +
      `You have the following MCP plugin tools:\n` +
      extraTools.map((t) => `- \`${t.name}\`: ${t.description}`).join('\n') +
      '\n\nUse these tools when the user\'s request requires them. Tool names use namespace format (org__plugin__tool).',
    );
  }

  return { system: parts.join('\n\n') };
}
