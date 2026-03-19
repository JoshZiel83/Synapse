import { closeDatabasePool } from "./index.js";
import { seedBuiltinMcpPlugins } from "../../modules/mcp-plugins/service.js";

async function main() {
  console.log("Seeding builtin MCP plugins...");
  await seedBuiltinMcpPlugins();
  console.log("Builtin MCP plugin seed completed");
}

main()
  .then(async () => {
    await closeDatabasePool();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error("Builtin MCP plugin seed failed:", error);
    await closeDatabasePool().catch(() => undefined);
    process.exit(1);
  });
