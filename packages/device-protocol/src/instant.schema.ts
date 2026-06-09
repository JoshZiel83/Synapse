import { z } from "zod"

import { isIsoInstantString } from "./instant.js"

export const IsoInstantStringSchema = z.string().refine(isIsoInstantString, {
  message:
    "Expected a canonical UTC ISO-8601 instant string with millisecond precision",
})
