import type { A2AAgentCard, A2AAgentSkill } from '@synapse/shared';
import { A2A_PROTOCOL_VERSION } from '@synapse/shared';

export function generateAgentCard(
  actor: { name: string; title: string; charter: string; skills?: any[] },
  appId: string,
  baseUrl: string,
): A2AAgentCard {
  const skills: A2AAgentSkill[] = (actor.skills || []).map((s: any) => ({
    id: s.id || s.name,
    name: s.name,
    description: s.description,
    tags: s.tags,
    examples: s.examples,
  }));

  // If no explicit skills, create one from the actor's charter
  if (skills.length === 0) {
    skills.push({
      id: 'default',
      name: actor.title,
      description: actor.charter.substring(0, 500),
    });
  }

  return {
    name: actor.name,
    description: `${actor.title}: ${actor.charter.substring(0, 300)}`,
    url: `${baseUrl}/a2a/${appId}`,
    version: A2A_PROTOCOL_VERSION,
    capabilities: {
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: true,
    },
    skills,
    defaultInputModes: ['text'],
    defaultOutputModes: ['text'],
  };
}

export function generateMultiAgentCard(
  actors: { name: string; title: string; charter: string; skills?: any[] }[],
  appName: string,
  appDescription: string,
  appId: string,
  baseUrl: string,
): A2AAgentCard {
  const allSkills: A2AAgentSkill[] = [];
  for (const actor of actors) {
    const actorSkills = (actor.skills || []).map((s: any) => ({
      id: `${actor.name}/${s.id || s.name}`,
      name: `[${actor.name}] ${s.name}`,
      description: s.description,
      tags: s.tags,
      examples: s.examples,
    }));

    if (actorSkills.length === 0) {
      allSkills.push({
        id: `${actor.name}/default`,
        name: `[${actor.name}] ${actor.title}`,
        description: actor.charter.substring(0, 300),
      });
    } else {
      allSkills.push(...actorSkills);
    }
  }

  return {
    name: appName,
    description: appDescription || actors.map(a => `${a.name}: ${a.title}`).join('; '),
    url: `${baseUrl}/a2a/${appId}`,
    version: A2A_PROTOCOL_VERSION,
    capabilities: {
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: true,
    },
    skills: allSkills,
    defaultInputModes: ['text'],
    defaultOutputModes: ['text'],
  };
}
