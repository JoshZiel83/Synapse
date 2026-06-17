// Actor-doc template table (runtime data).
//
// Migrated out of `types/index.ts` so that `types/index.ts` stays a pure type
// surface (see docs/architecture-boundary-refactor-master-plan.md §2.2.1).
// Kept under `types/` as a sibling because it is the canonical template data
// paired with the `ActorDocTemplate` / `CoreActorDocKey` types; re-exported
// from the package root barrel.

import type { ActorDocTemplate, CoreActorDocKey } from "../types/index.js"

export const ACTOR_DOC_TEMPLATES: ActorDocTemplate[] = [
  {
    key: "identity_card",
    title: "Identity Card",
    description: "How this actor introduces themselves in public.",
    defaultVisibility: "always",
    defaultPriority: 120,
  },
  {
    key: "public_persona",
    title: "Public Persona",
    description: "Voice, tone, and how this actor appears to others.",
    defaultVisibility: "always",
    defaultPriority: 115,
  },
  {
    key: "soul",
    title: "Soul",
    description: "Values, principles, taboos, and emotional core.",
    defaultVisibility: "always",
    defaultPriority: 110,
  },
  {
    key: "self_narrative",
    title: "Self Narrative",
    description: "How this actor understands themselves.",
    defaultVisibility: "always",
    defaultPriority: 105,
  },
  {
    key: "origin_story",
    title: "Origin Story",
    description: "Where this actor comes from and what shaped them.",
    defaultVisibility: "internal_only",
    defaultPriority: 100,
  },
  {
    key: "relationship_with_user",
    title: "Relationship With User",
    description: "How this actor relates to the human user.",
    defaultVisibility: "always",
    defaultPriority: 98,
  },
  {
    key: "relationship_with_team",
    title: "Relationship With Team",
    description: "How this actor views and works with other actors.",
    defaultVisibility: "multi_member_only",
    defaultPriority: 96,
  },
  {
    key: "representation_guidelines",
    title: "Representation Guidelines",
    description: "How to speak or act when representing the user.",
    defaultVisibility: "internal_only",
    defaultPriority: 94,
  },
  {
    key: "social_protocol",
    title: "Social Protocol",
    description: "When to speak, when to stay quiet, and what not to share.",
    defaultVisibility: "multi_member_only",
    defaultPriority: 92,
  },
  {
    key: "role_charter",
    title: "Role Charter",
    description: "Organizational responsibilities and scope.",
    defaultVisibility: "always",
    defaultPriority: 90,
  },
  {
    key: "mission",
    title: "Mission",
    description: "Long-term aim, current mission, and success criteria.",
    defaultVisibility: "always",
    defaultPriority: 88,
  },
  {
    key: "work_doctrine",
    title: "Work Doctrine",
    description: "How this actor approaches work, evidence, and communication.",
    defaultVisibility: "always",
    defaultPriority: 86,
  },
  {
    key: "limitations_and_escalation",
    title: "Limitations And Escalation",
    description: "Blind spots, refusal zones, and when to ask for help.",
    defaultVisibility: "always",
    defaultPriority: 84,
  },
  {
    key: "quirks_and_signatures",
    title: "Quirks And Signatures",
    description: "Habits, running jokes, signatures, and expressive details.",
    defaultVisibility: "always",
    defaultPriority: 82,
  },
  {
    key: "routines",
    title: "Routines",
    description: "Recurring habits, checks, and proactive rhythms.",
    defaultVisibility: "internal_only",
    defaultPriority: 80,
  },
  {
    key: "conversation_examples",
    title: "Conversation Examples",
    description:
      "Examples of how this actor speaks, declines, or collaborates.",
    defaultVisibility: "internal_only",
    defaultPriority: 78,
  },
]

export const ACTOR_DOC_TEMPLATE_MAP: Record<CoreActorDocKey, ActorDocTemplate> =
  Object.fromEntries(
    ACTOR_DOC_TEMPLATES.map((template) => [template.key, template])
  ) as Record<CoreActorDocKey, ActorDocTemplate>
