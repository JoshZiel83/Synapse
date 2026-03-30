import 'dotenv/config';
import {
  getDefaultModelBaseUrl,
  getDefaultModelEngineKind,
  getDefaultModelName,
  getModelProviderDefinition,
} from '@synapse/shared';

const authzEnabled = process.env.AUTHZ_ENABLED !== 'false';

if (!authzEnabled) {
  throw new Error(
    'AUTHZ_ENABLED=false is no longer supported. Synapse now requires SpiceDB authorization to be enabled in every environment.',
  );
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
  ai: {
    provider: process.env.AI_PROVIDER || 'anthropic',
    engineKind: process.env.AI_ENGINE_KIND || getDefaultModelEngineKind(process.env.AI_PROVIDER || 'anthropic'),
    apiKey: process.env.AI_API_KEY
      || getModelProviderDefinition(process.env.AI_PROVIDER || 'anthropic')?.envApiKeyAliases
        .map((envKey: string) => process.env[envKey])
        .find((value: string | undefined) => typeof value === 'string' && value.length > 0)
      || '',
    baseUrl: process.env.AI_BASE_URL || getDefaultModelBaseUrl(process.env.AI_PROVIDER || 'anthropic'),
    model: process.env.AI_MODEL
      || process.env.MODEL_NAME
      || getDefaultModelName(
        process.env.AI_PROVIDER || 'anthropic',
        process.env.AI_ENGINE_KIND || getDefaultModelEngineKind(process.env.AI_PROVIDER || 'anthropic'),
      ),
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
    embeddings: {
      baseUrl: process.env.MEMORY_EMBEDDINGS_BASE_URL || process.env.OPENAI_BASE_URL || '',
      apiKey: process.env.MEMORY_EMBEDDINGS_API_KEY || process.env.OPENAI_API_KEY || '',
      model: process.env.MEMORY_EMBEDDINGS_MODEL || 'text-embedding-3-small',
      dimensions: parseInt(process.env.MEMORY_EMBEDDINGS_DIMENSIONS || '1536'),
      timeoutMs: parseInt(process.env.MEMORY_EMBEDDINGS_TIMEOUT_MS || '12000'),
    },
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
