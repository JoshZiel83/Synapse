import { mkdir } from 'node:fs/promises';
import { parentPort, workerData } from 'node:worker_threads';
import { env, pipeline } from '@huggingface/transformers';

type WorkerData = {
  modelId: string;
  modelCacheDir: string;
  allowRemoteModels: boolean;
};

type WorkerRequest =
  | {
      id: number;
      type: 'warmup';
    }
  | {
      id: number;
      type: 'embed';
      texts: string[];
      inputType: 'query' | 'passage';
    };

type WorkerResponse =
  | {
      id: number;
      ok: true;
      modelId: string;
      dimension: number;
      embeddings?: number[][];
    }
  | {
      id: number;
      ok: false;
      error: string;
    };

const {
  modelId,
  modelCacheDir,
  allowRemoteModels,
} = workerData as WorkerData;

let extractorPromise: Promise<any> | null = null;

async function getExtractor() {
  if (!extractorPromise) {
    await mkdir(modelCacheDir, { recursive: true });
    env.localModelPath = modelCacheDir;
    env.allowRemoteModels = allowRemoteModels;
    (env as any).cacheDir = modelCacheDir;
    extractorPromise = pipeline('feature-extraction', modelId, {
      dtype: 'fp32',
    });
  }
  return extractorPromise;
}

function prefixText(text: string, inputType: 'query' | 'passage') {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return `${inputType}: ${normalized}`;
}

function tensorToRows(tensor: any): number[][] {
  const dims = Array.isArray(tensor?.dims) ? tensor.dims : [];
  const data = Array.from(tensor?.data || []);
  if (dims.length === 1) {
    return [data as number[]];
  }

  const batch = Number(dims[0] || 0);
  const width = Number(dims[dims.length - 1] || 0);
  if (batch <= 0 || width <= 0) {
    return [];
  }

  const rows: number[][] = [];
  for (let index = 0; index < batch; index += 1) {
    rows.push(data.slice(index * width, (index + 1) * width) as number[]);
  }
  return rows;
}

async function embedTexts(texts: string[], inputType: 'query' | 'passage') {
  if (texts.length === 0) return [];
  const extractor = await getExtractor();
  const output = await extractor(
    texts.map((text) => prefixText(text, inputType)),
    {
      pooling: 'mean',
      normalize: true,
    },
  );
  return tensorToRows(output);
}

async function handleRequest(request: WorkerRequest): Promise<WorkerResponse> {
  if (request.type === 'warmup') {
    const embeddings = await embedTexts(['warmup'], 'passage');
    return {
      id: request.id,
      ok: true,
      modelId,
      dimension: embeddings[0]?.length || 0,
    };
  }

  const embeddings = await embedTexts(request.texts, request.inputType);
  return {
    id: request.id,
    ok: true,
    modelId,
    dimension: embeddings[0]?.length || 0,
    embeddings,
  };
}

parentPort?.on('message', async (request: WorkerRequest) => {
  try {
    const response = await handleRequest(request);
    parentPort?.postMessage(response);
  } catch (error) {
    parentPort?.postMessage({
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    } satisfies WorkerResponse);
  }
});
