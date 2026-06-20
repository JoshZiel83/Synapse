import { isAbsolute } from "node:path"
import { existsSync, readFileSync } from "node:fs"
import yaml from "js-yaml"
import {
  getModelVendorDefinition,
  getProviderKindForVendor,
  isKnownModelVendor,
  validateModelProviderConfig,
} from "@synapse/shared"
import { resolveRepoPath } from "../../../config/repo-paths.js"
import { config } from "../../../config/index.js"
import { createLogger } from "../../logger/index.js"
import {
  addModelItem,
  createModelGroup,
  getModelGroup,
  ModelGroupError,
  listPlatformModelGroupsForImport,
} from "../../../modules/model-groups/service.js"
import {
  modelGroupsFileSchema,
  modelGroupsResolvedSchema,
  type ModelGroupsFile,
  type ModelGroupsFileGroup,
} from "../../../modules/model-groups/schemas.js"
import { interpolateEnv } from "./interpolate.js"

const log = createLogger("seed-model-groups")

// Default location of the declarative config file when MODEL_GROUPS_CONFIG_PATH
// is unset. Repo-root relative (resolved via import.meta.url, NOT process.cwd())
// so it is stable under tsx (src) and dist, inside and outside the container.
const DEFAULT_CONFIG_RELATIVE_PATH = "packages/api/config/model-groups.yaml"

/** Resolve the effective config path: env override (abs or repo-relative) else default. */
export function resolveModelGroupsConfigPath(override?: string): string {
  const raw = override ?? config.modelGroups.configPath
  if (raw && raw.trim() !== "") {
    return isAbsolute(raw) ? raw : resolveRepoPath(raw)
  }
  return resolveRepoPath(DEFAULT_CONFIG_RELATIVE_PATH)
}

export class ModelGroupsConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ModelGroupsConfigError"
  }
}

export interface LoadOptions {
  /** Explicit path override (else env / default). */
  configPath?: string
  /**
   * What to do when the config file does not exist:
   *   - "throw"  (default, CLI): hard error — the operator asked to import.
   *   - "skip"   (rebuild hook): return { doc: null } and log a warning.
   */
  onMissingFile?: "throw" | "skip"
}

/**
 * Read + validate + interpolate the model-groups config WITHOUT writing to the
 * database. Pure-ish (only reads the file + env). Suitable as a pre-flight check
 * before a destructive rebuild. Throws ModelGroupsConfigError on any problem
 * (bad YAML, schema violation, missing env var, semantic incompatibility).
 *
 * Returns { doc: null } only when the file is absent AND onMissingFile==="skip".
 */
export async function loadModelGroupsConfig(
  opts: LoadOptions = {}
): Promise<{ doc: ModelGroupsFile | null; path: string }> {
  const onMissingFile = opts.onMissingFile ?? "throw"
  const path = resolveModelGroupsConfigPath(opts.configPath)

  if (!existsSync(path)) {
    if (onMissingFile === "skip") {
      log.warn(
        `No model-groups config at ${path}; skipping model import. ` +
          "Chat will fail until a platform model group is configured " +
          "(copy packages/api/config/model-groups.yaml.example, fill the " +
          "referenced ${ENV} vars, then re-run db:seed:model-groups)."
      )
      return { doc: null, path }
    }
    throw new ModelGroupsConfigError(
      `Model-groups config file not found: ${path}\n` +
        "Copy packages/api/config/model-groups.yaml.example to that path and " +
        "fill in the referenced ${ENV} variables, or set MODEL_GROUPS_CONFIG_PATH."
    )
  }

  let rawText: string
  try {
    rawText = readFileSync(path, "utf8")
  } catch (err) {
    throw new ModelGroupsConfigError(
      `Failed to read model-groups config at ${path}: ${(err as Error).message}`
    )
  }

  let parsed: unknown
  try {
    parsed = yaml.load(rawText)
  } catch (err) {
    throw new ModelGroupsConfigError(
      `Invalid YAML in model-groups config at ${path}: ${(err as Error).message}`
    )
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ModelGroupsConfigError(
      `Model-groups config at ${path} must be a YAML mapping with a "version" and "groups".`
    )
  }

  // Pass 1 — validate the RAW document. apiKey must be a ${VAR} reference here,
  // so a plaintext secret committed to the file fails BEFORE interpolation.
  const rawResult = modelGroupsFileSchema.safeParse(parsed)
  if (!rawResult.success) {
    throw new ModelGroupsConfigError(
      formatZodIssues(`Invalid model-groups config at ${path}`, rawResult.error)
    )
  }

  // Interpolate ${ENV} across all string leaves. Missing/empty vars => fail loud.
  const { value: interpolated, missing } = interpolateEnv(rawResult.data)
  if (missing.length > 0) {
    throw new ModelGroupsConfigError(
      `Model-groups config at ${path} references unset environment variable(s):\n${missing
        .map((name) => `  - ${name}`)
        .join("\n")}`
    )
  }

  // Pass 2 — validate the RESOLVED document. apiKey is now the real value
  // (non-empty string); re-run uniqueness/length/strictness in case an ${ENV}
  // substitution produced an empty, oversized, or duplicate value.
  const resolvedResult = modelGroupsResolvedSchema.safeParse(interpolated)
  if (!resolvedResult.success) {
    throw new ModelGroupsConfigError(
      formatZodIssues(
        `Invalid model-groups config at ${path} (after \${ENV} interpolation)`,
        resolvedResult.error
      )
    )
  }

  // Semantic pre-flight: provider/engine compatibility + maxTokens ceiling. This
  // mirrors what addModelItem→assertValidModelRevisionInput would enforce at
  // write time, so a rebuild fails BEFORE dropping the schema rather than midway.
  assertSemanticallyValid(resolvedResult.data, path)

  return { doc: resolvedResult.data, path }
}

/**
 * Apply a validated config document to the database, CREATE-ONLY:
 *   - groups are matched by (owner_type='platform', name); existing groups are
 *     never modified, recreated, or revived.
 *   - a disabled (soft-deleted) match is skipped entirely (not revived).
 *   - isDefault is honored only on a FRESH database (no enabled default yet) —
 *     it never overrides an operator's UI default selection.
 *   - items are matched by displayName within the group; existing ones skipped.
 *   - DB-side duplicate names (the weak key) fail loud rather than guessing.
 *
 * NOT a single DB transaction, but writes are split into a read-only PRECHECK
 * phase and a WRITE phase. The precheck resolves every group's disposition and
 * runs the DB weak-key (duplicate display_name) guard for ALL target groups
 * BEFORE any create/add — so a detectable failure in a later group never leaves
 * an earlier group half-imported. Combined with loadModelGroupsConfig's pre-flight
 * (provider/engine/maxTokens caught before the destructive db:rebuild drop), the
 * only failures that can still occur mid-write are transient infra errors. Those
 * are safe to recover from: the import is idempotent — re-running
 * `db:seed:model-groups` completes a partial import (create-only dedupe skips
 * what already landed). If db:rebuild reports an import error after the seed,
 * just re-run `npm run db:seed:model-groups`.
 */
export async function applyModelGroups(doc: ModelGroupsFile): Promise<{
  createdGroups: number
  createdItems: number
  skipped: number
}> {
  const existing = await listPlatformModelGroupsForImport()
  // Collision detection considers ENABLED groups only. A platform name can be
  // legitimately reused by an enabled group after an older same-name row was
  // soft-deleted (disabled) in the UI — that stale disabled row must NOT abort
  // the whole import. A true duplicate (two ENABLED rows of one name — not
  // reachable via the importer, but possible via concurrent UI / manual SQL)
  // still fails loud, since name is the weak dedupe key and we won't guess.
  const enabledExisting = existing.filter((g) => g.is_enabled)
  assertNoDuplicateNames(
    enabledExisting.map((g) => g.name),
    "enabled platform model groups in the database"
  )

  // Resolve each name to its ENABLED row when one exists, else the disabled row
  // (so the "exists but is disabled — skipping" branch still fires when ONLY a
  // disabled row remains).
  const byName = new Map<string, (typeof existing)[number]>()
  for (const g of existing) {
    const prev = byName.get(g.name)
    if (!prev || (!prev.is_enabled && g.is_enabled)) byName.set(g.name, g)
  }
  const hasEnabledDefault = enabledExisting.some((g) => g.is_default)

  // ----- PHASE 1: read-only precheck (no writes) -----------------------------
  // Resolve every group's disposition and pre-fetch the existing items of all
  // ENABLED target groups, running the DB-side duplicate-name (weak-key) guard
  // up front. This guarantees that any detectable failure (a DB weak-key dup in
  // group B) is raised BEFORE we create group A — so a failed apply never leaves
  // a partial import for an error we could have caught. (Config-validity errors —
  // provider/engine/maxTokens — are already pre-checked in loadModelGroupsConfig
  // before any write, including before the destructive db:rebuild drop.)
  type GroupPlan =
    | { kind: "skip-disabled"; group: ModelGroupsFileGroup }
    | {
        kind: "existing"
        group: ModelGroupsFileGroup
        groupId: string
        isDefault: boolean
        seen: Set<string>
      }
    | { kind: "create"; group: ModelGroupsFileGroup; applyDefault: boolean }

  const plans: GroupPlan[] = []
  // hasEnabledDefault may flip true as the file contributes a new default; track
  // it across the precheck so at most one file group claims the fresh default.
  let willHaveEnabledDefault = hasEnabledDefault

  for (const group of doc.groups) {
    const match = byName.get(group.name)
    if (match && !match.is_enabled) {
      plans.push({ kind: "skip-disabled", group })
      continue
    }
    if (match) {
      const full = await getModelGroup(match.id)
      const existingItemNames = full.items.map((item) => item.displayName || "")
      assertNoDuplicateNames(
        existingItemNames,
        `items in group "${group.name}"`
      )
      plans.push({
        kind: "existing",
        group,
        groupId: match.id,
        isDefault: match.is_default,
        seen: new Set(existingItemNames),
      })
      continue
    }
    const wantDefault = group.isDefault === true
    const applyDefault = wantDefault && !willHaveEnabledDefault
    if (applyDefault) willHaveEnabledDefault = true
    plans.push({ kind: "create", group, applyDefault })
  }

  // ----- PHASE 2: write -------------------------------------------------------
  let createdGroups = 0
  let createdItems = 0
  let skipped = 0

  for (const plan of plans) {
    const group = plan.group
    let groupId: string
    let seen: Set<string>

    if (plan.kind === "skip-disabled") {
      // Create-only: a disabled (soft-deleted) match is NOT revived — skip its
      // items too (restore via the UI). Count the file's declared items so the
      // summary reflects what was not imported.
      log.warn(
        `group "${group.name}" exists but is disabled — skipping ${group.items.length} item(s) (restore in the UI).`
      )
      skipped += group.items.length
      continue
    }

    if (plan.kind === "existing") {
      // Enabled match: leave the group as-is. If the file (re)asserts isDefault
      // on an already-imported group, say so explicitly — create-only import
      // never changes an existing group's default (mirrors the new-group path).
      if (group.isDefault === true && !plan.isDefault) {
        log.warn(
          `group "${group.name}" already exists — isDefault ignored ` +
            "(create-only import never changes an existing group's default; " +
            "set the default in the UI)."
        )
      } else {
        log.info(`group "${group.name}" already exists — leaving unchanged.`)
      }
      skipped++
      groupId = plan.groupId
      seen = plan.seen
    } else {
      const wantDefault = group.isDefault === true
      if (wantDefault && !plan.applyDefault) {
        log.warn(
          `group "${group.name}": isDefault ignored — a platform default already ` +
            "exists; set the default in the UI."
        )
      }
      const created = await createModelGroup({
        ownerType: "platform",
        name: group.name,
        description: group.description,
        routingStrategy: group.routingStrategy,
        attemptPolicy: group.attemptPolicy,
        isDefault: plan.applyDefault,
      })
      groupId = created.id
      createdGroups++
      log.info(
        `created group "${group.name}"${plan.applyDefault ? " (default)" : ""}.`
      )
      // A freshly created group has no items; nothing pre-seen.
      seen = new Set<string>()
    }

    // Item-level create-only dedupe by displayName (the `seen` set includes
    // disabled items for existing groups so a soft-deleted item is not revived).
    for (const item of group.items) {
      if (seen.has(item.displayName)) {
        log.info(
          `  item "${item.displayName}" already in "${group.name}" — skipping.`
        )
        skipped++
        continue
      }
      try {
        await addModelItem(groupId, {
          displayName: item.displayName,
          priority: item.priority,
          weight: item.weight,
          providerKind:
            item.providerKind || getProviderKindForVendor(item.vendor),
          vendor: item.vendor,
          apiKey: item.apiKey,
          baseUrl: item.baseUrl,
          modelName: item.modelName,
          maxOutputTokens: item.maxOutputTokens,
          capabilityTags: item.capabilityTags,
          features: item.features,
          providerOptions: item.providerOptions,
          requestTimeoutMs: item.requestTimeoutMs,
          maxRetries: item.maxRetries,
        })
      } catch (err) {
        const detail =
          err instanceof ModelGroupError ? err.message : String(err)
        throw new ModelGroupsConfigError(
          `Failed to add item "${item.displayName}" to group "${group.name}": ${detail}`
        )
      }
      seen.add(item.displayName)
      createdItems++
      log.info(`  created item "${item.displayName}" in "${group.name}".`)
    }
  }

  return { createdGroups, createdItems, skipped }
}

/** Convenience: load (throw on missing) + apply. Used by the CLI. */
export async function importModelGroups(opts: LoadOptions = {}): Promise<{
  createdGroups: number
  createdItems: number
  skipped: number
}> {
  const { doc } = await loadModelGroupsConfig({
    onMissingFile: "throw",
    ...opts,
  })
  // onMissingFile:"throw" guarantees doc is non-null here.
  return applyModelGroups(doc as ModelGroupsFile)
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

function formatZodIssues(
  prefix: string,
  error: { issues: Array<{ path: PropertyKey[]; message: string }> }
): string {
  const lines = error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "(root)"
    return `  - ${path}: ${issue.message}`
  })
  return `${prefix}:\n${lines.join("\n")}`
}

function assertNoDuplicateNames(names: string[], context: string): void {
  const seen = new Set<string>()
  const dupes = new Set<string>()
  for (const name of names) {
    if (seen.has(name)) dupes.add(name)
    seen.add(name)
  }
  if (dupes.size > 0) {
    throw new ModelGroupsConfigError(
      `Duplicate name(s) among ${context}: ${[...dupes]
        .map((d) => `"${d}"`)
        .join(", ")}. Name is the dedupe key for import; resolve the ` +
        "duplication manually before importing."
    )
  }
}

/**
 * Validate vendor + provider-kind compatibility and maxOutputTokens ceilings
 * using the SAME rules the service layer applies at write time. Aggregates ALL
 * issues across the document into one loud error.
 */
function assertSemanticallyValid(doc: ModelGroupsFile, path: string): void {
  const issues: string[] = []

  for (const group of doc.groups) {
    for (const item of group.items) {
      const vendorDef = getModelVendorDefinition(item.vendor)
      if (!vendorDef || !isKnownModelVendor(item.vendor)) {
        // vendorSchema already refines this, but guard defensively.
        issues.push(
          `group "${group.name}" / item "${item.displayName}": unknown model vendor "${item.vendor}".`
        )
        continue
      }

      // If an explicit providerKind is given, it must match the vendor's kind
      // (the vendor catalog is the source of truth for which SDK factory serves
      // a vendor; a mismatch is a config error).
      if (
        item.providerKind &&
        item.providerKind !== getProviderKindForVendor(item.vendor)
      ) {
        issues.push(
          `group "${group.name}" / item "${item.displayName}": providerKind "${item.providerKind}" ` +
            `does not match vendor "${item.vendor}" (expected "${getProviderKindForVendor(item.vendor)}").`
        )
        continue
      }

      const configIssues = validateModelProviderConfig({
        vendor: item.vendor,
        modelName: item.modelName,
        maxOutputTokens: item.maxOutputTokens,
      })
      for (const issue of configIssues) {
        issues.push(
          `group "${group.name}" / item "${item.displayName}": ${issue.message}`
        )
      }
    }
  }

  if (issues.length > 0) {
    throw new ModelGroupsConfigError(
      `Model-groups config at ${path} has invalid model configuration:\n${issues
        .map((i) => `  - ${i}`)
        .join("\n")}`
    )
  }
}
