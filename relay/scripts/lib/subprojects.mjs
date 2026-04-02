import { resolve, join } from 'node:path'
import { stat } from 'node:fs/promises'

const SUBPROJECT_DIRS = {
  'cli-anything': 'cli-anything',
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
