import test from 'node:test'
import assert from 'node:assert/strict'

import { buildCliAnythingWrapperContent } from './prepare-commandline-bundle.mjs'

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
