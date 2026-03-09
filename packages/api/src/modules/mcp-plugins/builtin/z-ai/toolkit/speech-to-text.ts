/**
 * ZhipuAI Speech-to-Text (GLM-ASR) — audio transcription.
 *
 * Endpoint: POST /paas/v4/audio/transcriptions (multipart/form-data or base64)
 * Model: glm-asr-2512
 * Supported audio: .wav, .mp3, ≤ 25 MB, ≤ 30 seconds
 * @see https://docs.bigmodel.cn/api-reference/模型-api/语音转文本
 */
import { ToolDefinition } from '@synapse/shared';
import type { SubFeature } from './types.js';
import { getFileRecord } from '../../../../files/service.js';
import { fileToBase64 } from '../../../../../infrastructure/storage/file-io.js';
import { downloadAndSave, readAsBase64 } from '../../../../../infrastructure/storage/index.js';

const ZHIPU_API_BASE = 'https://open.bigmodel.cn/api/paas/v4';
const DEFAULT_MODEL = 'glm-asr-2512';

const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'audio_transcription',
    description:
      'Transcribe audio to text using ZhipuAI GLM-ASR. ' +
      'Provide either a file_id (from an uploaded file) or an audio_url. ' +
      'Supported formats: .wav, .mp3. Max file size: 25 MB, max duration: 30 seconds.',
    parameters: {
      type: 'object',
      properties: {
        file_id: {
          type: 'string',
          description: 'ID of an uploaded audio file to transcribe',
        },
        audio_url: {
          type: 'string',
          description: 'URL of the audio file to transcribe',
        },
        prompt: {
          type: 'string',
          description: 'Prior transcription context for long-text scenarios (recommended under 8000 chars)',
        },
        hotwords: {
          type: 'array',
          items: { type: 'string' },
          description: 'Hotword list to improve domain-specific recognition, e.g. names or terms (max 100 items)',
        },
      },
      required: [],
    },
  },
];

async function getAudioBase64(input: Record<string, unknown>): Promise<{ base64: string; mimeType: string }> {
  const fileId = input.file_id as string | undefined;
  const audioUrl = input.audio_url as string | undefined;

  if (fileId) {
    const record = await getFileRecord(fileId);
    if (!record) throw new Error(`File not found: ${fileId}`);
    const base64 = await fileToBase64(record.storedName);
    return { base64, mimeType: record.mimeType };
  }

  if (audioUrl) {
    const { storedName, mimeType } = await downloadAndSave(audioUrl, 'audio_input');
    const base64 = await readAsBase64(storedName);
    return { base64, mimeType };
  }

  throw new Error('Either file_id or audio_url must be provided');
}

export const sttFeature: SubFeature = {
  featureKey: 'feature_stt',

  getTools(): ToolDefinition[] {
    return TOOL_DEFINITIONS;
  },

  async execute(toolName: string, input: Record<string, unknown>, config: Record<string, unknown>): Promise<string> {
    const apiKey = config.apiKey as string;
    if (!apiKey) throw new Error('ZhipuAI API key not configured.');

    const { base64 } = await getAudioBase64(input);
    const prompt = input.prompt as string | undefined;
    const hotwords = input.hotwords as string[] | undefined;

    // Use the dedicated /audio/transcriptions endpoint with file_base64
    // @see https://docs.bigmodel.cn/api-reference/模型-api/语音转文本
    const body: Record<string, unknown> = {
      model: DEFAULT_MODEL,
      file_base64: base64,
    };
    if (prompt) body.prompt = prompt;
    if (hotwords && hotwords.length > 0) body.hotwords = hotwords.slice(0, 100);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120000);

    try {
      const response = await fetch(`${ZHIPU_API_BASE}/audio/transcriptions`, {
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
        throw new Error(`GLM-ASR API error ${response.status}: ${errorText}`);
      }

      const result = await response.json() as { text?: string };

      return result.text || 'No transcription result';
    } finally {
      clearTimeout(timeout);
    }
  },
};
