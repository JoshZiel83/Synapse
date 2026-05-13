import { closeDatabasePool } from "./index.js"
import { rebuildDatabaseSchema } from "./bootstrap.js"
import { seedDatabase } from "./seed.js"

async function rebuild() {
  console.log("Starting full environment rebuild...")

  await rebuildDatabaseSchema()

  await seedDatabase()
  console.log("Database seed completed")
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
