import { closeAuthzClient, resetAuthzRelationships } from "../authz/index.js";
import { closeDatabasePool } from "./index.js";
import { resetDatabaseSchema } from "./migrate.js";
import { seedDatabase } from "./seed.js";

async function reset() {
  console.log("Starting full environment reset...");

  await resetDatabaseSchema();

  const authz = await resetAuthzRelationships();
  console.log(
    `SpiceDB reset completed (schemaUpdated=${authz.schemaUpdated}, relationshipsDeleted=${authz.relationshipsDeleted})`,
  );

  await seedDatabase();
  console.log("Database seed completed");
}

reset()
  .then(async () => {
    await Promise.all([closeAuthzClient(), closeDatabasePool()]);
    process.exit(0);
  })
  .catch(async (error) => {
    console.error("Full environment reset failed:", error);
    await Promise.allSettled([closeAuthzClient(), closeDatabasePool()]);
    process.exit(1);
  });
