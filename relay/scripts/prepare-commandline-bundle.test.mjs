import test from 'node:test'
import assert from 'node:assert/strict'

import { buildCliAnythingWrapperContent, getGitHubReleaseBinarySpec } from './prepare-commandline-bundle.mjs'

const capability = {
  command: 'cli-anything-demo',
  module: 'demo',
  entryPointTarget: 'cli_anything.demo.demo_cli:main',
}

test('buildCliAnythingWrapperContent uses Windows path separator for PYTHONPATH', () => {
  const content = buildCliAnythingWrapperContent('py/python.exe', capability, 'windows-amd64')

  assert.match(content, /export PYTHONPATH="\$\{ROOT_DIR\}\/sp;\$\{PYTHONPATH\}"/)
  assert.doesNotMatch(content, /export PYTHONPATH="\$\{ROOT_DIR\}\/sp:\$\{PYTHONPATH\}"/)
})

test('buildCliAnythingWrapperContent uses POSIX path separator for PYTHONPATH', () => {
  const content = buildCliAnythingWrapperContent('py/bin/python3', capability, 'linux-amd64')

  assert.match(content, /export PYTHONPATH="\$\{ROOT_DIR\}\/sp:\$\{PYTHONPATH\}"/)
  assert.doesNotMatch(content, /export PYTHONPATH="\$\{ROOT_DIR\}\/sp;\$\{PYTHONPATH\}"/)
})

test('getGitHubReleaseBinarySpec honors explicit release archive names', () => {
  const spec = getGitHubReleaseBinarySpec('windows-amd64', {
    repository: 'cli/cli',
    releaseVersion: 'v2.89.0',
    binaryName: 'gh',
    archiveFileNames: {
      'windows-amd64': 'gh_2.89.0_windows_amd64.zip',
    },
  })

  assert.equal(spec.archiveFileName, 'gh_2.89.0_windows_amd64.zip')
  assert.equal(spec.archiveType, 'zip')
  assert.match(spec.url, /\/cli\/cli\/releases\/download\/v2\.89\.0\/gh_2\.89\.0_windows_amd64\.zip$/)
})
