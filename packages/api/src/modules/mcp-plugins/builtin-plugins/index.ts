import type { BuiltinOrgSeed } from './types.js';
import { zAiSeed } from './z-ai/index.js';

export const builtinSeeds: BuiltinOrgSeed[] = [
  zAiSeed,
];

export type { BuiltinOrgSeed, BuiltinPluginSeed } from './types.js';
