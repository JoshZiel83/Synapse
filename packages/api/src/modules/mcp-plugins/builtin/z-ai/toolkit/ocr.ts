import { ToolDefinition } from '@synapse/shared';
import type { SubFeature } from './types.js';
import { fileToBuffer } from '../../../../../infrastructure/storage/file-io.js';
import { resolveFileRefRecord, fileRefProperty } from '../../../file-ref.js';
import { normalizeZhipuTransportError, throwZhipuApiError } from './zhipu-errors.js';

const ZHIPU_API_BASE = 'https://open.bigmodel.cn/api/paas/v4';

const LANGUAGE_TYPES = [
  'CHN_ENG', 'AUTO', 'ENG', 'JAP', 'KOR', 'FRE', 'SPA', 'POR', 'GER', 'ITA',
  'RUS', 'DAN', 'DUT', 'MAL', 'SWE', 'IND', 'POL', 'ROM', 'TUR', 'GRE',
  'HUN', 'THA', 'VIE', 'ARA', 'HIN',
];

const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'ocr_image',
    description:
      'Run ZhipuAI OCR service on an image FileRef. ' +
      'This is the official OCR API, separate from vision chat. ' +
      'It supports hand_write recognition mode, optional language hints, and optional confidence output.',
    parameters: {
      type: 'object',
      properties: {
        fileRef: fileRefProperty('Image FileRef to send to the OCR service. The API expects an image such as JPG or PNG.'),
        languageType: {
          type: 'string',
          description: 'Optional OCR language/model hint. Use AUTO for automatic detection or CHN_ENG for mixed Chinese/English.',
          enum: LANGUAGE_TYPES,
        },
        probability: {
          type: 'boolean',
          description: 'Whether to request confidence information for each recognized text block.',
        } as any,
      },
      required: ['fileRef'],
    },
  },
];

async function ensureSupportedOcrImage(buffer: Buffer, mimeType: string): Promise<{ buffer: Buffer; mimeType: string; originalName: string }> {
  if (mimeType === 'image/jpeg' || mimeType === 'image/png') {
    const ext = mimeType === 'image/png' ? 'png' : 'jpg';
    return { buffer, mimeType, originalName: `ocr-input.${ext}` };
  }

  const sharp = (await import('sharp')).default;
  const converted = await sharp(buffer, { animated: true }).png().toBuffer();
  return { buffer: converted, mimeType: 'image/png', originalName: 'ocr-input.png' };
}

export const ocrFeature: SubFeature = {
  featureKey: 'feature_ocr',

  getTools(): ToolDefinition[] {
    return TOOL_DEFINITIONS;
  },

  async execute(_toolName: string, input: Record<string, unknown>, config: Record<string, unknown>): Promise<string> {
    const apiKey = config.apiKey as string;
    if (!apiKey) throw new Error('ZhipuAI API key not configured.');

    const record = await resolveFileRefRecord(input.fileRef, 'fileRef', 'image');
    const originalBuffer = await fileToBuffer(record.storedName);
    const prepared = await ensureSupportedOcrImage(originalBuffer, record.mimeType);

    const form = new FormData();
    form.append('file', new Blob([prepared.buffer], { type: prepared.mimeType }), record.originalName || prepared.originalName);
    form.append('tool_type', 'hand_write');

    if (typeof input.languageType === 'string' && input.languageType) {
      form.append('language_type', input.languageType);
    }
    if (typeof input.probability === 'boolean') {
      form.append('probability', String(input.probability));
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120000);

    try {
      const response = await fetch(`${ZHIPU_API_BASE}/files/ocr`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
        },
        body: form,
        signal: controller.signal,
      });

      if (!response.ok) {
        await throwZhipuApiError('OCR 服务 API', response);
      }

      const result = await response.json() as {
        task_id?: string;
        status?: string;
        message?: string;
        words_result_num?: number;
        words_result?: Array<{
          words?: string;
          probability?: { average?: number; variance?: number; min?: number };
        }>;
      };

      const lines = (result.words_result || [])
        .map((item, index) => {
          const text = item.words || '';
          if (!text) return '';
          if (input.probability && item.probability) {
            return `${index + 1}. ${text} (avg=${item.probability.average ?? 'n/a'}, min=${item.probability.min ?? 'n/a'})`;
          }
          return `${index + 1}. ${text}`;
        })
        .filter(Boolean);

      if (lines.length === 0) {
        return `OCR completed with status ${result.status || 'unknown'}, but no text was returned. Message: ${result.message || 'none'}`;
      }

      return [
        `OCR task ${result.task_id || ''} status: ${result.status || 'unknown'}`,
        `Recognized blocks: ${result.words_result_num ?? lines.length}`,
        lines.join('\n'),
      ].join('\n\n');
    } catch (error) {
      throw normalizeZhipuTransportError('OCR 服务 API', error);
    } finally {
      clearTimeout(timeout);
    }
  },
};
