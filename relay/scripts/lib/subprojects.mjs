import { resolve, join } from 'node:path'
import { stat } from 'node:fs/promises'

const SUBPROJECT_DIRS = {
  'cli-anything': 'cli-anything',
  'lark-cli': 'lark-cli',
  'dingtalk-workspace-cli': 'dingtalk-workspace-cli',
  'wecom-cli': 'wecom-cli',
  'notion-skills': 'notion-skills',
  'xiaohongshu-cli': 'xiaohongshu-cli',
  'bilibili-cli': 'bilibili-cli',
  'twitter-cli': 'twitter-cli',
  'discord-cli': 'discord-cli',
  'tg-cli': 'tg-cli',
}

export function resolveSubprojectRoot(repoRoot, name) {
  const dirName = SUBPROJECT_DIRS[name]
  if (!dirName) {
    throw new Error(`unknown subproject ${name}`)
  }
  return resolve(repoRoot, 'subprojects', dirName)
}

export async function resolveRequiredSubprojectRoot(repoRoot, name) {
  const root = resolveSubprojectRoot(repoRoot, name)
  try {
    const info = await stat(root)
    if (!info.isDirectory()) {
      throw new Error(`subproject ${name} is not a directory`)
    }
  } catch (error) {
    throw new Error(`required subproject ${name} is missing at ${join('subprojects', SUBPROJECT_DIRS[name])}; run git submodule update --init --recursive`)
  }
  return root
}
