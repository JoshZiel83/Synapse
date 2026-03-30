import { closeAuthzClient, resetAuthzRelationships } from "../authz/index.js";
import { closeDatabasePool } from "./index.js";
import { rebuildDatabaseSchema } from "./bootstrap.js";
import { seedDatabase } from "./seed.js";

async function rebuild() {
  console.log("Starting full environment rebuild...");

  await rebuildDatabaseSchema();

  const authz = await resetAuthzRelationships();
  console.log(
    `SpiceDB reset completed (schemaUpdated=${authz.schemaUpdated}, relationshipsDeleted=${authz.relationshipsDeleted})`,
  );

  await seedDatabase();
  console.log("Database seed completed");
}

rebuild()
  .then(async () => {
    await Promise.all([closeAuthzClient(), closeDatabasePool()]);
    process.exit(0);
  })
  .catch(async (error) => {
    console.error("Full environment rebuild failed:", error);
    await Promise.allSettled([closeAuthzClient(), closeDatabasePool()]);
    process.exit(1);
  });
