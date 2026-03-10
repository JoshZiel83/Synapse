import { ToolDefinition } from '@synapse/shared';
import type { SubFeature } from './types.js';
import { saveFromBuffer } from '../../../../../infrastructure/storage/file-io.js';

const ZHIPU_API_BASE = 'https://open.bigmodel.cn/api/paas/v4';
const DEFAULT_MODEL = 'glm-tts';

// GLM-TTS supported voices
// @see https://docs.bigmodel.cn/api-reference/模型-api/文本转语音
const VALID_VOICES = ['tongtong', 'chuichui', 'xiaochen', 'jam', 'kazi', 'douji', 'luodo'];

const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'text_to_speech',
    description:
      'Convert text to speech audio using ZhipuAI GLM-TTS. ' +
      'Supported voices: tongtong (default female), chuichui, xiaochen, jam, kazi, douji, luodo. ' +
      'Output format: wav (default) or pcm. Speed range: 0.5 to 2.0.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The text to convert to speech (max 1024 chars)' },
        voice: {
          type: 'string',
          description: 'Voice to use: tongtong, chuichui, xiaochen, jam, kazi, douji, luodo',
          enum: VALID_VOICES,
        },
        speed: { type: 'number', description: 'Speech speed (0.5 to 2.0, default 1.0)' },
        format: { type: 'string', description: 'Audio format: wav (default) or pcm', enum: ['wav', 'pcm'] },
      },
      required: ['text'],
    },
  },
];

export const ttsFeature: SubFeature = {
  featureKey: 'feature_tts',

  getTools(): ToolDefinition[] {
    return TOOL_DEFINITIONS;
  },

  async execute(toolName: string, input: Record<string, unknown>, config: Record<string, unknown>): Promise<string | unknown[]> {
    const apiKey = config.apiKey as string;
    if (!apiKey) throw new Error('ZhipuAI API key not configured.');

    const workspaceId = (config.workspace_id as string) || null;
    const text = input.text as string;
    const voice = VALID_VOICES.includes(input.voice as string) ? (input.voice as string) : 'tongtong';
    const speed = input.speed !== undefined ? Math.max(0.5, Math.min(2.0, Number(input.speed))) : 1.0;
    const format = input.format === 'pcm' ? 'pcm' : 'wav';

    const body: Record<string, unknown> = {
      model: DEFAULT_MODEL,
      input: text,
      voice,
      speed,
      response_format: format,
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);

    try {
      const response = await fetch(`${ZHIPU_API_BASE}/audio/speech`, {
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
        throw new Error(`GLM-TTS API error ${response.status}: ${errorText}`);
      }

      const arrayBuf = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuf);

      const ext = format === 'pcm' ? 'pcm' : 'wav';
      const mimeType = format === 'pcm' ? 'audio/x-pcm' : 'audio/wav';

      const fileRecord = await saveFromBuffer(
        buffer,
        `speech.${ext}`,
        mimeType,
        workspaceId,
        null,
        'plugin_output',
      );

      return [
        { type: 'text', text: `Generated audio: ${fileRecord.originalName}` },
        {
          type: 'file_ref',
          fileId: fileRecord.id,
          storedName: fileRecord.storedName,
          url: fileRecord.url,
          mimeType: fileRecord.mimeType,
          originalName: fileRecord.originalName,
          sizeBytes: fileRecord.sizeBytes,
          category: 'audio',
        },
      ];
    } finally {
      clearTimeout(timeout);
    }
  },
};
