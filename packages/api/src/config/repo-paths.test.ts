import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const expectedRepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

test("repo path helpers resolve from module location instead of cwd", async () => {
  const originalCwd = process.cwd();
  process.chdir("/tmp");

  try {
    const cacheBust = `cwd-test=${Date.now()}`;
    const repoPaths = await import(new URL(`./repo-paths.js?${cacheBust}`, import.meta.url).href);
    const subprojects = await import(new URL(`./subprojects.js?${cacheBust}`, import.meta.url).href);

    assert.equal(repoPaths.repoRoot, expectedRepoRoot);
    assert.equal(
      repoPaths.resolveRepoPath("relay", "cli-anything-wave1.json"),
      join(expectedRepoRoot, "relay", "cli-anything-wave1.json"),
    );
    assert.equal(
      subprojects.resolveRepoSubprojectRoot("cli-anything"),
      join(expectedRepoRoot, "subprojects", "cli-anything"),
    );

    assert.equal(
      existsSync(repoPaths.resolveRepoPath("relay", "cli-anything-wave1.json")),
      true,
    );
    assert.equal(
      existsSync(subprojects.resolveRepoSubprojectPath("cli-anything", "registry.json")),
      true,
    );
  } finally {
    process.chdir(originalCwd);
  }
});
