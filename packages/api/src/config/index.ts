import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { config as loadEnv } from "dotenv";
import {
  getDefaultModelBaseUrl,
  getDefaultModelEngineKind,
  getDefaultModelName,
} from '@synapse/shared';

for (const candidate of [
  resolve(process.cwd(), ".env"),
  resolve(process.cwd(), "../../.env"),
]) {
  if (!existsSync(candidate)) continue;
  loadEnv({ path: candidate });
  break;
}

const authzEnabled = process.env.AUTHZ_ENABLED !== 'false';

if (!authzEnabled) {
  throw new Error(
    'AUTHZ_ENABLED=false is no longer supported. Synapse now requires SpiceDB authorization to be enabled in every environment.',
  );
}

const configuredAiProvider = process.env.AI_PROVIDER || '';
const configuredAiEngineKind = process.env.AI_ENGINE_KIND
  || (configuredAiProvider ? getDefaultModelEngineKind(configuredAiProvider) : '');

function readEnvList(name: string) {
  return (process.env[name] || '')
    .split(/[\n,]/g)
    .map((value) => value.trim())
    .filter(Boolean);
}

export const config = {
  port: parseInt(process.env.PORT || '3001'),
  host: process.env.HOST || '0.0.0.0',
  nodeEnv: process.env.NODE_ENV || 'development',
  app: {
    baseUrl: process.env.APP_BASE_URL || process.env.NEXT_PUBLIC_APP_URL || process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3001',
  },
  database: {
    url: process.env.DATABASE_URL || 'postgresql://synapse:password@localhost:5432/synapse',
  },
  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
  },
  realtime: {
    outboxBatchSize: parseInt(process.env.REALTIME_OUTBOX_BATCH_SIZE || '100'),
    outboxPollMs: parseInt(process.env.REALTIME_OUTBOX_POLL_MS || '500'),
  },
  asr: {
    provider: process.env.ASR_PROVIDER || 'volcengine',
    volcengine: {
      appId: process.env.VOLCENGINE_ASR_APP_ID || '',
      accessToken: process.env.VOLCENGINE_ASR_ACCESS_TOKEN || '',
      secretKey: process.env.VOLCENGINE_ASR_SECRET_KEY || '',
      resourceId: process.env.VOLCENGINE_ASR_RESOURCE_ID || 'volc.seedasr.sauc.duration',
      wsUrl:
        process.env.VOLCENGINE_ASR_WS_URL
        || 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async',
      maxConcurrency: parseInt(process.env.VOLCENGINE_ASR_MAX_CONCURRENCY || '3'),
      connectTimeoutMs: parseInt(process.env.VOLCENGINE_ASR_CONNECT_TIMEOUT_MS || '10000'),
      idleTimeoutMs: parseInt(process.env.VOLCENGINE_ASR_IDLE_TIMEOUT_MS || '15000'),
    },
  },
  im: {
    runtimeManagerEnabled:
      process.env.IM_RUNTIME_MANAGER_ENABLED !== 'false',
  },
  relay: {
    updateCosBaseUrl:
      process.env.RELAY_UPDATE_COS_BASE_URL ||
      process.env.RELAY_COS_BASE_URL ||
      '',
    updateLatestCommit:
      process.env.RELAY_UPDATE_LATEST_COMMIT ||
      process.env.RELAY_LATEST_COMMIT ||
      '',
  },
  skills: {
    import: {
      githubRawProxyPrefixes: readEnvList('SKILL_GITHUB_RAW_PROXY_PREFIXES'),
      clawhubDownloadProxyOrigins: readEnvList('SKILL_CLAWHUB_DOWNLOAD_PROXY_ORIGINS'),
    },
  },
  ai: {
    provider: configuredAiProvider,
    engineKind: configuredAiEngineKind,
    apiKey: process.env.AI_API_KEY || '',
    baseUrl: process.env.AI_BASE_URL
      || (configuredAiProvider ? getDefaultModelBaseUrl(configuredAiProvider) : ''),
    model: process.env.AI_MODEL
      || process.env.MODEL_NAME
      || (configuredAiProvider ? getDefaultModelName(configuredAiProvider, configuredAiEngineKind) : ''),
    maxTokens: parseInt(process.env.AI_MAX_TOKENS || '4096'),
  },
  audioFallback: {
    provider: process.env.AUDIO_FALLBACK_PROVIDER || 'sherpa-onnx',
    sherpaOnnxConfigJson: process.env.SHERPA_ONNX_CONFIG_JSON || '',
    timeoutMs: parseInt(process.env.SHERPA_ONNX_TIMEOUT_MS || '15000'),
  },
  imageFallback: {
    provider: process.env.IMAGE_FALLBACK_PROVIDER || 'tesseract',
    tesseractLangs: process.env.TESSERACT_LANGS || 'eng',
    tesseractLangPath: process.env.TESSERACT_LANG_PATH || '',
    tesseractCachePath: process.env.TESSERACT_CACHE_PATH || '/tmp/synapse-tesseract-cache',
    timeoutMs: parseInt(process.env.TESSERACT_TIMEOUT_MS || '20000'),
  },
  memory: {
    recallLimit: parseInt(process.env.MEMORY_RECALL_LIMIT || '6'),
    searchCandidateLimit: parseInt(process.env.MEMORY_SEARCH_CANDIDATE_LIMIT || '40'),
    topK: parseInt(process.env.MEMORY_RECALL_TOP_K || process.env.MEMORY_RECALL_LIMIT || '6'),
    modelId: process.env.MEMORY_EMBEDDING_MODEL_ID || 'Xenova/multilingual-e5-small',
    modelCacheDir: process.env.MEMORY_MODEL_CACHE_DIR || resolve(process.cwd(), 'storage/models/memory'),
    embedBatchSize: parseInt(process.env.MEMORY_EMBED_BATCH_SIZE || '12'),
    indexQueueConcurrency: parseInt(process.env.MEMORY_INDEX_QUEUE_CONCURRENCY || '2'),
    queryEmbedCacheTtlSec: parseInt(process.env.MEMORY_QUERY_EMBED_CACHE_TTL_SEC || '86400'),
    mmrLambda: parseFloat(process.env.MEMORY_MMR_LAMBDA || '0.8'),
    mmrCandidateMultiplier: parseInt(process.env.MEMORY_MMR_CANDIDATE_MULTIPLIER || '4'),
    summaryDecayHalfLifeDays: parseFloat(process.env.MEMORY_SUMMARY_DECAY_HALF_LIFE_DAYS || '30'),
    summaryDecayFloor: parseFloat(process.env.MEMORY_SUMMARY_DECAY_FLOOR || '0.35'),
    allowRuntimeModelDownload: process.env.MEMORY_ALLOW_RUNTIME_MODEL_DOWNLOAD === 'true',
  },
  authz: {
    enabled: true,
    endpoint: process.env.SPICEDB_ENDPOINT || 'localhost:50051',
    token: process.env.SPICEDB_TOKEN || 'synapse-dev-token',
    insecure: process.env.SPICEDB_INSECURE !== 'false',
    schemaPath: process.env.SPICEDB_SCHEMA_PATH || '',
    outboxBatchSize: parseInt(process.env.AUTHZ_OUTBOX_BATCH_SIZE || '100'),
    platformAdminEmails: (process.env.PLATFORM_ADMIN_EMAILS || '')
      .split(',')
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  },
} as const;
