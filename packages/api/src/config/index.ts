// Load .env FIRST (before the logger or this schema read process.env). This is
// a side-effect import and is intentionally placed above the others.
import "../infrastructure/env-bootstrap.js"
import { z } from "zod"

import { createLogger } from "../infrastructure/logger/index.js"

const log = createLogger("config")

/**
 * Validated environment schema.
 *
 * Every value the app reads from process.env goes through here so that:
 *   - numbers are real numbers in sane ranges (a typo'd PORT=abc fails at
 *     startup instead of becoming NaN deep in the request path),
 *   - defaults live in exactly one place,
 *   - a misconfiguration is reported as one aggregated, readable error.
 *
 * Defaults are preserved exactly from the previous hand-rolled config so this
 * is a behaviour-preserving change — we validate and coerce, we do not newly
 * require values that used to be optional.
 *
 * `withDefault(schema, def)` reproduces the old `process.env.X || "def"`
 * semantics precisely: a MISSING *or EMPTY* var falls back to the default
 * before coercion+validation (a bare zod .default()/.prefault() would let an
 * empty string through to coercion and turn "" into NaN/0).
 */
function withDefault<T extends z.ZodType>(schema: T, def: string) {
  return z.preprocess((v) => (v === undefined || v === "" ? def : v), schema)
}

const port = z.coerce.number().int().min(1).max(65535)
const positiveInt = z.coerce.number().int().positive()
const nonNegativeInt = z.coerce.number().int().min(0)
const unitFloat = z.coerce.number().min(0).max(1)
const positiveFloat = z.coerce.number().positive()

/**
 * An optional positive int that treats a MISSING *or EMPTY* var as "unset"
 * (undefined) rather than coercing "" → 0 → validation failure. Matches the
 * old `process.env.X ? parseInt(X) : fallback` semantics for optional knobs.
 */
function optionalPositiveInt() {
  return z.preprocess(
    (v) => (v === undefined || v === "" ? undefined : v),
    positiveInt.optional()
  )
}

const envSchema = z
  .object({
    PORT: withDefault(port, "3001"),
    HOST: withDefault(z.string().min(1), "0.0.0.0"),
    // Not an enum: deployments use values beyond development/production/test
    // (e.g. "staging"), and rejecting those would block startup. Consumers that
    // care about a specific mode compare the string themselves.
    NODE_ENV: withDefault(z.string().min(1), "development"),

    APP_BASE_URL: z.string().optional(),
    NEXT_PUBLIC_APP_URL: z.string().optional(),
    NEXT_PUBLIC_SITE_URL: z.string().optional(),

    PUBLIC_NPM_REGISTRY_URL: withDefault(z.string(), ""),

    DATABASE_URL: withDefault(
      z.string().min(1),
      "postgresql://synapse:password@localhost:5432/synapse"
    ),
    REDIS_URL: withDefault(z.string().min(1), "redis://localhost:6379"),

    REALTIME_OUTBOX_BATCH_SIZE: withDefault(positiveInt, "100"),
    REALTIME_OUTBOX_POLL_MS: withDefault(positiveInt, "500"),
    REALTIME_OUTBOX_RETENTION_HOURS: withDefault(nonNegativeInt, "24"),
    REALTIME_OUTBOX_GC_INTERVAL_MS: withDefault(positiveInt, "60000"),
    REALTIME_OUTBOX_PROCESSING_TIMEOUT_MS: withDefault(positiveInt, "30000"),

    // Realtime streaming ASR (语音识别): the /ws/asr WebSocket dictation gateway.
    // ASR_PROVIDER selects the provider via modules/asr/registry.ts. Default
    // resolves to "none" => realtime dictation is disabled (the null provider
    // emits a clean asr.error), matching the OCR_PROVIDER / TRANSCRIPTION_PROVIDER
    // opt-in convention. DISTINCT from TRANSCRIPTION_PROVIDER above (batch/file).
    // NOTE: existing deploys that set VOLCENGINE_ASR_* must now ALSO set
    // ASR_PROVIDER=volcengine — the pre-abstraction default was "volcengine". An
    // explicit-but-uncredentialed volcengine still soft-fails per session (no boot
    // gate), so this only changes the default, never crashes boot.
    ASR_PROVIDER: z.string().optional(),
    VOLCENGINE_ASR_APP_ID: withDefault(z.string(), ""),
    VOLCENGINE_ASR_ACCESS_TOKEN: withDefault(z.string(), ""),
    VOLCENGINE_ASR_SECRET_KEY: withDefault(z.string(), ""),
    VOLCENGINE_ASR_RESOURCE_ID: withDefault(
      z.string().min(1),
      "volc.seedasr.sauc.duration"
    ),
    VOLCENGINE_ASR_WS_URL: withDefault(
      z.string().min(1),
      "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async"
    ),
    VOLCENGINE_ASR_MAX_CONCURRENCY: withDefault(positiveInt, "3"),
    VOLCENGINE_ASR_CONNECT_TIMEOUT_MS: withDefault(positiveInt, "10000"),
    VOLCENGINE_ASR_IDLE_TIMEOUT_MS: withDefault(positiveInt, "15000"),

    // sherpa-stream provider → the self-hosted streaming sherpa-onnx sidecar
    // (sidecars/sherpa-asr-streaming). WebSocket URL, NO auth (localhost /
    // compose-network). Selected via ASR_PROVIDER=sherpa-stream; the superRefine
    // gate below requires the URL for an explicit selection.
    REALTIME_ASR_SHERPA_URL: withDefault(z.string(), ""),
    REALTIME_ASR_SHERPA_CONNECT_TIMEOUT_MS: withDefault(positiveInt, "10000"),
    REALTIME_ASR_SHERPA_IDLE_TIMEOUT_MS: withDefault(positiveInt, "15000"),
    REALTIME_ASR_SHERPA_MAX_CONCURRENCY: withDefault(positiveInt, "4"),

    IM_RUNTIME_MANAGER_ENABLED: z.string().optional(),

    SKILL_GITHUB_RAW_PROXY_PREFIXES: z.string().optional(),
    SKILL_CLAWHUB_DOWNLOAD_PROXY_ORIGINS: z.string().optional(),

    // Optional override for the declarative model-groups config file location.
    // Absolute paths are used as-is; relative paths resolve against the repo
    // root (NOT process.cwd()). Unset => the importer falls back to the repo's
    // packages/api/config/model-groups.yaml. The default is computed in the
    // importer (which can reach repo-paths), not here.
    MODEL_GROUPS_CONFIG_PATH: z.string().optional(),

    // Batch/file speech-to-text: the api bundles NO ASR engine. TRANSCRIPTION_PROVIDER
    // selects an out-of-process provider (the sherpa-asr sidecar or, later, a
    // cloud vendor). Default resolves to "none" => audio transcription is skipped
    // (the AI audio-fallback degrades to "reference transcript unavailable", it
    // does not fail). AUDIO_FALLBACK_PROVIDER is honoured as a DEPRECATED alias
    // (TRANSCRIPTION_PROVIDER wins); its old default value "sherpa-onnx" maps to
    // "sherpa". This is DISTINCT from ASR_PROVIDER above (realtime WS dictation).
    TRANSCRIPTION_PROVIDER: z.string().optional(),
    AUDIO_FALLBACK_PROVIDER: z.string().optional(),
    // Short best-effort budget for the transcription call on the outbound-LLM
    // path (audio fallback). Larger than OCR's 4000: speech recognition is slower.
    TRANSCRIPTION_INLINE_DEADLINE_MS: withDefault(positiveInt, "8000"),
    // sherpa provider → sherpa-asr sidecar (sherpa-onnx offline recognizer).
    TRANSCRIPTION_SHERPA_URL: withDefault(z.string(), ""),
    TRANSCRIPTION_SHERPA_TIMEOUT_MS: withDefault(positiveInt, "30000"),
    // whisper provider → whisper sidecar (faster-whisper / CTranslate2). Whisper
    // on CPU is slower than SenseVoice, so a larger default request timeout. The
    // model SIZE is baked into the sidecar image; TRANSCRIPTION_WHISPER_MODEL is a
    // provenance/cache-key LABEL that must match the baked size (like PPOCR_TIER).
    TRANSCRIPTION_WHISPER_URL: withDefault(z.string(), ""),
    TRANSCRIPTION_WHISPER_TIMEOUT_MS: withDefault(positiveInt, "60000"),
    TRANSCRIPTION_WHISPER_MODEL: withDefault(z.string().min(1), "small"),

    // OCR: the api bundles NO OCR engine. OCR_PROVIDER selects an
    // out-of-process provider (a sidecar or, later, a cloud vendor). Default
    // resolves to "none" => image OCR is skipped (not failed). The deprecated
    // IMAGE_FALLBACK_PROVIDER is honoured as an alias (OCR_PROVIDER wins).
    OCR_PROVIDER: z.string().optional(),
    IMAGE_FALLBACK_PROVIDER: z.string().optional(),
    // Short best-effort budget for the OCR call on the outbound-LLM path
    // (image fallback), independent of the parse-pipeline timeout below.
    OCR_INLINE_DEADLINE_MS: withDefault(positiveInt, "4000"),
    // tesseract provider → tesseract sidecar (native tesseract-ocr).
    TESSERACT_URL: withDefault(z.string(), ""),
    TESSERACT_LANGS: withDefault(z.string().min(1), "eng"),
    TESSERACT_TIMEOUT_MS: withDefault(positiveInt, "20000"),
    // ppocr provider → PP-OCRv6 sidecar (wired in Phase 2).
    PPOCR_URL: withDefault(z.string(), ""),
    PPOCR_TIER: withDefault(z.enum(["tiny", "small"]), "small"),
    PPOCR_TIMEOUT_MS: withDefault(positiveInt, "20000"),

    MEMORY_RECALL_LIMIT: withDefault(positiveInt, "6"),
    MEMORY_SEARCH_CANDIDATE_LIMIT: withDefault(positiveInt, "40"),
    MEMORY_RECALL_TOP_K: optionalPositiveInt(),
    MEMORY_INDEX_QUEUE_CONCURRENCY: withDefault(positiveInt, "2"),
    MEMORY_MMR_LAMBDA: withDefault(unitFloat, "0.8"),
    MEMORY_MMR_CANDIDATE_MULTIPLIER: withDefault(positiveInt, "4"),
    MEMORY_SUMMARY_DECAY_HALF_LIFE_DAYS: withDefault(positiveFloat, "30"),
    MEMORY_SUMMARY_DECAY_FLOOR: withDefault(unitFloat, "0.35"),

    // ===== Embedding (text → dense vector) =====
    // The api bundles NO embedding engine. EMBEDDING_PROVIDER selects an
    // out-of-process provider: the local bge-m3 sidecar, or a cloud/self-host
    // vendor via the generic openai-compatible adapter (OpenAI / DashScope-compat /
    // Zhipu / SiliconFlow / TEI / Ollama / vLLM). Default resolves to "none" =>
    // semantic memory indexing is disabled and recall degrades to lexical-only (NOT
    // an error). Serves memory today + intelligent-retrieval later. The compose
    // production profile sets this to "local" + starts the embed sidecar.
    EMBEDDING_PROVIDER: z.string().optional(),
    // Deployment-wide vector width. MUST equal the pgvector column typmod (the boot
    // guard asserts it) AND a width the active provider can emit. Default 1024 =
    // bge-m3 native + DashScope-v3 / Cohere-v3 / Jina-v3 / SiliconFlow-bge-m3.
    EMBEDDING_DIMENSION: withDefault(positiveInt, "1024"),
    EMBEDDING_BATCH_SIZE: withDefault(positiveInt, "12"),
    EMBEDDING_QUERY_CACHE_TTL_SEC: withDefault(nonNegativeInt, "86400"),
    // local sidecar (bge-m3). URL required when EMBEDDING_PROVIDER=local. The model
    // LABEL must match the baked sidecar model (provenance + cache key + the "one
    // embedding space" identity, so a cloud serving the same model+dim is compatible).
    EMBEDDING_LOCAL_URL: withDefault(z.string(), ""),
    EMBEDDING_LOCAL_MODEL: withDefault(z.string().min(1), "bge-m3"),
    EMBEDDING_LOCAL_TIMEOUT_MS: withDefault(positiveInt, "30000"),
    // openai-compatible cloud/self-host. Selecting it sends memory text (query +
    // every indexed passage) to EMBEDDING_OPENAI_BASE_URL — a PII-egress event, so
    // the boot gate requires https:// and warns which host receives the data.
    EMBEDDING_OPENAI_BASE_URL: withDefault(z.string(), ""),
    EMBEDDING_OPENAI_API_KEY: withDefault(z.string(), ""),
    EMBEDDING_OPENAI_MODEL: withDefault(z.string(), ""),
    // input_type → per-vendor request field. "none" (symmetric — bge-m3, and the
    // OpenAI-compat endpoints of DashScope/Zhipu/SiliconFlow, which ignore an
    // asymmetric role field) or "jina-task" (Jina honors a top-level `task`).
    EMBEDDING_OPENAI_INPUT_ROLE_MODE: withDefault(
      z.enum(["none", "jina-task"]),
      "none"
    ),
    // "true" => send `dimensions` (only for MRL models: DashScope v3/v4, Jina v3,
    // Zhipu embedding-3, OpenAI v3). Sending it to a non-MRL model 400s/ignores it.
    EMBEDDING_OPENAI_SUPPORTS_DIMENSIONS: z.string().optional(),
    // Per-request cap the facade splits larger batches to (DashScope compat ≈ 10,
    // Gemini-compat = 1). 0 => no cap.
    EMBEDDING_OPENAI_MAX_BATCH: withDefault(nonNegativeInt, "0"),
    EMBEDDING_OPENAI_TIMEOUT_MS: withDefault(positiveInt, "30000"),

    // ===== Document extraction (files → text) =====
    // The api bundles NO document-parsing engine (the 5th sibling of the OCR /
    // embedding / transcription / realtime-ASR provider abstractions).
    // DOCUMENT_EXTRACTION_PROVIDER selects an out-of-process provider: the local
    // Apache Tika sidecar, or a cloud/API vendor (TextIn xParse). Default resolves
    // to "none" => PDF + office parsing is SKIPPED (a LOUD boot warning fires, and
    // each affected upload records a skip — never a crash). The compose production
    // profile sets this to "local" + starts the docextract sidecar. NOTE: this is
    // a clean-break replacement of the old in-process `pdf-parse` — a bare deploy
    // that upgrades the image WITHOUT setting this + a sidecar loses PDF parsing.
    DOCUMENT_EXTRACTION_PROVIDER: z.string().optional(),
    // local Apache Tika sidecar. URL required when provider=local (superRefine).
    DOCEXTRACT_URL: withDefault(z.string(), ""),
    DOCEXTRACT_TIMEOUT_MS: withDefault(positiveInt, "60000"),
    // Provenance/cache-key LABEL; MUST match the TIKA_VERSION baked into the
    // sidecar image (single-knob lockstep, like WHISPER_MODEL / PPOCR_TIER — the
    // compose file drives both from one value). Bumping the baked engine without
    // this label would poison the facade cache + mislabel file_parse_runs.
    DOCEXTRACT_ENGINE_VERSION: withDefault(z.string().min(1), "tika-3.0.0"),
    // Output flavor for the local Tika provider: "text" (plaintext) or "markdown"
    // (the Phase-2 rich tier — Tika XHTML → markdown, headings/lists/tables kept).
    // Folded into the provenance label so switching it invalidates the parse cache.
    DOCEXTRACT_OUTPUT_FORMAT: withDefault(z.enum(["text", "markdown"]), "text"),
    // TextIn / 合合 xParse cloud provider (dual static-header auth). Selecting it
    // sends document bytes off-box (egress) — the boot gate requires BOTH secrets.
    DOCEXTRACT_TEXTIN_APP_ID: withDefault(z.string(), ""),
    DOCEXTRACT_TEXTIN_SECRET_CODE: withDefault(z.string(), ""),
    DOCEXTRACT_TEXTIN_BASE_URL: withDefault(
      z.string(),
      "https://api.textin.com"
    ),
    DOCEXTRACT_TEXTIN_TIMEOUT_MS: withDefault(positiveInt, "60000"),
    // LlamaParse (LlamaCloud) — the ASYNC reference cloud vendor (Bearer auth,
    // submit→poll). Selecting it sends document bytes off-box; the gate requires
    // the API key. The poll cadence + deadline bound the submit-and-release loop.
    DOCEXTRACT_LLAMAPARSE_API_KEY: withDefault(z.string(), ""),
    DOCEXTRACT_LLAMAPARSE_BASE_URL: withDefault(
      z.string(),
      "https://api.cloud.llamaindex.ai"
    ),
    DOCEXTRACT_LLAMAPARSE_TIMEOUT_MS: withDefault(positiveInt, "30000"),
    // How often to re-poll a submitted async job, and the wall-clock deadline after
    // which a still-pending job is failed (submit-and-release, not in-handler poll).
    DOCEXTRACT_ASYNC_POLL_INTERVAL_MS: withDefault(positiveInt, "5000"),
    DOCEXTRACT_ASYNC_DEADLINE_MS: withDefault(positiveInt, "600000"),

    PLATFORM_ADMIN_EMAILS: withDefault(z.string(), ""),

    // ===== Better Auth =====
    // Session signing secret. Falls back through AUTH_SECRET / APP_SECRET so a
    // single deployment secret can cover both BA and the legacy crypto layer.
    // All three are optional here (empty allowed) and resolved to the first
    // non-empty value below; production missing-secret is enforced in
    // superRefine (NOT via `??`, which would accept an empty string).
    BETTER_AUTH_SECRET: z.string().optional(),
    AUTH_SECRET: z.string().optional(),
    // Browser-facing public origin BA mounts under (redirect_uri + state/session
    // cookies bind to this). MUST be the origin users actually hit (proxies
    // /api/v1 -> API), not the internal API origin. Falls back to app.baseUrl.
    AUTH_TRUSTED_ORIGINS: withDefault(z.string(), ""),

    // ===== Feishu / Lark OAuth (genericOAuth provider) =====
    FEISHU_APP_ID: withDefault(z.string(), ""),
    FEISHU_APP_SECRET: withDefault(z.string(), ""),
    // "true" => Lark international (open.larksuite.com); else Feishu (open.feishu.cn).
    FEISHU_INTL: z.string().optional(),

    LOG_LEVEL: z.string().optional(),

    // Secret-at-rest master passphrase (crypto/index.ts). Required in production
    // so a missing key fails at STARTUP — not on the first encrypt/decrypt.
    MCP_ENCRYPTION_KEY: z.string().optional(),
    APP_SECRET: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    if (
      env.NODE_ENV === "production" &&
      !env.MCP_ENCRYPTION_KEY &&
      !env.APP_SECRET
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["MCP_ENCRYPTION_KEY"],
        message:
          "MCP_ENCRYPTION_KEY (or APP_SECRET) is required in production to " +
          "encrypt sensitive plugin/IM credentials at rest",
      })
    }
    // Better Auth needs a stable signing secret in production. Resolve the same
    // first-non-empty fallback used below; "" must NOT count as a valid secret.
    if (env.NODE_ENV === "production") {
      const authSecret = firstNonEmpty([
        env.BETTER_AUTH_SECRET,
        env.AUTH_SECRET,
        env.APP_SECRET,
      ])
      if (!authSecret) {
        ctx.addIssue({
          code: "custom",
          path: ["BETTER_AUTH_SECRET"],
          message:
            "BETTER_AUTH_SECRET (or AUTH_SECRET / APP_SECRET) is required in " +
            "production to sign auth sessions",
        })
      }
    }
    // A selected OCR provider must have its sidecar URL, or the api would run
    // "configured" but every OCR call would fail at request time.
    const ocrProvider = resolveOcrProviderName(env)
    if (ocrProvider === "tesseract" && !env.TESSERACT_URL) {
      ctx.addIssue({
        code: "custom",
        path: ["TESSERACT_URL"],
        message:
          "TESSERACT_URL is required when OCR_PROVIDER=tesseract (the api runs no in-process OCR engine)",
      })
    }
    if (ocrProvider === "ppocr" && !env.PPOCR_URL) {
      ctx.addIssue({
        code: "custom",
        path: ["PPOCR_URL"],
        message: "PPOCR_URL is required when OCR_PROVIDER=ppocr",
      })
    }
    // A selected document-extraction provider must have its sidecar URL / vendor
    // credentials, or the api would boot "configured" but every PDF/office parse
    // would fail at request time. (An UNconfigured provider — "none" — is a valid
    // opt-out that only skips document parsing, so it is not gated here.)
    const docProvider = resolveDocumentExtractionProviderName(env)
    if (docProvider === "local" && !env.DOCEXTRACT_URL?.trim()) {
      ctx.addIssue({
        code: "custom",
        path: ["DOCEXTRACT_URL"],
        message:
          "DOCEXTRACT_URL is required when DOCUMENT_EXTRACTION_PROVIDER=local (the api runs no in-process document engine)",
      })
    }
    if (
      docProvider === "textin" &&
      (!env.DOCEXTRACT_TEXTIN_APP_ID?.trim() ||
        !env.DOCEXTRACT_TEXTIN_SECRET_CODE?.trim())
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["DOCEXTRACT_TEXTIN_APP_ID"],
        message:
          "DOCEXTRACT_TEXTIN_APP_ID and DOCEXTRACT_TEXTIN_SECRET_CODE are required when DOCUMENT_EXTRACTION_PROVIDER=textin",
      })
    }
    if (
      docProvider === "llamaparse" &&
      !env.DOCEXTRACT_LLAMAPARSE_API_KEY?.trim()
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["DOCEXTRACT_LLAMAPARSE_API_KEY"],
        message:
          "DOCEXTRACT_LLAMAPARSE_API_KEY is required when DOCUMENT_EXTRACTION_PROVIDER=llamaparse",
      })
    }
    // A selected transcription provider must have its sidecar URL, or the api
    // would run "configured" but every transcription call would fail at request
    // time. The deprecated AUDIO_FALLBACK_PROVIDER alias degrades to "none" when
    // it can't reach a sidecar (see resolveTranscriptionProviderName), so a stale
    // legacy value never trips this gate — only an explicit opt-in does.
    const transcriptionProvider = resolveTranscriptionProviderName(env)
    // Trim to match resolveTranscriptionProviderName: a whitespace-only URL must
    // trip this fail-fast gate, not boot "configured" and then silently cache a
    // terminal URL-parse failure per sha256 at request time.
    if (
      transcriptionProvider === "sherpa" &&
      !env.TRANSCRIPTION_SHERPA_URL?.trim()
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["TRANSCRIPTION_SHERPA_URL"],
        message:
          "TRANSCRIPTION_SHERPA_URL is required when TRANSCRIPTION_PROVIDER=sherpa (the api runs no in-process ASR engine)",
      })
    }
    if (
      transcriptionProvider === "whisper" &&
      !env.TRANSCRIPTION_WHISPER_URL?.trim()
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["TRANSCRIPTION_WHISPER_URL"],
        message:
          "TRANSCRIPTION_WHISPER_URL is required when TRANSCRIPTION_PROVIDER=whisper (the api runs no in-process ASR engine)",
      })
    }
    // A selected sherpa-stream realtime provider must have its sidecar URL, or the
    // api would boot "configured" but every /ws/asr session would fail to connect.
    // (Unlike Volcengine — a cloud vendor that soft-fails per session via
    // isConfigured() — the local sidecar URL is a hard boot requirement when
    // explicitly selected, mirroring the batch sherpa/whisper gates above.)
    if (
      resolveAsrProviderName(env) === "sherpa-stream" &&
      !env.REALTIME_ASR_SHERPA_URL?.trim()
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["REALTIME_ASR_SHERPA_URL"],
        message:
          "REALTIME_ASR_SHERPA_URL is required when ASR_PROVIDER=sherpa-stream (the api runs no in-process ASR engine)",
      })
    }
    // A selected embedding provider must have its reach-env, or the api would boot
    // "configured" and then fail every embed at request time (silently lexical).
    const embeddingProvider = resolveEmbeddingProviderName(env)
    if (embeddingProvider === "local" && !env.EMBEDDING_LOCAL_URL?.trim()) {
      ctx.addIssue({
        code: "custom",
        path: ["EMBEDDING_LOCAL_URL"],
        message:
          "EMBEDDING_LOCAL_URL is required when EMBEDDING_PROVIDER=local (the api runs no in-process embedding engine)",
      })
    }
    if (embeddingProvider === "openai-compatible") {
      const baseUrl = env.EMBEDDING_OPENAI_BASE_URL?.trim()
      if (!baseUrl) {
        ctx.addIssue({
          code: "custom",
          path: ["EMBEDDING_OPENAI_BASE_URL"],
          message:
            "EMBEDDING_OPENAI_BASE_URL is required when EMBEDDING_PROVIDER=openai-compatible",
        })
      } else if (!/^https:\/\//i.test(baseUrl)) {
        // PII-egress guard: memory text (query + every indexed passage) is sent to
        // this host, so require TLS. (SSRF is out of scope by construction — this
        // is global operator env, never tenant-supplied.)
        ctx.addIssue({
          code: "custom",
          path: ["EMBEDDING_OPENAI_BASE_URL"],
          message:
            "EMBEDDING_OPENAI_BASE_URL must be https:// — memory text is sent to this host for embedding (PII egress)",
        })
      }
      if (!env.EMBEDDING_OPENAI_API_KEY?.trim()) {
        ctx.addIssue({
          code: "custom",
          path: ["EMBEDDING_OPENAI_API_KEY"],
          message:
            "EMBEDDING_OPENAI_API_KEY is required when EMBEDDING_PROVIDER=openai-compatible",
        })
      }
      if (!env.EMBEDDING_OPENAI_MODEL?.trim()) {
        ctx.addIssue({
          code: "custom",
          path: ["EMBEDDING_OPENAI_MODEL"],
          message:
            "EMBEDDING_OPENAI_MODEL is required when EMBEDDING_PROVIDER=openai-compatible",
        })
      }
    }
  })

/**
 * First trim-non-empty string, or undefined. Used for secret fallback so a
 * present-but-empty env var (e.g. `BETTER_AUTH_SECRET=`) correctly falls through
 * to the next candidate instead of being treated as a valid empty secret (which
 * `a ?? b ?? c` would do).
 */
function firstNonEmpty(
  values: ReadonlyArray<string | undefined>
): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim()
    if (trimmed) return trimmed
  }
  return undefined
}

/** Resolve the active OCR provider name: OCR_PROVIDER wins, then the deprecated
 *  IMAGE_FALLBACK_PROVIDER alias, else "none". One place so the superRefine gate
 *  and the config assembly can't diverge on the alias-precedence policy. */
function resolveOcrProviderName(env: {
  OCR_PROVIDER?: string
  IMAGE_FALLBACK_PROVIDER?: string
}): string {
  return (
    firstNonEmpty([env.OCR_PROVIDER, env.IMAGE_FALLBACK_PROVIDER]) ?? "none"
  )
}

/** Resolve the active batch-transcription provider name. TRANSCRIPTION_PROVIDER
 *  wins; the deprecated AUDIO_FALLBACK_PROVIDER is an alias (its legacy default
 *  value "sherpa-onnx" normalizes to "sherpa"); else "none". A sherpa selection
 *  arriving ONLY via the legacy alias with no reachable sidecar URL degrades to
 *  "none" (the old in-process engine is deleted) rather than crashing boot — the
 *  alias was the old default, so a stale value must fail-open. An EXPLICIT
 *  TRANSCRIPTION_PROVIDER=sherpa with no URL is still gated (fails fast) in
 *  superRefine. One place so the gate and the config assembly can't diverge. */
function resolveTranscriptionProviderName(env: {
  TRANSCRIPTION_PROVIDER?: string
  AUDIO_FALLBACK_PROVIDER?: string
  TRANSCRIPTION_SHERPA_URL?: string
}): string {
  const normalize = (value: string | undefined): string | undefined => {
    const trimmed = value?.trim()
    if (!trimmed) return undefined
    return trimmed === "sherpa-onnx" ? "sherpa" : trimmed
  }
  const explicit = normalize(env.TRANSCRIPTION_PROVIDER)
  if (explicit) return explicit
  const legacy = normalize(env.AUDIO_FALLBACK_PROVIDER)
  if (!legacy) return "none"
  if (legacy === "sherpa" && !env.TRANSCRIPTION_SHERPA_URL?.trim())
    return "none"
  return legacy
}

/** Resolve the active realtime-ASR provider name: ASR_PROVIDER wins, else "none"
 *  (opt-in, like OCR/transcription). No deprecated alias exists; centralized in
 *  one place so the config assembly — and any future gate/alias — can't diverge.
 *  Unlike the batch sidecars, an unconfigured realtime provider degrades per
 *  session (not at boot), so there is no ASR superRefine gate. */
function resolveAsrProviderName(env: { ASR_PROVIDER?: string }): string {
  return firstNonEmpty([env.ASR_PROVIDER]) ?? "none"
}

/** Resolve the active embedding provider name: EMBEDDING_PROVIDER, else "none"
 *  (opt-in, like OCR/transcription/ASR — no deprecated alias exists). Centralized
 *  so the superRefine gate and the config assembly can't diverge. */
function resolveEmbeddingProviderName(env: {
  EMBEDDING_PROVIDER?: string
}): string {
  return firstNonEmpty([env.EMBEDDING_PROVIDER]) ?? "none"
}

/** Resolve the active document-extraction provider name: DOCUMENT_EXTRACTION_PROVIDER,
 *  else "none" (opt-in, like OCR/embedding — no deprecated alias exists). Centralized
 *  so the superRefine gate and the config assembly can't diverge. */
function resolveDocumentExtractionProviderName(env: {
  DOCUMENT_EXTRACTION_PROVIDER?: string
}): string {
  return firstNonEmpty([env.DOCUMENT_EXTRACTION_PROVIDER]) ?? "none"
}

function loadEnvOrExit(): z.infer<typeof envSchema> {
  const parsed = envSchema.safeParse(process.env)
  if (parsed.success) return parsed.data

  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("\n")
  log.fatal(`Invalid environment configuration:\n${issues}`)
  // Configuration errors are unrecoverable — refuse to start with bad config
  // rather than limp along with NaN/undefined values deep in the request path.
  process.exit(1)
}

const env = loadEnvOrExit()

function splitList(value: string | undefined): string[] {
  return (value || "")
    .split(/[\n,]/g)
    .map((entry) => entry.trim())
    .filter(Boolean)
}

export const config = {
  port: env.PORT,
  host: env.HOST,
  nodeEnv: env.NODE_ENV,
  app: {
    baseUrl:
      env.APP_BASE_URL ||
      env.NEXT_PUBLIC_APP_URL ||
      env.NEXT_PUBLIC_SITE_URL ||
      "http://localhost:3001",
  },
  sandbox: {
    // Per-session file sandbox (device-runtime + content-addressed mounts).
    // Off by default: provisioning spawns a device-runtime child + requires the
    // fs-helper binary, so it stays opt-in until an environment is validated.
    enabled:
      (process.env.SYNAPSE_SANDBOX_ENABLED || "").toLowerCase() === "true",
  },
  remoteAgent: {
    // The npm registry URL embedded in the daemon install command shown
    // on the dashboard, AND used to render the one-click installer scripts
    // (GET /api/v1/install.{sh,ps1}). This is the EXTERNAL-reachable URL the
    // end user's machine will hit — it must NOT be an internal/publish-side
    // address (e.g. http://verdaccio:4873 inside Docker/K8s). Kept separate
    // from the publish-side NPM_REGISTRY for exactly that reason.
    //
    // Empty string: the dashboard daemon command degrades to the bare
    // `synapse-remote-agent-daemon` bin (assuming the user pre-configured
    // @synapse:registry). BUT the one-click bootstrap installer CANNOT work
    // with an empty value — it has no Node/npmrc yet — so the install routes
    // return 503 and the dashboard hides the one-click block when this is
    // empty (see modules/installer/install-command.ts + controller.ts).
    npmRegistryUrl: env.PUBLIC_NPM_REGISTRY_URL,
  },
  database: {
    url: env.DATABASE_URL,
  },
  redis: {
    url: env.REDIS_URL,
  },
  realtime: {
    outboxBatchSize: env.REALTIME_OUTBOX_BATCH_SIZE,
    outboxPollMs: env.REALTIME_OUTBOX_POLL_MS,
    // How long to keep dispatched outbox rows for ops debugging
    // before GC sweeps them. Default 24h matches the plan's
    // verification window. Set to 0 to delete-on-dispatch (no debug
    // window). 'failed' rows are NEVER GC'd regardless of retention
    // because the dispatcher still retries them — see
    // gcRealtimeEventOutbox in infrastructure/events/index.ts, which
    // delegates persistence to infrastructure/events/repo.ts.
    outboxRetentionHours: env.REALTIME_OUTBOX_RETENTION_HOURS,
    // How often the dispatcher loop runs the GC sweep. 1 minute is
    // fine — GC just trims stale rows; missing a window doesn't lose
    // events.
    outboxGcIntervalMs: env.REALTIME_OUTBOX_GC_INTERVAL_MS,
    // How long a row may sit in 'processing' before the dispatcher loop
    // treats it as abandoned (crashed mid-dispatch) and resets it to
    // 'failed' for re-claim. Must exceed worst-case publish latency.
    // Runs on the same cadence as GC. See
    // recoverStuckProcessingRealtimeOutboxEntries.
    outboxProcessingTimeoutMs: env.REALTIME_OUTBOX_PROCESSING_TIMEOUT_MS,
  },
  asr: {
    provider: resolveAsrProviderName(env),
    volcengine: {
      appId: env.VOLCENGINE_ASR_APP_ID,
      accessToken: env.VOLCENGINE_ASR_ACCESS_TOKEN,
      secretKey: env.VOLCENGINE_ASR_SECRET_KEY,
      resourceId: env.VOLCENGINE_ASR_RESOURCE_ID,
      wsUrl: env.VOLCENGINE_ASR_WS_URL,
      maxConcurrency: env.VOLCENGINE_ASR_MAX_CONCURRENCY,
      connectTimeoutMs: env.VOLCENGINE_ASR_CONNECT_TIMEOUT_MS,
      idleTimeoutMs: env.VOLCENGINE_ASR_IDLE_TIMEOUT_MS,
    },
    sherpaStream: {
      // Trimmed so a whitespace-only value is the empty string
      // isSherpaStreamConfigured() treats as unconfigured (the boot gate rejects
      // it for an explicit sherpa-stream selection).
      url: env.REALTIME_ASR_SHERPA_URL.trim(),
      connectTimeoutMs: env.REALTIME_ASR_SHERPA_CONNECT_TIMEOUT_MS,
      idleTimeoutMs: env.REALTIME_ASR_SHERPA_IDLE_TIMEOUT_MS,
      maxConcurrency: env.REALTIME_ASR_SHERPA_MAX_CONCURRENCY,
    },
  },
  im: {
    runtimeManagerEnabled: env.IM_RUNTIME_MANAGER_ENABLED !== "false",
  },
  skills: {
    import: {
      githubRawProxyPrefixes: splitList(env.SKILL_GITHUB_RAW_PROXY_PREFIXES),
      clawhubDownloadProxyOrigins: splitList(
        env.SKILL_CLAWHUB_DOWNLOAD_PROXY_ORIGINS
      ),
    },
  },
  modelGroups: {
    // Optional override for the declarative config file. undefined => importer
    // uses the repo-default path. May be absolute or repo-root-relative.
    configPath: env.MODEL_GROUPS_CONFIG_PATH,
  },
  transcription: {
    // TRANSCRIPTION_PROVIDER wins; deprecated AUDIO_FALLBACK_PROVIDER is the
    // alias (legacy value "sherpa-onnx" → "sherpa"); else "none" (audio
    // transcription is skipped).
    provider: resolveTranscriptionProviderName(env),
    inlineDeadlineMs: env.TRANSCRIPTION_INLINE_DEADLINE_MS,
    sherpa: {
      // Trimmed so a whitespace-only value is the empty string the adapter's
      // isConfigured()/`if (!url)` guard treats as unconfigured (the boot gate
      // above rejects it for an explicit sherpa selection).
      url: env.TRANSCRIPTION_SHERPA_URL.trim(),
      timeoutMs: env.TRANSCRIPTION_SHERPA_TIMEOUT_MS,
    },
    whisper: {
      url: env.TRANSCRIPTION_WHISPER_URL.trim(),
      timeoutMs: env.TRANSCRIPTION_WHISPER_TIMEOUT_MS,
      // Provenance/cache-key label; must match the model size baked into the
      // whisper sidecar image.
      model: env.TRANSCRIPTION_WHISPER_MODEL,
    },
  },
  ocr: {
    // OCR_PROVIDER wins; deprecated IMAGE_FALLBACK_PROVIDER is the alias; else
    // "none" (image OCR is skipped).
    provider: resolveOcrProviderName(env),
    inlineDeadlineMs: env.OCR_INLINE_DEADLINE_MS,
    tesseract: {
      url: env.TESSERACT_URL,
      langs: env.TESSERACT_LANGS,
      timeoutMs: env.TESSERACT_TIMEOUT_MS,
    },
    ppocr: {
      url: env.PPOCR_URL,
      tier: env.PPOCR_TIER,
      timeoutMs: env.PPOCR_TIMEOUT_MS,
    },
  },
  memory: {
    recallLimit: env.MEMORY_RECALL_LIMIT,
    searchCandidateLimit: env.MEMORY_SEARCH_CANDIDATE_LIMIT,
    topK: env.MEMORY_RECALL_TOP_K ?? env.MEMORY_RECALL_LIMIT,
    indexQueueConcurrency: env.MEMORY_INDEX_QUEUE_CONCURRENCY,
    mmrLambda: env.MEMORY_MMR_LAMBDA,
    mmrCandidateMultiplier: env.MEMORY_MMR_CANDIDATE_MULTIPLIER,
    summaryDecayHalfLifeDays: env.MEMORY_SUMMARY_DECAY_HALF_LIFE_DAYS,
    summaryDecayFloor: env.MEMORY_SUMMARY_DECAY_FLOOR,
  },
  // Text → dense vector. The api bundles NO embedding engine (env-only provider
  // selection). Consumed by memory (recall + indexing) today, intelligent-retrieval
  // later. See modules/embedding/ + docs/embedding-abstraction-layer-plan-2026-07-02.md.
  embedding: {
    provider: resolveEmbeddingProviderName(env),
    dimension: env.EMBEDDING_DIMENSION,
    batchSize: env.EMBEDDING_BATCH_SIZE,
    queryCacheTtlSec: env.EMBEDDING_QUERY_CACHE_TTL_SEC,
    local: {
      // Trimmed so a whitespace-only value is the empty string the adapter's
      // isConfigured()/`if (!url)` guard treats as unconfigured (the boot gate
      // rejects it for an explicit local selection).
      url: env.EMBEDDING_LOCAL_URL.trim(),
      model: env.EMBEDDING_LOCAL_MODEL,
      timeoutMs: env.EMBEDDING_LOCAL_TIMEOUT_MS,
    },
    openai: {
      baseUrl: env.EMBEDDING_OPENAI_BASE_URL.trim(),
      apiKey: env.EMBEDDING_OPENAI_API_KEY.trim(),
      model: env.EMBEDDING_OPENAI_MODEL.trim(),
      inputRoleMode: env.EMBEDDING_OPENAI_INPUT_ROLE_MODE,
      supportsDimensions: env.EMBEDDING_OPENAI_SUPPORTS_DIMENSIONS === "true",
      maxBatch: env.EMBEDDING_OPENAI_MAX_BATCH,
      timeoutMs: env.EMBEDDING_OPENAI_TIMEOUT_MS,
    },
  },
  // Document extraction (files → text). The api bundles NO document engine
  // (env-only provider selection). Consumed by the file-parse pipeline. See
  // modules/document-extraction/ + docs/document-extraction-abstraction-layer-plan.md.
  documentExtraction: {
    provider: resolveDocumentExtractionProviderName(env),
    local: {
      // Trimmed so a whitespace-only value is the empty string the adapter's
      // isConfigured()/`if (!url)` guard treats as unconfigured (the boot gate
      // rejects it for an explicit local selection).
      url: env.DOCEXTRACT_URL.trim(),
      timeoutMs: env.DOCEXTRACT_TIMEOUT_MS,
      engineVersion: env.DOCEXTRACT_ENGINE_VERSION,
      outputFormat: env.DOCEXTRACT_OUTPUT_FORMAT,
    },
    textin: {
      appId: env.DOCEXTRACT_TEXTIN_APP_ID.trim(),
      secretCode: env.DOCEXTRACT_TEXTIN_SECRET_CODE.trim(),
      baseUrl: env.DOCEXTRACT_TEXTIN_BASE_URL.trim(),
      timeoutMs: env.DOCEXTRACT_TEXTIN_TIMEOUT_MS,
    },
    llamaparse: {
      apiKey: env.DOCEXTRACT_LLAMAPARSE_API_KEY.trim(),
      baseUrl: env.DOCEXTRACT_LLAMAPARSE_BASE_URL.trim(),
      timeoutMs: env.DOCEXTRACT_LLAMAPARSE_TIMEOUT_MS,
    },
    // Submit-and-release poll cadence + deadline (async providers).
    async: {
      pollIntervalMs: env.DOCEXTRACT_ASYNC_POLL_INTERVAL_MS,
      deadlineMs: env.DOCEXTRACT_ASYNC_DEADLINE_MS,
    },
  },
  platform: {
    adminEmails: env.PLATFORM_ADMIN_EMAILS.split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  },
  auth: {
    // Session signing secret: first non-empty of the three candidates. In
    // development a deterministic dev secret is used so local sessions survive
    // restarts; production missing-secret is rejected at startup (superRefine).
    secret:
      firstNonEmpty([
        env.BETTER_AUTH_SECRET,
        env.AUTH_SECRET,
        env.APP_SECRET,
      ]) ?? "dev-insecure-better-auth-secret",
    // Public browser origin BA mounts under (drives OAuth redirect_uri + the
    // origin where session/state cookies land). Defaults to app.baseUrl.
    baseUrl:
      env.APP_BASE_URL ||
      env.NEXT_PUBLIC_APP_URL ||
      env.NEXT_PUBLIC_SITE_URL ||
      "http://localhost:3001",
    trustedOrigins: splitList(env.AUTH_TRUSTED_ORIGINS),
  },
  feishu: {
    appId: env.FEISHU_APP_ID,
    appSecret: env.FEISHU_APP_SECRET,
    intl: env.FEISHU_INTL === "true",
  },
} as const

// Guardrail 1 (document-extraction clean-break): the api bundles NO in-process
// document engine — it replaced the old always-on `pdf-parse`. Warn LOUDLY at
// startup (not just per-file) whenever the resolved provider is NOT a recognized,
// enabled one — which covers BOTH "none" (unset) AND a typo like
// `DOCUMENT_EXTRACTION_PROVIDER=tika` (the engine is Apache Tika but the provider
// value is "local"): the registry resolves any unknown name to the null provider
// and silently disables PDF/office parsing, so an operator who upgraded the image
// without wiring a provider + sidecar — or fat-fingered the value — notices before
// a user reports empty parses. See docs/document-extraction-abstraction-layer-plan.md.
if (
  config.documentExtraction.provider !== "local" &&
  config.documentExtraction.provider !== "textin" &&
  config.documentExtraction.provider !== "llamaparse"
) {
  log.warn(
    `document extraction is DISABLED (DOCUMENT_EXTRACTION_PROVIDER="${config.documentExtraction.provider}" is not a recognized provider) — ` +
      "PDF & office uploads will be SKIPPED, not parsed. Set " +
      "DOCUMENT_EXTRACTION_PROVIDER=local + DOCEXTRACT_URL (the Tika sidecar) or " +
      "=textin (+ credentials) to enable document parsing."
  )
}
