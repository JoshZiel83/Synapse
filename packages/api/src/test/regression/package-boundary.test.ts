import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../.."
)

const scanRoots = [
  "packages/api/src",
  "packages/device-runtime/src",
  "packages/shared/src",
  "packages/web-next",
  "packages/mobile-app/src",
].map((path) => join(repoRoot, path))

function sourceFilesUnder(root: string): string[] {
  try {
    if (!statSync(root).isDirectory()) return []
  } catch {
    return []
  }

  const out: string[] = []
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (
        entry.name === "node_modules" ||
        entry.name === "dist" ||
        entry.name === ".next" ||
        entry.name === "coverage"
      ) {
        continue
      }
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        visit(full)
      } else if (/\.(?:ts|tsx|mts|cts)$/.test(entry.name)) {
        out.push(full)
      }
    }
  }
  visit(root)
  return out
}

function moduleSpecifiers(source: string): string[] {
  const specs: string[] = []
  const moduleRe =
    /\b(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g
  let match: RegExpExecArray | null
  while ((match = moduleRe.exec(source))) {
    specs.push(match[1])
  }
  return specs
}

function productionSourceFiles(): string[] {
  return scanRoots
    .flatMap(sourceFilesUnder)
    .filter(
      (file) =>
        !file.endsWith(".test.ts") &&
        !file.endsWith(".test.tsx") &&
        !file.endsWith(".spec.ts") &&
        !file.endsWith(".spec.tsx")
    )
}

function rel(file: string): string {
  return relative(repoRoot, file)
}

test("R6 package ownership: in-repo code imports tool-presentation from shared", () => {
  const packageJson = JSON.parse(
    readFileSync(
      join(repoRoot, "packages/device-protocol/package.json"),
      "utf8"
    )
  ) as { exports?: Record<string, unknown> }
  assert.equal(
    packageJson.exports?.["./tool-presentation"],
    undefined,
    "device-protocol should not export the old tool-presentation owner subpath"
  )
  assert.equal(
    packageJson.exports?.["./tool-presentation/schema"],
    undefined,
    "device-protocol should not export the old tool-presentation schema subpath"
  )

  const forbidden: string[] = []
  for (const file of productionSourceFiles()) {
    const source = readFileSync(file, "utf8")
    for (const spec of moduleSpecifiers(source)) {
      if (
        spec === "@synapse/device-protocol/tool-presentation" ||
        spec === "@synapse/device-protocol/tool-presentation/schema"
      ) {
        forbidden.push(`${rel(file)} -> ${spec}`)
      }
    }
  }

  assert.deepEqual(
    forbidden,
    [],
    "in-repo production code should use @synapse/shared/tool-presentation; device-protocol no longer owns tool-presentation subpaths"
  )
})

test("R6 package ownership: browser tool map has only approved production consumers", () => {
  const allowed = new Set([
    "packages/api/src/modules/capability-projection/service.ts",
    "packages/device-runtime/src/builtins/chrome-devtools-mcp.ts",
    "packages/device-runtime/src/builtins/chrome.presentation.ts",
  ])
  const actual: string[] = []

  for (const file of productionSourceFiles()) {
    const source = readFileSync(file, "utf8")
    if (
      moduleSpecifiers(source).includes(
        "@synapse/device-protocol/browser-tools"
      )
    ) {
      actual.push(rel(file))
    }
  }

  assert.deepEqual(
    actual.sort(),
    [...allowed].sort(),
    "browser tool map is device-protocol-owned runtime metadata; shared/web/mobile production code must not import it"
  )
})
