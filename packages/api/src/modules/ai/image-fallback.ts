import type { CanonicalContentBlock } from '@synapse/shared';
import { createRequire } from 'module';
import { mkdir } from 'node:fs/promises';
import { readAsBuffer } from '../../infrastructure/storage/index.js';
import { config } from '../../config/index.js';

type FileRefBlock = Extract<CanonicalContentBlock, { type: 'file_ref' }>;
type ImageFileBlock = FileRefBlock & { category: 'image' };

interface ImageOcrResult {
  ok: boolean;
  text?: string;
  error?: string;
}

type TesseractWorker = {
  recognize(image: Buffer): Promise<{ data?: { text?: string } }>;
  terminate(): Promise<unknown>;
};

type TesseractModule = {
  createWorker(
    langs?: string | string[],
    oem?: number,
    options?: {
      langPath?: string;
      cachePath?: string;
      workerPath?: string;
      logger?: (message: unknown) => void;
      errorHandler?: (err: unknown) => void;
    },
  ): Promise<TesseractWorker>;
};

const ocrCache = new Map<string, Promise<ImageOcrResult>>();
const localRequire = createRequire(import.meta.url);
const warnedMessages = new Set<string>();

let tesseractModulePromise: Promise<TesseractModule | null> | null = null;
let workerPathPromise: Promise<string | null> | null = null;

function warnOnce(message: string): void {
  if (warnedMessages.has(message)) return;
  warnedMessages.add(message);
  console.warn(`[image-fallback] ${message}`);
}

function normalizeOcrText(text: string): string {
  return text.trim().replace(/\s+/g, ' ').slice(0, 4000);
}

function getTesseractLangs(): string | string[] {
  const raw = config.imageFallback.tesseractLangs.trim();
  if (!raw) return 'eng';

  const commaSeparated = raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

  if (commaSeparated.length > 1) return commaSeparated;
  return commaSeparated[0] || raw;
}

async function loadTesseractModule(): Promise<TesseractModule | null> {
  if (!tesseractModulePromise) {
    tesseractModulePromise = Promise.resolve().then(() => {
      try {
        return localRequire('tesseract.js') as TesseractModule;
      } catch {
        warnOnce('tesseract.js is not installed. Image OCR fallback will be skipped.');
        return null;
      }
    });
  }

  return tesseractModulePromise;
}

async function getWorkerPath(): Promise<string | null> {
  if (!workerPathPromise) {
    workerPathPromise = Promise.resolve().then(() => {
      try {
        return localRequire.resolve('tesseract.js/src/worker-script/node/index.js');
      } catch {
        warnOnce('tesseract.js worker script could not be resolved. Image OCR fallback will be skipped.');
        return null;
      }
    });
  }

  return workerPathPromise;
}

async function prepareImageForOcr(buffer: Buffer): Promise<Buffer> {
  try {
    const sharp = (await import('sharp')).default;
    return await sharp(buffer, { animated: true }).png().toBuffer();
  } catch (err: any) {
    warnOnce(`sharp failed to normalize image input for OCR; falling back to original bytes. ${err?.message || 'unknown error'}`);
    return buffer;
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function transcribeImageWithTesseract(block: ImageFileBlock): Promise<ImageOcrResult> {
  const tesseract = await loadTesseractModule();
  if (!tesseract) {
    return {
      ok: false,
      error: 'tesseract.js is not installed',
    };
  }

  const workerPath = await getWorkerPath();
  if (!workerPath) {
    return {
      ok: false,
      error: 'tesseract.js worker script could not be resolved',
    };
  }

  try {
    await mkdir(config.imageFallback.tesseractCachePath, { recursive: true });
    const inputBuffer = await readAsBuffer(block.storedName);
    const imageBuffer = await prepareImageForOcr(inputBuffer);
    const worker = await tesseract.createWorker(
      getTesseractLangs(),
      1,
      {
        workerPath,
        cachePath: config.imageFallback.tesseractCachePath,
        langPath: config.imageFallback.tesseractLangPath || undefined,
        logger: () => {},
        errorHandler: (err) => {
          const message = err instanceof Error ? err.message : String(err);
          warnOnce(`tesseract worker error: ${message}`);
        },
      },
    );

    try {
      const result = await withTimeout(
        worker.recognize(imageBuffer),
        config.imageFallback.timeoutMs,
        'image OCR',
      );
      const text = normalizeOcrText(result?.data?.text || '');
      if (!text) {
        return {
          ok: false,
          error: 'tesseract OCR did not return any text',
        };
      }
      return {
        ok: true,
        text,
      };
    } finally {
      await worker.terminate().catch(() => {});
    }
  } catch (err: any) {
    return {
      ok: false,
      error: err?.message || 'failed to run OCR with tesseract.js',
    };
  }
}

async function getOcrResult(block: ImageFileBlock): Promise<ImageOcrResult> {
  const cacheKey = `${config.imageFallback.provider}:${config.imageFallback.tesseractLangs}:${block.fileId}`;
  let pending = ocrCache.get(cacheKey);
  if (!pending) {
    pending = transcribeImageWithTesseract(block);
    ocrCache.set(cacheKey, pending);
  }
  return pending;
}

export async function buildImageFallbackContext(
  block: ImageFileBlock,
  reason: string,
): Promise<string> {
  const ocr = await getOcrResult(block);
  const fileRef = `<FileRef id="${block.fileId}"/>`;
  const lines = [
    `[Image fallback] ${reason} The platform ran a local OCR pass with the default tesseract.js pipeline before building this request.`,
    `Original image FileRef: ${fileRef}`,
  ];

  if (ocr.ok && ocr.text) {
    lines.push(`Reference OCR text (may be incomplete or incorrect): ${ocr.text}`);
  } else {
    lines.push(`Reference OCR unavailable: ${ocr.error || 'unknown error'}.`);
  }

  lines.push(`If you need the original image for another tool, pass the same FileRef ${fileRef} to that tool's fileRef parameter.`);
  return lines.join('\n');
}
