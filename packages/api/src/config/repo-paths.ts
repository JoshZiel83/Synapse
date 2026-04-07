import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const apiPackageRoot = resolve(moduleDir, "../..");

export const repoRoot = resolve(apiPackageRoot, "../..");

export function resolveRepoPath(...segments: string[]) {
  return join(repoRoot, ...segments);
}
