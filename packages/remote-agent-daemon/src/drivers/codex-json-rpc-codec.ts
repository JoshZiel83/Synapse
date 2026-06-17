import { z } from "zod"

const codexJsonRpcErrorSchema = z.object({
  message: z.string().optional(),
})

const codexJsonRpcLineSchema = z
  .object({
    jsonrpc: z.string().optional(),
    id: z.union([z.string(), z.number()]).optional(),
    method: z.string().optional(),
    params: z.unknown().optional(),
    result: z.unknown().optional(),
    error: codexJsonRpcErrorSchema.optional(),
  })
  .passthrough()

export type CodexJsonRpcLine = z.infer<typeof codexJsonRpcLineSchema>

export function parseCodexJsonRpcLine(line: string): CodexJsonRpcLine | null {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return null
  }

  const parsed = codexJsonRpcLineSchema.safeParse(value)
  if (!parsed.success) return null
  return parsed.data
}
