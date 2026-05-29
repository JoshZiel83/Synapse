// Commandline policy: discriminated union over executor.
//
// The wire form (snake_case) is what gets embedded in signed envelopes and
// stored in the API's grant_specs JSON column. The normalized form
// (camelCase) is what every TS consumer reads. parseCommandlinePolicyFromWire
// and serializeCommandlinePolicyToWire are the only places that translate
// between them — both projection (envelope construction) and auto-retry
// must use them to avoid double-write drift.

import { z } from "zod"

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

const ShellPolicyWireSchema = z.object({
  executor: z.enum(SHELL_EXECUTORS),
  command_match_type: z.enum(SHELL_MATCH_TYPES),
  command_text: z.string().optional(),
  working_directory: z.string().optional(),
  allow_bundled_toolchain: z.boolean().optional(),
  allowed_env: z.array(z.string()).optional(),
})

// ─────────────────────────── exec_file branch ────────────────────────────────

const EXEC_FILE_MATCH_TYPES = [
  "argv_exact",
  "argv_prefix",
  "argv_exact_preapproved",
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

const ExecFilePolicyWireSchema = z.object({
  executor: z.literal("exec_file"),
  command_match_type: z.enum(EXEC_FILE_MATCH_TYPES),
  program: z.string(),
  argv_prefix: z.array(z.string()).optional(),
  working_directory: z.string().optional(),
  allow_bundled_toolchain: z.boolean().optional(),
  allowed_env: z.array(z.string()).optional(),
})

// ─────────────────────────── unions + types ──────────────────────────────────

export const CommandlinePolicySchema = z.discriminatedUnion("executor", [
  ShellPolicyCamelSchema,
  ExecFilePolicyCamelSchema,
])
export type CommandlinePolicy = z.infer<typeof CommandlinePolicySchema>

export const WireCommandlinePolicySchema = z.discriminatedUnion("executor", [
  ShellPolicyWireSchema,
  ExecFilePolicyWireSchema,
])
export type WireCommandlinePolicy = z.infer<typeof WireCommandlinePolicySchema>

// Discriminator-aware aliases that consumers find useful when narrowing.
export type CommandlineShellPolicy = Extract<
  CommandlinePolicy,
  { executor: "bash" | "powershell" }
>
export type CommandlineExecFilePolicy = Extract<
  CommandlinePolicy,
  { executor: "exec_file" }
>

// Cross-check against the canonical enum lists (constants/enums.ts) so a
// drift between the two halves of the union fails at build time. We do this
// by asserting type-level equality with helper triggers.
const _ALL_EXECUTORS_CHECK: ReadonlyArray<CommandlinePolicy["executor"]> =
  RUNTIME_AUTHORIZATION_COMMAND_EXECUTORS
const _ALL_MATCH_TYPES_CHECK: ReadonlyArray<
  CommandlinePolicy["commandMatchType"]
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
  return {
    executor: parsed.executor,
    commandMatchType: parsed.command_match_type,
    commandText: parsed.command_text,
    workingDirectory: parsed.working_directory,
    allowBundledToolchain: parsed.allow_bundled_toolchain,
    allowedEnv: parsed.allowed_env,
  }
}
