import { join, resolve } from "node:path";
import { repoRoot } from "./repo-paths.js";

export type RepoSubprojectName = "cli-anything";

const REPO_SUBPROJECT_ROOT = join(repoRoot, "subprojects");

const REPO_SUBPROJECT_DIRS: Record<RepoSubprojectName, string> = {
  "cli-anything": "cli-anything",
};

export function resolveRepoSubprojectRoot(name: RepoSubprojectName) {
  return resolve(REPO_SUBPROJECT_ROOT, REPO_SUBPROJECT_DIRS[name]);
}

export function resolveRepoSubprojectPath(
  name: RepoSubprojectName,
  ...segments: string[]
) {
  return join(resolveRepoSubprojectRoot(name), ...segments);
}
