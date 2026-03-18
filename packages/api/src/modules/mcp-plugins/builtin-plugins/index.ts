import type { BuiltinOrgSeed } from './types.js';
import { zAiSeed } from './z-ai/index.js';
import { feishuSeed } from "./feishu/index.js";

export const builtinSeeds: BuiltinOrgSeed[] = [
  feishuSeed,
  zAiSeed,
];

export type { BuiltinOrgSeed, BuiltinPluginSeed } from './types.js';
