import type { BuiltinOrgSeed } from './types.js';
import { zAiSeed } from './z-ai/index.js';
import { feishuSeed } from "./feishu/index.js";
import { aminerSeed } from "./aminer/index.js";
import { amapSeed } from "./amap/index.js";
import { mijiaSeed } from "./mijia/index.js";

export const builtinSeeds: BuiltinOrgSeed[] = [
  feishuSeed,
  aminerSeed,
  amapSeed,
  mijiaSeed,
  zAiSeed,
];

export type { BuiltinOrgSeed, BuiltinPluginSeed } from './types.js';
