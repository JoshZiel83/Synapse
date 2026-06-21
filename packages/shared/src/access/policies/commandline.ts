// Commandline policy: discriminated union over executor.
//
// The wire form (snake_case) is owned by @synapse/device-protocol because it
// gets embedded in signed envelopes and stored in the API's grant_specs JSON
// column. This module owns the normalized camelCase app/runtime shape plus the
// only translator pair between the two shapes.

import { z } from "zod"

import {
  RuntimeCommandlinePolicySchema,
  type RuntimeCommandlinePolicy,
} from "@synapse/device-protocol/schemas"

import {
  RUNTIME_AUTHORIZATION_COMMAND_EXECUTORS,
  RUNTIME_AUTHORIZATION_COMMAND_MATCH_TYPES,
} from "../../constants/enums.js"

// ─────────────────────────── shell branch (bash | powershell) ────────────────

const SHELL_EXECUTORS = ["bash", "powershell"] as const
const SHELL_MATCH_TYPES = ["exact", "prefix", "tool"] as const

const ShellPolicyCamelSchema = z.object({
  executor: z.enum(SHELL_EXECUTORS),
  commandMatchType: z.enum(SHELL_MATCH_TYPES),
  commandText: z.string().optional(),
  workingDirectory: z.string().optional(),
  allowBundledToolchain: z.boolean().optional(),
  allowedEnv: z.array(z.string()).optional(),
})

// ─────────────────────────── exec_file branch ────────────────────────────────

const EXEC_FILE_MATCH_TYPES = [
  "argv_exact",
  "argv_prefix",
  "argv_exact_preapproved",
  // program_only: authorize a CLI-Anything entry_point with ANY argv. Restricted
  // server-side at grant-mint to programs in the device's availableClis. Plan §5.C.
  "program_only",
] as const

const ExecFilePolicyCamelSchema = z.object({
  executor: z.literal("exec_file"),
  commandMatchType: z.enum(EXEC_FILE_MATCH_TYPES),
  program: z.string(),
  argvPrefix: z.array(z.string()).optional(),
  workingDirectory: z.string().optional(),
  allowBundledToolchain: z.boolean().optional(),
  allowedEnv: z.array(z.string()).optional(),
})

// ─────────────────────────── sandbox branch ──────────────────────────────────
// "Any command inside a bwrap jail" — no command/argv matcher. The grant covers
// every command whose working directory resolves within the sandbox mount
// points; isolation is the boundary, not a command whitelist. Carries only an
// optional workingDirectory (a narrower sub-mount cap) and allowedEnv.

const SandboxPolicyCamelSchema = z.object({
  executor: z.literal("sandbox"),
  workingDirectory: z.string().optional(),
  allowedEnv: z.array(z.string()).optional(),
})

// ─────────────────────────── unions + types ──────────────────────────────────

export const CommandlinePolicySchema = z.discriminatedUnion("executor", [
  ShellPolicyCamelSchema,
  ExecFilePolicyCamelSchema,
  SandboxPolicyCamelSchema,
])
export type CommandlinePolicy = z.infer<typeof CommandlinePolicySchema>

export const WireCommandlinePolicySchema = RuntimeCommandlinePolicySchema
export type WireCommandlinePolicy = RuntimeCommandlinePolicy

// Discriminator-aware aliases that consumers find useful when narrowing.
export type CommandlineShellPolicy = Extract<
  CommandlinePolicy,
  { executor: "bash" | "powershell" }
>
export type CommandlineExecFilePolicy = Extract<
  CommandlinePolicy,
  { executor: "exec_file" }
>
export type CommandlineSandboxPolicy = Extract<
  CommandlinePolicy,
  { executor: "sandbox" }
>

// Cross-check against the canonical enum lists (constants/enums.ts) so a
// drift between the two halves of the union fails at build time. We do this
// by asserting type-level equality with helper triggers.
const _ALL_EXECUTORS_CHECK: ReadonlyArray<CommandlinePolicy["executor"]> =
  RUNTIME_AUTHORIZATION_COMMAND_EXECUTORS
// Only the matcher-bearing branches carry commandMatchType; sandbox has none.
const _ALL_MATCH_TYPES_CHECK: ReadonlyArray<
  (CommandlineShellPolicy | CommandlineExecFilePolicy)["commandMatchType"]
> = RUNTIME_AUTHORIZATION_COMMAND_MATCH_TYPES
void _ALL_EXECUTORS_CHECK
void _ALL_MATCH_TYPES_CHECK

// ─────────────────────────── serializer / parser ─────────────────────────────

/**
 * Convert a normalized camelCase commandline policy into its snake_case wire
 * form for embedding in signed envelopes / persisting via grant_specs JSON.
 * The single canonical translator — projection + auto-retry + device
 * runtime all call this so the field set can never drift between sites.
 */
export function serializeCommandlinePolicyToWire(
  policy: CommandlinePolicy
): WireCommandlinePolicy {
  if (policy.executor === "exec_file") {
    return {
      executor: "exec_file",
      command_match_type: policy.commandMatchType,
      program: policy.program,
      argv_prefix: policy.argvPrefix,
      working_directory: policy.workingDirectory,
      allow_bundled_toolchain: policy.allowBundledToolchain,
      allowed_env: policy.allowedEnv,
    }
  }
  if (policy.executor === "sandbox") {
    return {
      executor: "sandbox",
      working_directory: policy.workingDirectory,
      allowed_env: policy.allowedEnv,
    }
  }
  return {
    executor: policy.executor,
    command_match_type: policy.commandMatchType,
    command_text: policy.commandText,
    working_directory: policy.workingDirectory,
    allow_bundled_toolchain: policy.allowBundledToolchain,
    allowed_env: policy.allowedEnv,
  }
}

/**
 * Inverse of serializeCommandlinePolicyToWire — accepts unknown so device-
 * runtime envelope parsing can use it on opaque JSON. Throws via zod if the
 * input doesn't match the wire schema.
 */
export function parseCommandlinePolicyFromWire(
  wire: unknown
): CommandlinePolicy {
  const parsed = WireCommandlinePolicySchema.parse(wire)
  if (parsed.executor === "exec_file") {
    return {
      executor: "exec_file",
      commandMatchType: parsed.command_match_type,
      program: parsed.program,
      argvPrefix: parsed.argv_prefix,
      workingDirectory: parsed.working_directory,
      allowBundledToolchain: parsed.allow_bundled_toolchain,
      allowedEnv: parsed.allowed_env,
    }
  }
  if (parsed.executor === "sandbox") {
    return {
      executor: "sandbox",
      workingDirectory: parsed.working_directory,
      allowedEnv: parsed.allowed_env,
    }
  }
  return {
    executor: parsed.executor,
    commandMatchType: parsed.command_match_type,
    commandText: parsed.command_text,
    workingDirectory: parsed.working_directory,
    allowBundledToolchain: parsed.allow_bundled_toolchain,
    allowedEnv: parsed.allowed_env,
  }
}
