import type { Actor, Memory } from '@synapse/shared';

interface Subordinate {
  name: string;
  title: string;
  charter: string;
}

export function buildActorPrompt(
  actor: Actor,
  memories: Memory[],
  workContext: string,
  subordinates?: Subordinate[]
): { system: string; messages: { role: string; content: string }[] } {
  let system =
    actor.systemPrompt +
    '\n\nYour charter:\n' +
    actor.charter +
    '\n\nRelevant memories:\n' +
    memories.map((m) => `- [${m.category}] ${m.content}`).join('\n');

  if (subordinates && subordinates.length > 0) {
    system +=
      '\n\nYour team:\n' +
      subordinates
        .map((s) => `- ${s.name} (${s.title}): ${s.charter.substring(0, 200)}`)
        .join('\n');
  } else {
    system +=
      '\n\nYou currently have no subordinates. You MUST handle all tasks yourself directly. ' +
      'Provide complete, thorough responses. Do NOT say you will do something later — do it now in your response. ' +
      'Always include the full content in your respond tool call.';
  }

  const messages = [{ role: 'user', content: workContext }];

  return { system, messages };
}
