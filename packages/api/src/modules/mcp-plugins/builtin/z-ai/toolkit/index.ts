import { ToolDefinition } from '@synapse/shared';
import type { BuiltinPluginHandler } from '../../index.js';
import type { SubFeature } from './types.js';
import { searchFeature } from './search.js';
import { readerFeature } from './reader.js';
import { zreadFeature } from './zread.js';
import { ocrFeature } from './ocr.js';
import { fileParserSyncFeature } from './file-parser-sync.js';
import { layoutParsingFeature } from './layout-parsing.js';
import { moderationFeature } from './moderation.js';
import { visionFeature } from './vision.js';
import { sttFeature } from './speech-to-text.js';
import { imageGenFeature } from './image-generation.js';
import { ttsFeature } from './text-to-speech.js';

const ALL_FEATURES: SubFeature[] = [
  searchFeature,
  readerFeature,
  zreadFeature,
  ocrFeature,
  fileParserSyncFeature,
  layoutParsingFeature,
  moderationFeature,
  visionFeature,
  sttFeature,
  imageGenFeature,
  ttsFeature,
];

// Map tool name -> owning sub-feature for fast dispatch
const toolToFeature = new Map<string, SubFeature>();
for (const feature of ALL_FEATURES) {
  for (const tool of feature.getTools()) {
    toolToFeature.set(tool.name, feature);
  }
}

function getEnabledFeatures(config: Record<string, unknown>): SubFeature[] {
  return ALL_FEATURES.filter(f => config[f.featureKey] !== false);
}

export const zAiToolkitHandler: BuiltinPluginHandler & {
  getToolsFiltered(config: Record<string, unknown>): ToolDefinition[];
} = {
  getTools(): ToolDefinition[] {
    // Return all tools (unfiltered) for registration / manifest purposes
    const tools: ToolDefinition[] = [];
    for (const feature of ALL_FEATURES) {
      tools.push(...feature.getTools());
    }
    return tools;
  },

  getToolsFiltered(config: Record<string, unknown>): ToolDefinition[] {
    const tools: ToolDefinition[] = [];
    for (const feature of getEnabledFeatures(config)) {
      tools.push(...feature.getTools());
    }
    return tools;
  },

  async execute(toolName: string, input: Record<string, unknown>, config: Record<string, unknown>): Promise<unknown> {
    const apiKey = config.apiKey as string;
    if (!apiKey) {
      throw new Error('ZhipuAI API key not configured. Set it in the plugin configuration.');
    }

    const feature = toolToFeature.get(toolName);
    if (!feature) {
      throw new Error(`Unknown tool: ${toolName}`);
    }

    // Check if this feature is enabled
    if (config[feature.featureKey] === false) {
      throw new Error(`Feature ${feature.featureKey} is disabled. Enable it in plugin configuration.`);
    }

    return feature.execute(toolName, input, config);
  },
};
