import 'dotenv/config';

export const config = {
  port: parseInt(process.env.PORT || '3001'),
  host: process.env.HOST || '0.0.0.0',
  nodeEnv: process.env.NODE_ENV || 'development',
  database: {
    url: process.env.DATABASE_URL || 'postgresql://synapse:password@localhost:5432/synapse',
  },
  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
  },
  jwt: {
    secret: process.env.JWT_SECRET || 'dev-secret',
    refreshSecret: process.env.JWT_REFRESH_SECRET || 'dev-refresh-secret',
    accessExpiry: '15m',
    refreshExpiry: '7d',
  },
  ai: {
    provider: process.env.AI_PROVIDER || 'anthropic',
    apiKey: process.env.AI_API_KEY || process.env.ANTHROPIC_API_KEY || '',
    baseUrl: process.env.AI_BASE_URL || process.env.ANTHROPIC_BASE_URL || '',
    model: process.env.AI_MODEL || '',
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
} as const;
