import type {
  AutomationEventDefinition,
  AutomationEventSourceDefinitionContext,
  AutomationOccurrenceDisplayContext,
} from "./types.js"

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function truncate(value: string, max = 120) {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

function targetLabel(
  context:
    | AutomationEventSourceDefinitionContext
    | AutomationOccurrenceDisplayContext,
  fallback: string
) {
  return (
    readString(
      (context as AutomationEventSourceDefinitionContext).integrationTargetLabel
    ) ||
    readString(
      (context as AutomationEventSourceDefinitionContext).providerLabel
    ) ||
    readString(
      (context as AutomationEventSourceDefinitionContext).providerRef
    ) ||
    readString((context as AutomationOccurrenceDisplayContext).sourceName) ||
    fallback
  )
}

function githubRepositoryLabel(context: AutomationOccurrenceDisplayContext) {
  return (
    readString(
      (context.payload.repository as Record<string, unknown> | undefined)
        ?.full_name
    ) ||
    readString(context.sourceSnapshot.integrationTargetLabel) ||
    targetLabel(context, "GitHub repository")
  )
}

function gitlabProjectLabel(context: AutomationOccurrenceDisplayContext) {
  return (
    readString(
      (context.payload.project as Record<string, unknown> | undefined)
        ?.path_with_namespace
    ) ||
    readString(context.sourceSnapshot.integrationTargetLabel) ||
    targetLabel(context, "GitLab project")
  )
}

function buildGithubIssueCommentDisplay(
  context: AutomationOccurrenceDisplayContext
) {
  const repo = githubRepositoryLabel(context)
  const issueNumber =
    readString(
      (context.payload.issue as Record<string, unknown> | undefined)?.number
    ) ||
    String(
      (context.payload.issue as Record<string, unknown> | undefined)?.number ||
        ""
    ).trim() ||
    "issue"
  const author = readString(
    (
      (context.payload.comment as Record<string, unknown> | undefined)?.user as
        | Record<string, unknown>
        | undefined
    )?.login
  )
  const body = readString(
    (context.payload.comment as Record<string, unknown> | undefined)?.body
  )

  return {
    title: `${repo} comment on #${issueNumber}`,
    summary: author ? `comment by ${author}` : "issue comment",
    description: body
      ? truncate(body, 160)
      : `A new issue or pull request comment arrived in ${repo}.`,
  }
}

function buildGithubPullRequestDisplay(
  context: AutomationOccurrenceDisplayContext
) {
  const repo = githubRepositoryLabel(context)
  const prNumber =
    String(
      (context.payload.pull_request as Record<string, unknown> | undefined)
        ?.number || ""
    ).trim() || "pull request"
  const action = readString(context.payload.action) || "updated"
  const title = readString(
    (context.payload.pull_request as Record<string, unknown> | undefined)?.title
  )

  return {
    title: `${repo} pull request #${prNumber}`,
    summary: action,
    description: title
      ? truncate(title, 160)
      : `Pull request #${prNumber} was ${action} in ${repo}.`,
  }
}

function buildGithubPullRequestReviewDisplay(
  context: AutomationOccurrenceDisplayContext
) {
  const repo = githubRepositoryLabel(context)
  const prNumber =
    String(
      (context.payload.pull_request as Record<string, unknown> | undefined)
        ?.number || ""
    ).trim() || "pull request"
  const state =
    readString(
      (context.payload.review as Record<string, unknown> | undefined)?.state
    ) || "submitted"
  const author = readString(
    (
      (context.payload.review as Record<string, unknown> | undefined)?.user as
        | Record<string, unknown>
        | undefined
    )?.login
  )

  return {
    title: `${repo} review on #${prNumber}`,
    summary: author ? `${state} by ${author}` : state,
    description: `A pull request review was ${state} for #${prNumber} in ${repo}.`,
  }
}

function buildGithubWorkflowRunDisplay(
  context: AutomationOccurrenceDisplayContext
) {
  const repo = githubRepositoryLabel(context)
  const workflowName =
    readString(
      (context.payload.workflow as Record<string, unknown> | undefined)?.name
    ) ||
    readString(
      (context.payload.workflow_run as Record<string, unknown> | undefined)
        ?.name
    ) ||
    "workflow"
  const status =
    readString(
      (context.payload.workflow_run as Record<string, unknown> | undefined)
        ?.conclusion
    ) ||
    readString(
      (context.payload.workflow_run as Record<string, unknown> | undefined)
        ?.status
    ) ||
    "updated"

  return {
    title: `${repo} workflow run`,
    summary: `${workflowName} ${status}`,
    description: `Workflow "${workflowName}" reported a ${status} update in ${repo}.`,
  }
}

function buildGithubPushDisplay(context: AutomationOccurrenceDisplayContext) {
  const repo = githubRepositoryLabel(context)
  const ref = readString(context.payload.ref) || "refs/heads/unknown"
  const commits = Array.isArray(context.payload.commits)
    ? context.payload.commits.length
    : 0
  return {
    title: `${repo} push`,
    summary: `${ref} · ${commits} commit${commits === 1 ? "" : "s"}`,
    description: `A push updated ${ref} in ${repo}.`,
  }
}

function buildGitlabNoteDisplay(context: AutomationOccurrenceDisplayContext) {
  const project = gitlabProjectLabel(context)
  const note = readString(
    (context.payload.object_attributes as Record<string, unknown> | undefined)
      ?.note
  )
  const noteableType =
    readString(
      (context.payload.object_attributes as Record<string, unknown> | undefined)
        ?.noteable_type
    ) || "item"
  return {
    title: `${project} note`,
    summary: noteableType.toLowerCase(),
    description: note
      ? truncate(note, 160)
      : `A new note was added in ${project}.`,
  }
}

function buildGitlabMergeRequestDisplay(
  context: AutomationOccurrenceDisplayContext
) {
  const project = gitlabProjectLabel(context)
  const title = readString(
    (context.payload.object_attributes as Record<string, unknown> | undefined)
      ?.title
  )
  const action =
    readString(
      (context.payload.object_attributes as Record<string, unknown> | undefined)
        ?.action
    ) || "updated"
  return {
    title: `${project} merge request`,
    summary: action,
    description: title
      ? truncate(title, 160)
      : `A merge request was ${action} in ${project}.`,
  }
}

function buildGitlabPipelineDisplay(
  context: AutomationOccurrenceDisplayContext
) {
  const project = gitlabProjectLabel(context)
  const status =
    readString(
      (context.payload.object_attributes as Record<string, unknown> | undefined)
        ?.status
    ) || "updated"
  const ref =
    readString(
      (context.payload.object_attributes as Record<string, unknown> | undefined)
        ?.ref
    ) || "unknown"
  return {
    title: `${project} pipeline`,
    summary: `${ref} · ${status}`,
    description: `A pipeline for ${ref} reported status ${status} in ${project}.`,
  }
}

function buildGitlabPushDisplay(context: AutomationOccurrenceDisplayContext) {
  const project = gitlabProjectLabel(context)
  const ref = readString(context.payload.ref) || "unknown"
  const commits =
    typeof context.payload.total_commits_count === "number"
      ? context.payload.total_commits_count
      : 0
  return {
    title: `${project} push`,
    summary: `${ref} · ${commits} commit${commits === 1 ? "" : "s"}`,
    description: `A push updated ${ref} in ${project}.`,
  }
}

function githubSource(
  definitionKey: string,
  labelPrefix: string,
  description: (target: string) => string,
  recommendedUsage: (target: string) => string,
  payloadSchema: Record<string, unknown>,
  examplePayload: Record<string, unknown>
): AutomationEventDefinition {
  return {
    definitionKey,
    providerKind: "integration",
    integrationProvider: "github",
    managementMode: "user",
    buildSource: (context) => {
      const target = targetLabel(context, "GitHub repository")
      return {
        sourceKey: definitionKey,
        name: `${labelPrefix}: ${target}`,
        description: description(target),
        recommendedUsage: recommendedUsage(target),
        payloadSchema,
        examplePayload,
        metadata: {
          definitionKey,
          integrationProvider: "github",
        },
      }
    },
  }
}

function gitlabSource(
  definitionKey: string,
  labelPrefix: string,
  description: (target: string) => string,
  recommendedUsage: (target: string) => string,
  payloadSchema: Record<string, unknown>,
  examplePayload: Record<string, unknown>
): AutomationEventDefinition {
  return {
    definitionKey,
    providerKind: "integration",
    integrationProvider: "gitlab",
    managementMode: "user",
    buildSource: (context) => {
      const target = targetLabel(context, "GitLab project")
      return {
        sourceKey: definitionKey,
        name: `${labelPrefix}: ${target}`,
        description: description(target),
        recommendedUsage: recommendedUsage(target),
        payloadSchema,
        examplePayload,
        metadata: {
          definitionKey,
          integrationProvider: "gitlab",
        },
      }
    },
  }
}

export const githubIssueCommentEventDefinition: AutomationEventDefinition = {
  ...githubSource(
    "github.issue_comment",
    "GitHub Issue Comment",
    (target) =>
      `Triggered when a new issue or pull request comment is created in ${target}.`,
    (target) =>
      `Use this for repo inbox workflows in ${target}, such as waking reviewers or triaging inbound comments.`,
    {
      type: "object",
      properties: {
        action: { type: "string" },
        repository: { type: "object" },
        issue: { type: "object" },
        comment: { type: "object" },
      },
      required: ["action", "repository", "comment"],
    },
    {
      action: "created",
      repository: { full_name: "octo-org/octo-repo" },
      issue: { number: 128 },
      comment: { body: "Looks good to me." },
    }
  ),
  buildOccurrenceDisplay: buildGithubIssueCommentDisplay,
}

export const githubPullRequestEventDefinition: AutomationEventDefinition = {
  ...githubSource(
    "github.pull_request",
    "GitHub Pull Request",
    (target) => `Triggered when a pull request changes in ${target}.`,
    (target) =>
      `Use this for review orchestration in ${target}, such as reacting to newly opened, synchronized, or merged pull requests.`,
    {
      type: "object",
      properties: {
        action: { type: "string" },
        repository: { type: "object" },
        pull_request: { type: "object" },
      },
      required: ["action", "repository", "pull_request"],
    },
    {
      action: "opened",
      repository: { full_name: "octo-org/octo-repo" },
      pull_request: { number: 42, title: "Refactor automation ingress" },
    }
  ),
  buildOccurrenceDisplay: buildGithubPullRequestDisplay,
}

export const githubPullRequestReviewEventDefinition: AutomationEventDefinition =
  {
    ...githubSource(
      "github.pull_request_review",
      "GitHub Pull Request Review",
      (target) =>
        `Triggered when a pull request review is submitted in ${target}.`,
      (target) =>
        `Use this when review state changes in ${target} should wake agents or notify humans immediately.`,
      {
        type: "object",
        properties: {
          action: { type: "string" },
          repository: { type: "object" },
          pull_request: { type: "object" },
          review: { type: "object" },
        },
        required: ["repository", "pull_request", "review"],
      },
      {
        action: "submitted",
        repository: { full_name: "octo-org/octo-repo" },
        pull_request: { number: 42 },
        review: { state: "approved" },
      }
    ),
    buildOccurrenceDisplay: buildGithubPullRequestReviewDisplay,
  }

export const githubWorkflowRunEventDefinition: AutomationEventDefinition = {
  ...githubSource(
    "github.workflow_run",
    "GitHub Workflow Run",
    (target) => `Triggered when a workflow run status changes in ${target}.`,
    (target) => `Use this to react to CI or deployment outcomes in ${target}.`,
    {
      type: "object",
      properties: {
        action: { type: "string" },
        repository: { type: "object" },
        workflow: { type: "object" },
        workflow_run: { type: "object" },
      },
      required: ["repository", "workflow_run"],
    },
    {
      action: "completed",
      repository: { full_name: "octo-org/octo-repo" },
      workflow_run: { name: "CI", conclusion: "success" },
    }
  ),
  buildOccurrenceDisplay: buildGithubWorkflowRunDisplay,
}

export const githubPushEventDefinition: AutomationEventDefinition = {
  ...githubSource(
    "github.push",
    "GitHub Push",
    (target) => `Triggered when a push updates a branch in ${target}.`,
    (target) =>
      `Use this for branch-level automation in ${target}, such as post-push indexing or sync notifications.`,
    {
      type: "object",
      properties: {
        ref: { type: "string" },
        repository: { type: "object" },
        commits: { type: "array" },
      },
      required: ["ref", "repository"],
    },
    {
      ref: "refs/heads/main",
      repository: { full_name: "octo-org/octo-repo" },
      commits: [{ id: "abc123" }],
    }
  ),
  buildOccurrenceDisplay: buildGithubPushDisplay,
}

export const gitlabNoteEventDefinition: AutomationEventDefinition = {
  ...gitlabSource(
    "gitlab.note",
    "GitLab Note",
    (target) =>
      `Triggered when a new note or discussion reply is created in ${target}.`,
    (target) =>
      `Use this for comment-driven workflows in ${target}, such as triage, escalation, or reviewer wakeups.`,
    {
      type: "object",
      properties: {
        object_kind: { type: "string" },
        project: { type: "object" },
        object_attributes: { type: "object" },
      },
      required: ["object_kind", "project", "object_attributes"],
    },
    {
      object_kind: "note",
      project: { path_with_namespace: "group/project" },
      object_attributes: { note: "Please rerun the pipeline." },
    }
  ),
  buildOccurrenceDisplay: buildGitlabNoteDisplay,
}

export const gitlabMergeRequestEventDefinition: AutomationEventDefinition = {
  ...gitlabSource(
    "gitlab.merge_request",
    "GitLab Merge Request",
    (target) => `Triggered when a merge request changes in ${target}.`,
    (target) => `Use this for MR review and merge workflows in ${target}.`,
    {
      type: "object",
      properties: {
        object_kind: { type: "string" },
        project: { type: "object" },
        object_attributes: { type: "object" },
      },
      required: ["object_kind", "project", "object_attributes"],
    },
    {
      object_kind: "merge_request",
      project: { path_with_namespace: "group/project" },
      object_attributes: { action: "open", title: "Update automation service" },
    }
  ),
  buildOccurrenceDisplay: buildGitlabMergeRequestDisplay,
}

export const gitlabPipelineEventDefinition: AutomationEventDefinition = {
  ...gitlabSource(
    "gitlab.pipeline",
    "GitLab Pipeline",
    (target) => `Triggered when a pipeline changes status in ${target}.`,
    (target) =>
      `Use this for CI/CD orchestration in ${target}, especially when pipeline status should wake sessions or notify operators.`,
    {
      type: "object",
      properties: {
        object_kind: { type: "string" },
        project: { type: "object" },
        object_attributes: { type: "object" },
      },
      required: ["object_kind", "project", "object_attributes"],
    },
    {
      object_kind: "pipeline",
      project: { path_with_namespace: "group/project" },
      object_attributes: { ref: "main", status: "success" },
    }
  ),
  buildOccurrenceDisplay: buildGitlabPipelineDisplay,
}

export const gitlabPushEventDefinition: AutomationEventDefinition = {
  ...gitlabSource(
    "gitlab.push",
    "GitLab Push",
    (target) => `Triggered when a push updates a branch in ${target}.`,
    (target) => `Use this for branch-driven automation in ${target}.`,
    {
      type: "object",
      properties: {
        object_kind: { type: "string" },
        project: { type: "object" },
        ref: { type: "string" },
        total_commits_count: { type: "number" },
      },
      required: ["project", "ref"],
    },
    {
      object_kind: "push",
      project: { path_with_namespace: "group/project" },
      ref: "refs/heads/main",
      total_commits_count: 1,
    }
  ),
  buildOccurrenceDisplay: buildGitlabPushDisplay,
}

export const integrationEventDefinitions = [
  githubIssueCommentEventDefinition,
  githubPullRequestEventDefinition,
  githubPullRequestReviewEventDefinition,
  githubWorkflowRunEventDefinition,
  githubPushEventDefinition,
  gitlabNoteEventDefinition,
  gitlabMergeRequestEventDefinition,
  gitlabPipelineEventDefinition,
  gitlabPushEventDefinition,
] as const
