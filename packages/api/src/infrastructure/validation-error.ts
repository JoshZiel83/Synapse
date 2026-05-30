import { z } from "zod"

/**
 * Unified shape for Zod validation-failure `details` in API error responses.
 *
 * zod 4 removed the `ZodError#flatten()` / `#format()` instance methods in
 * favour of the top-level `z.treeifyError()` helper, which returns a nested
 * tree mirroring the schema shape:
 *
 *   { errors: string[], properties?: { <key>: { errors, properties? } } }
 *
 * All controllers route their `parsed.error` through this single function so
 * the validation `details` payload has one consistent structure across the
 * API and can be changed in exactly one place. This is a deliberate breaking
 * change versus the old zod 3 `flatten()` `{ formErrors, fieldErrors }` shape;
 * clients must read the tree form.
 */
export function formatValidationDetails(error: z.ZodError): unknown {
  return z.treeifyError(error)
}
