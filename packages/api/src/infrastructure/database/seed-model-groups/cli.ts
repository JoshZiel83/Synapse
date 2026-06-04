// CLI entry point for `npm run db:seed:model-groups`.
//
// This is the ONLY file in seed-model-groups/ with top-level side effects
// (main(), closeDatabasePool, process.exit). The library (index.ts) stays pure
// so rebuild.ts can import it without triggering any of this. Mirrors the shape
// of seed-builtin-mcp-plugins.ts.
import { closeDatabasePool } from "../index.js"
import { importModelGroups } from "./index.js"

async function main() {
  console.log("Importing model groups from config...")
  const result = await importModelGroups({ onMissingFile: "throw" })
  console.log(
    `model-groups: +${result.createdGroups} group(s), ` +
      `+${result.createdItems} item(s), ${result.skipped} skipped.`
  )
}

main()
  .then(async () => {
    await closeDatabasePool()
    process.exit(0)
  })
  .catch(async (error) => {
    console.error(
      "Model groups seed failed:",
      error instanceof Error ? error.message : error
    )
    await closeDatabasePool().catch(() => undefined)
    process.exit(1)
  })
