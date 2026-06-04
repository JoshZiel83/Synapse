import { closeDatabasePool } from "./index.js"
import { rebuildDatabaseSchema } from "./bootstrap.js"
import { seedDatabase } from "./seed.js"
import {
  applyModelGroups,
  loadModelGroupsConfig,
} from "./seed-model-groups/index.js"

async function rebuild() {
  console.log("Starting full environment rebuild...")

  // Pre-flight the model-groups config BEFORE the destructive rebuild: parse +
  // ${ENV} interpolation + schema + semantic (provider/engine, maxTokens). A
  // bad/missing-env/incompatible config fails loud here so we never drop the
  // schema and then discover the model config is broken. Missing file => skip
  // gracefully (a fresh demo DB just has no models until one is configured).
  const { doc } = await loadModelGroupsConfig({ onMissingFile: "skip" })

  await rebuildDatabaseSchema()

  await seedDatabase()
  console.log("Database seed completed")

  if (doc) {
    const result = await applyModelGroups(doc)
    console.log(
      `Model groups imported: +${result.createdGroups} group(s), ` +
        `+${result.createdItems} item(s), ${result.skipped} skipped.`
    )
  }
}

rebuild()
  .then(async () => {
    await closeDatabasePool()
    process.exit(0)
  })
  .catch(async (error) => {
    console.error("Full environment rebuild failed:", error)
    await Promise.allSettled([closeDatabasePool()])
    process.exit(1)
  })
