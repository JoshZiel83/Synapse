import { join, resolve } from "node:path"
import { existsSync, readdirSync } from "node:fs"
import { repoRoot } from "./repo-paths.js"

export type RepoSubprojectName =
  | "cli-anything"
  | "lark-cli"
  | "dingtalk-workspace-cli"
  | "wecom-cli"
  | "notion-skills"
  | "xiaohongshu-cli"
  | "bilibili-cli"
  | "twitter-cli"
  | "discord-cli"
  | "tg-cli"

const REPO_SUBPROJECT_ROOT = join(repoRoot, "subprojects")

const REPO_SUBPROJECT_DIRS: Record<RepoSubprojectName, string> = {
  "cli-anything": "cli-anything",
  "lark-cli": "lark-cli",
  "dingtalk-workspace-cli": "dingtalk-workspace-cli",
  "wecom-cli": "wecom-cli",
  "notion-skills": "notion-skills",
  "xiaohongshu-cli": "xiaohongshu-cli",
  "bilibili-cli": "bilibili-cli",
  "twitter-cli": "twitter-cli",
  "discord-cli": "discord-cli",
  "tg-cli": "tg-cli",
}

export function resolveRepoSubprojectRoot(name: RepoSubprojectName) {
  return resolve(REPO_SUBPROJECT_ROOT, REPO_SUBPROJECT_DIRS[name])
}

export function resolveRepoSubprojectPath(
  name: RepoSubprojectName,
  ...segments: string[]
) {
  return join(resolveRepoSubprojectRoot(name), ...segments)
}

/**
 * Returns true when the given submodule directory is populated. Submodule
 * dirs always exist as a gitlink placeholder; emptiness signals the
 * submodule has not been initialized (`git submodule update --init`).
 * Tests that depend on submodule contents should skip when this returns
 * false so the suite still passes in lightweight worktrees.
 */
export function isRepoSubprojectInitialized(name: RepoSubprojectName) {
  const root = resolveRepoSubprojectRoot(name)
  return existsSync(root) && readdirSync(root).length > 0
}
