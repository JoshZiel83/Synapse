// scripts/codegen/runtime-policies.ts
//
// Reads the Zod policy schemas from `packages/shared/src/access/policies/`
// and emits the matching Go struct file at
// `relay/internal/runtimeauth/policies_gen.go`. The output path keeps the
// historical `relay/` directory because the Go module is still named
// `github.com/PekingSpades/Synapse/relay` — renaming the module is a
// separate PR (touches every import in the Go tree + sidecars + CI).
//
// We deliberately chose a direct TS->Go emitter over the longer
// zod -> json-schema -> go-jsonschema chain. Reasons:
//   1. No new external Go tool dependency (the toolchain stays pure-Node).
//   2. The policy shape is small (5 structs, ~16 fields) so hand-templated
//      Go is more readable than what go-jsonschema produces.
//   3. We need plain `string` typed enum fields so the matcher functions in
//      policies.go can call strings.ToLower/TrimSpace on them. go-jsonschema
//      would emit typed enum aliases which would require either a manual
//      conversion step or a fork of the matcher logic.
//
// Re-run after editing any *.ts under packages/shared/src/access/policies/.
// `npm run codegen:verify` will fail in CI if the generated file is stale.

import { writeFileSync, mkdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod"

import {
  FilesystemPolicySchema,
  CUAPolicySchema,
  BrowserPolicySchema,
  CommandlinePolicySchema,
  GrantPolicySchema,
} from "../../packages/shared/src/access/policies/index.js"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const repoRoot = resolve(__dirname, "..", "..")

interface FieldSpec {
  /** Go field name (PascalCase). */
  goName: string
  /** JSON tag name (camelCase, matches the wire). */
  jsonName: string
  /** Resolved Go type, e.g. `string`, `[]string`, `*FilesystemPolicy`. */
  goType: string
  /** When true the JSON tag gets `,omitempty`. */
  omitEmpty: boolean
}

interface StructSpec {
  name: string
  fields: FieldSpec[]
}

/**
 * Inspect a Zod schema object and return its underlying ZodObject shape plus
 * a flag for optional. Zod wraps optional fields in ZodOptional; the *_def*
 * shape varies by zod version, so we unwrap defensively.
 */
function unwrap(schema: z.ZodTypeAny): {
  inner: z.ZodTypeAny
  optional: boolean
} {
  let optional = false
  let current: z.ZodTypeAny = schema
  // Unwrap any number of nesting layers (Optional/Nullable/Default).
  // In practice the policy schemas only use Optional, but be defensive.
  while (true) {
    const def = (current as { _def?: { typeName?: string } })._def
    if (!def || !def.typeName) break
    if (def.typeName === "ZodOptional" || def.typeName === "ZodNullable") {
      optional = true
      current = (current as unknown as { unwrap: () => z.ZodTypeAny }).unwrap()
      continue
    }
    break
  }
  return { inner: current, optional }
}

function camelToPascal(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1)
}

/**
 * Convention overrides for field names that don't follow naive camelToPascal
 * (mostly initialisms). Keeps the generated names byte-identical to the
 * hand-written ones being deleted.
 */
const GO_FIELD_NAME_OVERRIDES: Record<string, string> = {
  cua: "CUA",
}

function goFieldName(jsonName: string): string {
  return GO_FIELD_NAME_OVERRIDES[jsonName] ?? camelToPascal(jsonName)
}

/**
 * Map a Zod leaf type to its Go equivalent. Pointer-to-struct is decided by
 * the caller based on optionality, not by this function.
 */
function zodLeafToGo(schema: z.ZodTypeAny): string {
  const def = (schema as { _def?: { typeName?: string } })._def
  const typeName = def?.typeName
  switch (typeName) {
    case "ZodString":
    case "ZodEnum":
    case "ZodNativeEnum":
      return "string"
    case "ZodArray": {
      const element = (schema as unknown as { element: z.ZodTypeAny }).element
      return `[]${zodLeafToGo(element)}`
    }
    case "ZodObject":
      throw new Error(
        "zodLeafToGo received a ZodObject — caller must resolve struct refs by identity"
      )
    default:
      throw new Error(`Unsupported zod type for codegen: ${typeName}`)
  }
}

/**
 * Walk a ZodObject and produce the FieldSpec list. `structRefs` lets the
 * top-level (GrantPolicy) reference sibling structs by name rather than
 * inlining them.
 */
function fieldsOf(
  schema: z.ZodObject<z.ZodRawShape>,
  structRefs: Map<z.ZodTypeAny, string>
): FieldSpec[] {
  const shape = schema.shape
  const out: FieldSpec[] = []
  for (const [jsonName, raw] of Object.entries(shape)) {
    const { inner, optional } = unwrap(raw)
    const refName = structRefs.get(inner)
    let goType: string
    if (refName) {
      goType = `*${refName}`
    } else {
      goType = zodLeafToGo(inner)
    }
    out.push({
      goName: goFieldName(jsonName),
      jsonName,
      goType,
      omitEmpty: optional,
    })
  }
  return out
}

function renderStruct(spec: StructSpec): string {
  // First pass: figure out max width of go field name + go type so the columns
  // line up the way gofmt would format them.
  let nameWidth = 0
  let typeWidth = 0
  for (const f of spec.fields) {
    if (f.goName.length > nameWidth) nameWidth = f.goName.length
    if (f.goType.length > typeWidth) typeWidth = f.goType.length
  }
  const lines: string[] = []
  lines.push(`type ${spec.name} struct {`)
  for (const f of spec.fields) {
    const tag = f.omitEmpty
      ? `\`json:"${f.jsonName},omitempty"\``
      : `\`json:"${f.jsonName}"\``
    const namePadded = f.goName.padEnd(nameWidth, " ")
    const typePadded = f.goType.padEnd(typeWidth, " ")
    lines.push(`\t${namePadded} ${typePadded} ${tag}`)
  }
  lines.push("}")
  return lines.join("\n")
}

function main(): void {
  // The order of structs matters for readability: leaves first, then the
  // aggregate GrantPolicy that references them. The Go side also reads more
  // naturally top-down.
  const structRefs = new Map<z.ZodTypeAny, string>()
  structRefs.set(FilesystemPolicySchema, "FilesystemPolicy")
  structRefs.set(CUAPolicySchema, "CUAPolicy")
  structRefs.set(BrowserPolicySchema, "BrowserPolicy")
  structRefs.set(CommandlinePolicySchema, "CommandlinePolicy")

  const structs: StructSpec[] = [
    {
      name: "FilesystemPolicy",
      fields: fieldsOf(FilesystemPolicySchema, structRefs),
    },
    {
      name: "CUAPolicy",
      fields: fieldsOf(CUAPolicySchema, structRefs),
    },
    {
      name: "BrowserPolicy",
      fields: fieldsOf(BrowserPolicySchema, structRefs),
    },
    {
      name: "CommandlinePolicy",
      fields: fieldsOf(CommandlinePolicySchema, structRefs),
    },
    {
      name: "GrantPolicy",
      fields: fieldsOf(GrantPolicySchema, structRefs),
    },
  ]

  const header = [
    "// Code generated by scripts/codegen/runtime-policies.ts; DO NOT EDIT.",
    "//",
    "// Source of truth: packages/shared/src/access/policies/*.ts (Zod schemas).",
    "// Regenerate with: npm run codegen:runtime-policies",
    "",
    "package runtimeauth",
    "",
    "",
  ].join("\n")

  const body = structs.map(renderStruct).join("\n\n")
  const outPath = resolve(
    repoRoot,
    "relay",
    "internal",
    "runtimeauth",
    "policies_gen.go"
  )
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, `${header}${body}\n`, "utf8")
  console.log(`wrote ${outPath}`)
}

main()
