import { ToolDefinition } from '@synapse/shared';
import type { SubFeature } from './types.js';
import {
  fileRefProperty,
  resolveImageFileRefToDataUrl,
  resolveVideoFileRefToPublicUrl,
} from '../../../file-ref.js';

const ZHIPU_CHAT_ENDPOINT = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
const DEFAULT_MODEL = 'glm-4v-flash';

interface VisionMessage {
  role: 'user' | 'assistant';
  content: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>;
}

const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'image_analysis',
    description: 'Analyze an image and provide a detailed description of its content, objects, scenes, and notable features.',
    parameters: {
      type: 'object',
      properties: {
        fileRef: fileRefProperty('Image file to analyze.'),
        focus: { type: 'string', description: 'Optional focus area or aspect to emphasize in the analysis' },
      },
      required: ['fileRef'],
    },
  },
  {
    name: 'extract_text_from_screenshot',
    description: 'Extract and return all text visible in a screenshot or image using OCR capabilities.',
    parameters: {
      type: 'object',
      properties: {
        fileRef: fileRefProperty('Screenshot image to extract text from.'),
        language: { type: 'string', description: 'Expected language of the text (e.g., "en", "zh")' },
      },
      required: ['fileRef'],
    },
  },
  {
    name: 'diagnose_error_screenshot',
    description: 'Analyze a screenshot of an error message or error state and provide diagnosis and suggested fixes.',
    parameters: {
      type: 'object',
      properties: {
        fileRef: fileRefProperty('Screenshot image containing the error state.'),
        context: { type: 'string', description: 'Additional context about what was happening when the error occurred' },
      },
      required: ['fileRef'],
    },
  },
  {
    name: 'understand_technical_diagram',
    description: 'Analyze a technical diagram (architecture, UML, flowchart, etc.) and explain its components and relationships.',
    parameters: {
      type: 'object',
      properties: {
        fileRef: fileRefProperty('Technical diagram image to analyze.'),
        diagram_type: { type: 'string', description: 'Type of diagram (architecture, flowchart, UML, ER, etc.)' },
      },
      required: ['fileRef'],
    },
  },
  {
    name: 'analyze_data_visualization',
    description: 'Analyze a chart, graph, or data visualization and extract key insights, trends, and data points.',
    parameters: {
      type: 'object',
      properties: {
        fileRef: fileRefProperty('Chart or data visualization image to analyze.'),
        questions: { type: 'string', description: 'Specific questions to answer about the data' },
      },
      required: ['fileRef'],
    },
  },
  {
    name: 'ui_diff_check',
    description: 'Compare two UI screenshots and identify visual differences, layout changes, or regressions.',
    parameters: {
      type: 'object',
      properties: {
        beforeFileRef: fileRefProperty('Before/reference screenshot.'),
        afterFileRef: fileRefProperty('After/current screenshot.'),
        focus_areas: { type: 'string', description: 'Specific areas to focus the comparison on' },
      },
      required: ['beforeFileRef', 'afterFileRef'],
    },
  },
  {
    name: 'image_qa',
    description: 'Answer specific questions about the content of an image.',
    parameters: {
      type: 'object',
      properties: {
        fileRef: fileRefProperty('Image file to ask about.'),
        question: { type: 'string', description: 'The question to answer about the image' },
      },
      required: ['fileRef', 'question'],
    },
  },
  {
    name: 'video_analysis',
    description: 'Analyze a video by examining key frames and provide a summary of the content.',
    parameters: {
      type: 'object',
      properties: {
        fileRef: fileRefProperty('Video file to analyze.'),
        question: { type: 'string', description: 'Optional specific question about the video content' },
      },
      required: ['fileRef'],
    },
  },
];

const TOOL_PROMPTS: Record<string, (input: Record<string, unknown>) => { prompt: string; fileRefs: unknown[]; kind: 'image' | 'video' }> = {
  image_analysis: (input) => ({
    prompt: `Please analyze this image in detail.${input.focus ? ` Focus on: ${input.focus}` : ''} Describe objects, scenes, text, and notable features.`,
    fileRefs: [input.fileRef],
    kind: 'image',
  }),
  extract_text_from_screenshot: (input) => ({
    prompt: `Extract all visible text from this screenshot.${input.language ? ` Text language: ${input.language}` : ''} Preserve the layout and ordering.`,
    fileRefs: [input.fileRef],
    kind: 'image',
  }),
  diagnose_error_screenshot: (input) => ({
    prompt: `Analyze this error screenshot.${input.context ? ` Context: ${input.context}` : ''} Identify the error, diagnose likely causes, and suggest fixes.`,
    fileRefs: [input.fileRef],
    kind: 'image',
  }),
  understand_technical_diagram: (input) => ({
    prompt: `Analyze this technical diagram${input.diagram_type ? ` (type: ${input.diagram_type})` : ''}. Explain its components, relationships, and data flow.`,
    fileRefs: [input.fileRef],
    kind: 'image',
  }),
  analyze_data_visualization: (input) => ({
    prompt: `Analyze this data visualization.${input.questions ? ` Answer: ${input.questions}` : ' Extract key data points, trends, and insights.'}`,
    fileRefs: [input.fileRef],
    kind: 'image',
  }),
  ui_diff_check: (input) => ({
    prompt: `Compare these two UI screenshots and identify visual differences, layout changes, or regressions.${input.focus_areas ? ` Focus on: ${input.focus_areas}` : ''} The first image is the before/reference version, the second is the current version.`,
    fileRefs: [input.beforeFileRef, input.afterFileRef],
    kind: 'image',
  }),
  image_qa: (input) => ({
    prompt: `About this image, please answer: ${input.question}`,
    fileRefs: [input.fileRef],
    kind: 'image',
  }),
  video_analysis: (input) => ({
    prompt: `Analyze this video content.${input.question ? ` Answer: ${input.question}` : ' Provide a detailed summary.'}`,
    fileRefs: [input.fileRef],
    kind: 'video',
  }),
};

async function callGLM4V(
  apiKey: string,
  prompt: string,
  imageUrls: string[],
  model?: string,
): Promise<string> {
  const content: VisionMessage['content'] = [];

  for (const url of imageUrls) {
    content.push({ type: 'image_url', image_url: { url } });
  }
  content.push({ type: 'text', text: prompt });

  const body = {
    model: model || DEFAULT_MODEL,
    messages: [{ role: 'user', content }],
    max_tokens: 2048,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);

  try {
    const response = await fetch(ZHIPU_CHAT_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`GLM-4V API error ${response.status}: ${errorText}`);
    }

    const result = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    return result.choices?.[0]?.message?.content || 'No response from vision model';
  } finally {
    clearTimeout(timeout);
  }
}

export const visionFeature: SubFeature = {
  featureKey: 'feature_vision',

  getTools(): ToolDefinition[] {
    return TOOL_DEFINITIONS;
  },

  async execute(toolName: string, input: Record<string, unknown>, config: Record<string, unknown>): Promise<string> {
    const apiKey = config.apiKey as string;
    if (!apiKey) {
      throw new Error('ZhipuAI API key not configured.');
    }

    const promptBuilder = TOOL_PROMPTS[toolName];
    if (!promptBuilder) {
      throw new Error(`Unknown vision tool: ${toolName}`);
    }

    const { prompt, fileRefs, kind } = promptBuilder(input);
    const images = await Promise.all(
      fileRefs.map((fileRef, index) => (
        kind === 'video'
          ? resolveVideoFileRefToPublicUrl(fileRef, `fileRef[${index}]`)
          : resolveImageFileRefToDataUrl(fileRef, `fileRef[${index}]`)
      )),
    );
    const model = (config.visionModel as string) || DEFAULT_MODEL;

    return await callGLM4V(apiKey, prompt, images, model);
  },
};
