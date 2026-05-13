import test from "node:test"
import assert from "node:assert/strict"

import {
  buildCliAnythingWrapperContent,
  getReleaseBinarySpec,
} from "./prepare-commandline-bundle.mjs"

const capability = {
  command: "cli-anything-demo",
  module: "demo",
  entryPointTarget: "cli_anything.demo.demo_cli:main",
}

test("buildCliAnythingWrapperContent uses Windows path separator for PYTHONPATH", () => {
  const content = buildCliAnythingWrapperContent(
    "py/python.exe",
    capability,
    "windows-amd64"
  )

  assert.match(
    content,
    /export PYTHONPATH="\$\{ROOT_DIR\}\/sp;\$\{PYTHONPATH\}"/
  )
  assert.doesNotMatch(
    content,
    /export PYTHONPATH="\$\{ROOT_DIR\}\/sp:\$\{PYTHONPATH\}"/
  )
})

test("buildCliAnythingWrapperContent uses POSIX path separator for PYTHONPATH", () => {
  const content = buildCliAnythingWrapperContent(
    "py/bin/python3",
    capability,
    "linux-amd64"
  )

  assert.match(
    content,
    /export PYTHONPATH="\$\{ROOT_DIR\}\/sp:\$\{PYTHONPATH\}"/
  )
  assert.doesNotMatch(
    content,
    /export PYTHONPATH="\$\{ROOT_DIR\}\/sp;\$\{PYTHONPATH\}"/
  )
})

test("getReleaseBinarySpec honors explicit github release archive names", () => {
  const spec = getReleaseBinarySpec("windows-amd64", {
    type: "github_release_binary",
    repository: "cli/cli",
    releaseVersion: "v2.89.0",
    binaryName: "gh",
    archiveFileNames: {
      "windows-amd64": "gh_2.89.0_windows_amd64.zip",
    },
  })

  assert.equal(spec.archiveFileName, "gh_2.89.0_windows_amd64.zip")
  assert.equal(spec.archiveType, "zip")
  assert.match(
    spec.url,
    /\/cli\/cli\/releases\/download\/v2\.89\.0\/gh_2\.89\.0_windows_amd64\.zip$/
  )
})

test("getReleaseBinarySpec builds gitlab release download URLs", () => {
  const spec = getReleaseBinarySpec("windows-amd64", {
    type: "gitlab_release_binary",
    repository: "gitlab-org/cli",
    releaseVersion: "v1.91.0",
    binaryName: "glab",
    archiveFileNames: {
      "windows-amd64": "glab_1.91.0_windows_amd64.zip",
    },
  })

  assert.equal(spec.archiveFileName, "glab_1.91.0_windows_amd64.zip")
  assert.equal(spec.archiveType, "zip")
  assert.match(
    spec.url,
    /gitlab\.com\/gitlab-org\/cli\/-\/releases\/v1\.91\.0\/downloads\/glab_1\.91\.0_windows_amd64\.zip$/
  )
})
