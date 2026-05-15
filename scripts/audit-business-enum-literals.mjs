import fs from "node:fs"
import path from "node:path"

const repoRoot = process.cwd()

const auditedPaths = [
  "packages/api/src/modules/relationship/controller.ts",
  "packages/api/src/modules/remote-agents/controller.ts",
  "packages/api/src/modules/chat/service.ts",
  "packages/api/src/modules/chat/summary-view.ts",
  "packages/api/src/modules/ai/index.ts",
  "packages/api/src/modules/ai/context-compiler.ts",
  "packages/api/src/modules/ai/inline-ref-resolver.ts",
  "packages/web-next/app/dashboard/chat/member-utils.ts",
  "packages/web-next/app/dashboard/chat/conversation-chat.tsx",
  "packages/web-next/app/dashboard/chat/chat-participant-detail-dialog.tsx",
  "packages/web-next/app/dashboard/chat/chat-participant-hover-card.tsx",
  "packages/web-next/app/dashboard/chat/mobile-participant-picker-screen.tsx",
  "packages/web-next/app/dashboard/chat/message-bubble.tsx",
  "packages/web-next/app/dashboard/contacts/contact-hub-client.tsx",
  "packages/web-next/app/dashboard/remote-agents/agents/[remoteAgentId]/page.tsx",
  "packages/web-next/components/chat-composer.tsx",
  "packages/web-next/app/dashboard/settings/model-group-list.tsx",
  "packages/web-next/app/dashboard/settings/model-group-dialog.tsx",
  "packages/web-next/app/dashboard/settings/model-group-detail.tsx",
  "packages/web-next/app/dashboard/settings/model-group-browser.tsx",
  "packages/web-next/app/dashboard/settings/model-settings-workbench.tsx",
  "packages/mobile-app/src/lib/chat-data.ts",
  "packages/mobile-app/app/contacts/[contactType]/[contactId].tsx",
  "packages/mobile-app/app/contacts/discover.tsx",
  "packages/mobile-app/app/contacts/requests.tsx",
  "packages/mobile-app/app/search.tsx",
  "packages/mobile-app/app/scan.tsx",
  "packages/mobile-app/app/chat/[conversationId].tsx",
  "packages/mobile-app/app/conversations/[conversationId]/details.tsx",
  "packages/mobile-app/app/actors/select.tsx",
  "packages/mobile-app/app/contacts/group/new.tsx",
  "packages/mobile-app/src/components/chat-mention-picker-screen.tsx",
  "packages/mobile-app/src/components/workspace-entity-picker-screen.tsx",
  "packages/mobile-app/src/screens/tabs/contacts-tab-screen.tsx",
]

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
  `Business enum audit passed for ${auditedPaths.length} first-wave files.`
)
