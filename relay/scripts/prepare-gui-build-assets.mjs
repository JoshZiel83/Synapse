#!/usr/bin/env node

import { cp, copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..", "..");
const relayRoot = join(repoRoot, "relay");
const guiRoot = join(relayRoot, "cmd", "synapse-relay-gui");
const buildRoot = join(guiRoot, "build");
const windowsBuildRoot = join(buildRoot, "windows");
const windowsInstallerRoot = join(windowsBuildRoot, "installer");
const packagingRoot = join(guiRoot, "packaging", "windows");

const args = parseArgs(process.argv.slice(2));
const goos = (args.goos ?? process.env.GOOS ?? "").trim().toLowerCase() || hostGoos();
const runtimeMode = (args["runtime-mode"] ?? "portable").trim().toLowerCase();

await mkdir(buildRoot, { recursive: true });
await mkdir(windowsInstallerRoot, { recursive: true });

await copyFile(join(repoRoot, "packages", "web-next", "public", "synapse.png"), join(buildRoot, "appicon.png"));
await copyFile(join(packagingRoot, "installer", "project.nsi"), join(windowsInstallerRoot, "project.nsi"));

if (goos === "windows" && runtimeMode === "installer") {
  await stageWindowsRuntimeBundles();
} else {
  await rm(join(windowsBuildRoot, "runtime"), { recursive: true, force: true });
}

console.log(`Prepared GUI build assets for ${goos} (${runtimeMode})`);

function parseArgs(values) {
  const result = {};
  for (const value of values) {
    if (!value.startsWith("--")) {
      continue;
    }
    const trimmed = value.slice(2);
    const separator = trimmed.indexOf("=");
    if (separator === -1) {
      result[trimmed] = "true";
      continue;
    }
    result[trimmed.slice(0, separator)] = trimmed.slice(separator + 1);
  }
  return result;
}

function hostGoos() {
  switch (process.platform) {
    case "win32":
      return "windows";
    case "darwin":
      return "darwin";
    default:
      return process.platform;
  }
}

async function stageWindowsRuntimeBundles() {
  const runtimeRoot = join(windowsBuildRoot, "runtime");
  await rm(runtimeRoot, { recursive: true, force: true });

  await stageRuntimeBundle({
    name: "node",
    sourceDir: join(relayRoot, "internal", "nodebundle", "assets"),
  });
  await stageRuntimeBundle({
    name: "commandline",
    sourceDir: join(relayRoot, "internal", "commandlinebundle", "assets"),
  });
  await stageRuntimeBundle({
    name: "chrome-devtools-mcp",
    sourceDir: join(relayRoot, "internal", "chromemcpbundle", "assets"),
  });
}

async function stageRuntimeBundle({ name, sourceDir }) {
  const manifest = await readPreparedManifest(sourceDir, name);
  const bundleRoot = join(windowsBuildRoot, "runtime", name);
  const targetDir = join(bundleRoot, manifest.assetVersion);
  await mkdir(bundleRoot, { recursive: true });
  await mkdir(targetDir, { recursive: true });

  for (const entry of await readdir(sourceDir)) {
    await cp(join(sourceDir, entry), join(targetDir, entry), { recursive: true, force: true });
  }

  await writeFile(join(bundleRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(targetDir, ".ready"), manifest.assetVersion);
  console.log(`Staged installer runtime ${name}@${manifest.assetVersion}`);
}

async function readPreparedManifest(sourceDir, name) {
  const manifestPath = join(sourceDir, "manifest.json");
  const raw = await readFile(manifestPath, "utf8");
  const manifest = JSON.parse(raw);
  if (!manifest?.prepared || !manifest?.assetVersion || manifest.assetVersion === "unprepared") {
    throw new Error(`bundle ${name} is not prepared; run the relay bundle preparation scripts first`);
  }
  return manifest;
}
