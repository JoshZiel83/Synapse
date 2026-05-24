import fs from "node:fs"
import path from "node:path"

const repoRoot = process.cwd()

// Whole-repo scan. The audited surface was previously a 34-file allow-list;
// it now walks all .ts / .tsx sources under packages/{api,web-next,mobile-app}
// + packages/shared so a literal added in a new module gets caught too.
const scanRoots = [
  "packages/api/src",
  "packages/shared/src",
  "packages/web-next/app",
  "packages/web-next/components",
  "packages/web-next/lib",
  "packages/mobile-app/app",
  "packages/mobile-app/src",
  "packages/remote-agent-daemon/src",
]
const skipDirectories = new Set([
  "node_modules",
  "dist",
  ".next",
  "generated",
  "build",
])
const fileExtensions = new Set([".ts", ".tsx"])

function walk(dir) {
  if (!fs.existsSync(dir)) return []
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skipDirectories.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...walk(full))
      continue
    }
    if (entry.isFile() && fileExtensions.has(path.extname(entry.name))) {
      // Skip *.test.ts / *.test.tsx files — tests legitimately compare to
      // raw literals via assert.equal(value, "actor"), etc.
      if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.tsx")) {
        continue
      }
      out.push(full)
    }
  }
  return out
}

const auditedPaths = scanRoots.flatMap((root) =>
  walk(path.join(repoRoot, root)).map((p) => path.relative(repoRoot, p))
)

const checks = [
  {
    kind: "raw participantType comparison",
    regex:
      /participantType\s*===\s*"(?<value>actor|workspace_member|remote_agent|external|system)"/g,
  },
  {
    kind: "raw targetType comparison",
    regex: /targetType\s*===\s*"(?<value>member|actor|remote_agent)"/g,
  },
  {
    kind: "raw participant.type comparison",
    regex:
      /participant\.type\s*===\s*"(?<value>actor|workspace_member|remote_agent|external|system)"/g,
  },
  {
    kind: "raw approvalMode comparison",
    regex: /approvalMode\s*===\s*"(?<value>auto|manual)"/g,
  },
  {
    kind: "raw accessPolicy comparison",
    regex: /accessPolicy\s*===\s*"(?<value>workspace_open|approval_required)"/g,
  },
  {
    kind: "raw identity match state comparison",
    regex:
      /match\.state\s*===\s*"(?<value>same_workspace_member|friend|pending_request|requestable|existing|available|approval_required|pending_approval)"/g,
  },
  {
    kind: "raw direct state comparison",
    regex:
      /directState\.status\s*===\s*"(?<value>existing|available|approval_required|pending_approval)"/g,
  },
  {
    kind: "raw conversation kind comparison",
    regex: /conversation\.kind\s*===\s*"(?<value>group|private|virtual)"/g,
  },
  {
    kind: "raw conversation boundary comparison",
    regex: /conversation\.boundary\s*===\s*"(?<value>internal|external)"/g,
  },
  {
    kind: "raw model-group scope comparison",
    regex:
      /\b(?:scope|groupScope|resolvedScope)\s*(?:===|!==)\s*"(?<value>platform|workspace|workspace_member)"/g,
  },
  {
    kind: "raw model-group grant scope comparison",
    regex:
      /\bgrantScope\s*(?:===|!==)\s*"(?<value>platform|workspace|workspace_member|actor)"/g,
  },
  {
    kind: "raw model-group grant status comparison",
    regex: /grant\.status\s*===\s*"(?<value>active|revoked)"/g,
  },
  {
    kind: "raw z.enum business values",
    regex:
      /z\.enum\(\[\s*"(?<value>auto|manual|workspace_open|approval_required|claude_code|codex)"/g,
  },
]

function lineNumberForIndex(text, index) {
  let line = 1
  for (let i = 0; i < index; i += 1) {
    if (text[i] === "\n") line += 1
  }
  return line
}

const findings = []

for (const relativePath of auditedPaths) {
  const absolutePath = path.join(repoRoot, relativePath)
  if (!fs.existsSync(absolutePath)) {
    continue
  }

  const text = fs.readFileSync(absolutePath, "utf8")

  for (const check of checks) {
    check.regex.lastIndex = 0
    let match
    while ((match = check.regex.exec(text)) !== null) {
      const line = lineNumberForIndex(text, match.index)
      findings.push({
        file: relativePath,
        line,
        kind: check.kind,
        snippet: match[0],
      })
    }
  }
}

if (findings.length > 0) {
  console.error("Found forbidden raw business enum literals:")
  for (const finding of findings) {
    console.error(
      `- ${finding.file}:${finding.line} [${finding.kind}] ${finding.snippet}`
    )
  }
  process.exit(1)
}

console.log(
  `Business enum audit passed for ${auditedPaths.length} source files.`
)
