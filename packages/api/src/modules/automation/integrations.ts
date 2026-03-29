import crypto from "node:crypto";
import {
  buildAutomationEventSourceTemplate,
  getAutomationEventDefinition,
} from "@synapse/shared/automation";
import { nowISO } from "@synapse/shared";
import type {
  AutomationEventSource,
  AutomationEventSourceIntegration,
  AutomationIntegrationProvider,
  AutomationIntegrationTargetKind,
} from "@synapse/shared";
import { config } from "../../config/index.js";
import { query } from "../../infrastructure/database/index.js";
import { decryptSensitiveFields } from "../../infrastructure/crypto/index.js";

type IntegrationInstallationRow = {
  installation_id: string;
  workspace_id: string;
  installation_status: "active" | "disabled" | "error" | "archived";
  config_data: unknown;
  org_slug: string;
  item_slug: string;
  spec_metadata: unknown;
};

type IntegrationWebhookIngressResult =
  | {
      ignore: true;
    }
  | {
      ignore?: false;
      payload: Record<string, unknown>;
      sourceSnapshot: Record<string, unknown>;
      dedupeKey?: string;
      occurredAt?: string;
    };

export interface ResolvedIntegrationInstallation {
  id: string;
  workspaceId: string;
  provider: AutomationIntegrationProvider;
  orgSlug: string;
  itemSlug: string;
  configData: Record<string, unknown>;
}

type IntegrationEventSpec = {
  provider: AutomationIntegrationProvider;
  targetKind: AutomationIntegrationTargetKind;
  githubEvent?: string;
  gitlabFlag?: string;
};

const INTEGRATION_EVENT_SPECS: Record<string, IntegrationEventSpec> = {
  "github.issue_comment": {
    provider: "github",
    targetKind: "repository",
    githubEvent: "issue_comment",
  },
  "github.pull_request": {
    provider: "github",
    targetKind: "repository",
    githubEvent: "pull_request",
  },
  "github.pull_request_review": {
    provider: "github",
    targetKind: "repository",
    githubEvent: "pull_request_review",
  },
  "github.workflow_run": {
    provider: "github",
    targetKind: "repository",
    githubEvent: "workflow_run",
  },
  "github.push": {
    provider: "github",
    targetKind: "repository",
    githubEvent: "push",
  },
  "gitlab.note": {
    provider: "gitlab",
    targetKind: "project",
    gitlabFlag: "note_events",
  },
  "gitlab.merge_request": {
    provider: "gitlab",
    targetKind: "project",
    gitlabFlag: "merge_requests_events",
  },
  "gitlab.pipeline": {
    provider: "gitlab",
    targetKind: "project",
    gitlabFlag: "pipeline_events",
  },
  "gitlab.push": {
    provider: "gitlab",
    targetKind: "project",
    gitlabFlag: "push_events",
  },
};

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function integrationProviderFromRow(row: IntegrationInstallationRow): AutomationIntegrationProvider | null {
  const metadataProvider = readString(asObject(row.spec_metadata).integrationProvider);
  if (metadataProvider === "github" || metadataProvider === "gitlab") {
    return metadataProvider;
  }
  if (row.org_slug === "github" || row.org_slug === "gitlab") {
    return row.org_slug;
  }
  return null;
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

function joinUrl(base: string, path: string) {
  return `${trimTrailingSlash(base)}${path.startsWith("/") ? path : `/${path}`}`;
}

function ensureTimingSafeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function headerValue(headers: Record<string, unknown>, key: string) {
  const loweredKey = key.toLowerCase();
  const direct = headers[loweredKey] ?? headers[key];
  if (typeof direct === "string") {
    return direct;
  }
  if (Array.isArray(direct)) {
    return typeof direct[0] === "string" ? direct[0] : null;
  }
  return null;
}

function nestedTimestamp(payload: Record<string, unknown>, ...path: string[]) {
  let current: unknown = payload;
  for (const segment of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return null;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  const value = readString(current);
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function githubApiBaseUrl(configData: Record<string, unknown>) {
  return readString(configData.apiBaseUrl) || "https://api.github.com";
}

function gitlabBaseUrl(configData: Record<string, unknown>) {
  return readString(configData.baseUrl) || "https://gitlab.com";
}

function installationApiKey(configData: Record<string, unknown>) {
  const apiKey = readString(configData.apiKey);
  if (!apiKey) {
    throw new Error("Integration installation is missing apiKey");
  }
  return apiKey;
}

function integrationSpecForSourceKey(
  sourceKey: string,
  provider?: AutomationIntegrationProvider,
) {
  const spec = INTEGRATION_EVENT_SPECS[sourceKey];
  if (!spec) {
    throw new Error(`Unsupported integration event source key: ${sourceKey}`);
  }
  if (provider && spec.provider !== provider) {
    throw new Error(`Event source ${sourceKey} does not belong to ${provider}`);
  }
  return spec;
}

export function listIntegrationRemoteWebhookSubscriptions(
  provider: AutomationIntegrationProvider,
  sourceKeys: string[],
) {
  const githubEvents = new Set<string>();
  const gitlabFlags = new Set<string>();

  for (const sourceKey of sourceKeys) {
    const spec = integrationSpecForSourceKey(sourceKey, provider);
    if (spec.githubEvent) {
      githubEvents.add(spec.githubEvent);
    }
    if (spec.gitlabFlag) {
      gitlabFlags.add(spec.gitlabFlag);
    }
  }

  return {
    githubEvents: Array.from(githubEvents).sort(),
    gitlabFlags: Array.from(gitlabFlags).sort(),
  };
}

export function listIntegrationSourceKeysForWebhookIngress(input: {
  provider: AutomationIntegrationProvider;
  headers?: Record<string, unknown>;
  payload?: Record<string, unknown>;
}) {
  if (input.provider === "github") {
    const eventName = headerValue(input.headers || {}, "x-github-event");
    if (!eventName || eventName === "ping") {
      return [];
    }
    return Object.entries(INTEGRATION_EVENT_SPECS)
      .filter(([, spec]) => spec.provider === "github" && spec.githubEvent === eventName)
      .map(([sourceKey]) => sourceKey);
  }

  const payload = input.payload || {};
  const objectKind = readString(payload.object_kind)?.toLowerCase();
  if (!objectKind) {
    return [];
  }

  switch (objectKind) {
    case "note":
      return ["gitlab.note"];
    case "merge_request":
      return ["gitlab.merge_request"];
    case "pipeline":
      return ["gitlab.pipeline"];
    case "push":
      return ["gitlab.push"];
    default:
      return [];
  }
}

function githubRepositoryPath(targetId: string) {
  const trimmed = targetId.trim().replace(/^\/+/, "").replace(/\/+$/, "");
  const segments = trimmed.split("/").filter(Boolean);
  if (segments.length !== 2) {
    throw new Error("GitHub repository target must use owner/repo format");
  }
  return segments.map((segment) => encodeURIComponent(segment)).join("/");
}

function gitlabProjectPath(targetId: string) {
  const trimmed = targetId.trim();
  if (!trimmed) {
    throw new Error("GitLab project target is required");
  }
  return encodeURIComponent(trimmed);
}

async function githubRequest<T>(
  installation: ResolvedIntegrationInstallation,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(joinUrl(githubApiBaseUrl(installation.configData), path), {
    ...init,
    headers: {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${installationApiKey(installation.configData)}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init?.headers || {}),
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`GitHub API error ${response.status}: ${body || response.statusText}`);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

async function gitlabRequest<T>(
  installation: ResolvedIntegrationInstallation,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(joinUrl(trimTrailingSlash(gitlabBaseUrl(installation.configData)), `/api/v4${path}`), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${installationApiKey(installation.configData)}`,
      ...(init?.headers || {}),
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`GitLab API error ${response.status}: ${body || response.statusText}`);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

export function buildIntegrationEventSourceTemplate(input: {
  provider: AutomationIntegrationProvider;
  sourceKey: string;
  targetKind: AutomationIntegrationTargetKind;
  targetId: string;
  targetLabel: string;
}) {
  const definition = getAutomationEventDefinition(input.sourceKey);
  if (!definition || definition.providerKind !== "integration" || definition.integrationProvider !== input.provider) {
    throw new Error(`No integration definition found for ${input.sourceKey}`);
  }

  const spec = integrationSpecForSourceKey(input.sourceKey, input.provider);
  if (spec.targetKind !== input.targetKind) {
    throw new Error(`Event source ${input.sourceKey} requires target kind ${spec.targetKind}`);
  }

  return buildAutomationEventSourceTemplate(input.sourceKey, {
    providerLabel: input.targetLabel,
    providerRef: input.targetId,
    integrationProvider: input.provider,
    integrationTargetKind: input.targetKind,
    integrationTargetId: input.targetId,
    integrationTargetLabel: input.targetLabel,
    metadata: {
      integrationProvider: input.provider,
    },
  });
}

export async function getIntegrationInstallation(
  workspaceId: string,
  installationId: string,
  expectedProvider?: AutomationIntegrationProvider,
  options?: { allowInactive?: boolean },
): Promise<ResolvedIntegrationInstallation> {
  const result = await query<IntegrationInstallationRow>(
    `SELECT
       installation.id AS installation_id,
       installation.workspace_id,
       installation.status AS installation_status,
       installation.config_data,
       publisher.slug AS org_slug,
       item.slug AS item_slug,
       spec.metadata AS spec_metadata
     FROM plugin_installations installation
     JOIN catalog_items item ON item.id = installation.catalog_item_id
     JOIN publishers publisher ON publisher.id = item.publisher_id
     JOIN plugin_package_version_specs spec ON spec.catalog_version_id = installation.catalog_version_id
     WHERE installation.id = $1
       AND installation.workspace_id = $2
     LIMIT 1`,
    [installationId, workspaceId],
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error(`Integration installation ${installationId} was not found`);
  }
  if (row.installation_status !== "active" && !options?.allowInactive) {
    throw new Error(`Integration installation ${installationId} is not active`);
  }

  const provider = integrationProviderFromRow(row);
  if (!provider) {
    throw new Error(`Installation ${installationId} is not an automation-capable integration`);
  }
  if (expectedProvider && provider !== expectedProvider) {
    throw new Error(`Installation ${installationId} does not belong to ${expectedProvider}`);
  }

  return {
    id: row.installation_id,
    workspaceId: row.workspace_id,
    provider,
    orgSlug: row.org_slug,
    itemSlug: row.item_slug,
    configData: decryptSensitiveFields(asObject(row.config_data)),
  };
}

export function integrationWebhookCallbackUrl(pathToken: string) {
  const baseUrl = trimTrailingSlash(config.app.baseUrl || "http://localhost:3001");
  return `${baseUrl}/api/v1/automation-webhooks/${pathToken}/events`;
}

export async function registerIntegrationWebhook(input: {
  installation: ResolvedIntegrationInstallation;
  sourceKeys: string[];
  targetKind: AutomationIntegrationTargetKind;
  targetId: string;
  targetLabel: string;
  callbackUrl: string;
  secret: string;
  name: string;
  description: string;
}): Promise<string> {
  if (input.sourceKeys.length === 0) {
    throw new Error("Integration webhook registration requires at least one sourceKey");
  }

  const specs = input.sourceKeys.map((sourceKey) =>
    integrationSpecForSourceKey(sourceKey, input.installation.provider),
  );
  if (specs.some((spec) => spec.targetKind !== input.targetKind)) {
    throw new Error(`Integration webhook target kind ${input.targetKind} does not match all source keys`);
  }
  const subscriptions = listIntegrationRemoteWebhookSubscriptions(
    input.installation.provider,
    input.sourceKeys,
  );

  if (input.installation.provider === "github") {
    const response = await githubRequest<{ id: number | string }>(
      input.installation,
      `/repos/${githubRepositoryPath(input.targetId)}/hooks`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "web",
          active: true,
          events: subscriptions.githubEvents,
          config: {
            url: input.callbackUrl,
            content_type: "json",
            secret: input.secret,
            insecure_ssl: "0",
          },
        }),
      },
    );
    return String(response.id);
  }

  const response = await gitlabRequest<{ id: number | string }>(
    input.installation,
    `/projects/${gitlabProjectPath(input.targetId)}/hooks`,
    {
      method: "POST",
      body: JSON.stringify(
        subscriptions.gitlabFlags.reduce<Record<string, unknown>>(
          (payload, flag) => ({
            ...payload,
            [flag]: true,
          }),
          {
            url: input.callbackUrl,
            token: input.secret,
            name: input.name,
            description: input.description,
            enable_ssl_verification: true,
          },
        ),
      ),
    },
  );
  return String(response.id);
}

export async function unregisterIntegrationWebhook(input: {
  installation: ResolvedIntegrationInstallation;
  integration: AutomationEventSourceIntegration;
}) {
  if (!input.integration.externalSubscriptionId) {
    return;
  }

  try {
    if (input.installation.provider === "github") {
      await githubRequest(
        input.installation,
        `/repos/${githubRepositoryPath(input.integration.targetId)}/hooks/${encodeURIComponent(input.integration.externalSubscriptionId)}`,
        { method: "DELETE" },
      );
      return;
    }

    await gitlabRequest(
      input.installation,
      `/projects/${gitlabProjectPath(input.integration.targetId)}/hooks/${encodeURIComponent(input.integration.externalSubscriptionId)}`,
      { method: "DELETE" },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      input.installation.provider === "github" &&
      message.includes("404")
    ) {
      return;
    }
    if (
      input.installation.provider === "gitlab" &&
      message.includes("404")
    ) {
      return;
    }
    throw error;
  }
}

export async function updateIntegrationWebhook(input: {
  installation: ResolvedIntegrationInstallation;
  integration: Pick<
    AutomationEventSourceIntegration,
    "provider" | "targetKind" | "targetId" | "targetLabel" | "externalSubscriptionId"
  >;
  sourceKeys: string[];
  callbackUrl: string;
  secret: string;
  name: string;
  description: string;
}) {
  if (!input.integration.externalSubscriptionId) {
    throw new Error("Integration webhook update requires externalSubscriptionId");
  }
  if (input.sourceKeys.length === 0) {
    throw new Error("Integration webhook update requires at least one sourceKey");
  }

  const specs = input.sourceKeys.map((sourceKey) =>
    integrationSpecForSourceKey(sourceKey, input.installation.provider),
  );
  if (specs.some((spec) => spec.targetKind !== input.integration.targetKind)) {
    throw new Error(`Integration webhook target kind ${input.integration.targetKind} does not match all source keys`);
  }
  const subscriptions = listIntegrationRemoteWebhookSubscriptions(
    input.installation.provider,
    input.sourceKeys,
  );

  if (input.installation.provider === "github") {
    await githubRequest(
      input.installation,
      `/repos/${githubRepositoryPath(input.integration.targetId)}/hooks/${encodeURIComponent(input.integration.externalSubscriptionId)}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "web",
          active: true,
          events: subscriptions.githubEvents,
          config: {
            url: input.callbackUrl,
            content_type: "json",
            secret: input.secret,
            insecure_ssl: "0",
          },
        }),
      },
    );
    return;
  }

  await gitlabRequest(
    input.installation,
    `/projects/${gitlabProjectPath(input.integration.targetId)}/hooks/${encodeURIComponent(input.integration.externalSubscriptionId)}`,
    {
      method: "PUT",
      body: JSON.stringify(
        subscriptions.gitlabFlags.reduce<Record<string, unknown>>(
          (payload, flag) => ({
            ...payload,
            [flag]: true,
          }),
          {
            url: input.callbackUrl,
            token: input.secret,
            name: input.name,
            description: input.description,
            enable_ssl_verification: true,
          },
        ),
      ),
    },
  );
}

export function normalizeIntegrationWebhookIngress(input: {
  integration: Pick<
    AutomationEventSourceIntegration,
    "provider" | "targetKind" | "targetId" | "targetLabel"
  >;
  secret: string;
  headers: Record<string, unknown>;
  rawBody?: string;
  body?: Record<string, unknown>;
}): IntegrationWebhookIngressResult {
  const payload = input.body || {};
  if (input.integration.provider === "github") {
    const signature = headerValue(input.headers, "x-hub-signature-256");
    if (!signature || !input.rawBody) {
      throw new Error("GitHub webhook signature is required");
    }
    const expected = `sha256=${crypto.createHmac("sha256", input.secret).update(input.rawBody).digest("hex")}`;
    if (!ensureTimingSafeEqual(signature, expected)) {
      throw new Error("Invalid GitHub webhook signature");
    }

    const eventName = headerValue(input.headers, "x-github-event");
    if (eventName === "ping") {
      return { ignore: true };
    }

    return {
      payload,
      dedupeKey: headerValue(input.headers, "x-github-delivery") || undefined,
      occurredAt:
        nestedTimestamp(payload, "comment", "created_at") ||
        nestedTimestamp(payload, "pull_request", "updated_at") ||
        nestedTimestamp(payload, "review", "submitted_at") ||
        nestedTimestamp(payload, "workflow_run", "updated_at") ||
        nestedTimestamp(payload, "head_commit", "timestamp") ||
        nowISO(),
      sourceSnapshot: {
        integrationProvider: "github",
        integrationTargetKind: input.integration.targetKind,
        integrationTargetId: input.integration.targetId,
        integrationTargetLabel: input.integration.targetLabel,
        githubEvent: eventName,
        githubDeliveryId: headerValue(input.headers, "x-github-delivery"),
        repositoryFullName: readString(
          asObject(payload.repository).full_name,
        ) || input.integration.targetLabel,
      },
    };
  }

  const gitlabToken = headerValue(input.headers, "x-gitlab-token");
  if (!gitlabToken || !ensureTimingSafeEqual(gitlabToken, input.secret)) {
    throw new Error("Invalid GitLab webhook token");
  }

  return {
    payload,
    dedupeKey:
      headerValue(input.headers, "x-gitlab-event-uuid") ||
      headerValue(input.headers, "x-gitlab-webhook-uuid") ||
      undefined,
    occurredAt:
      nestedTimestamp(payload, "object_attributes", "created_at") ||
      nestedTimestamp(payload, "object_attributes", "updated_at") ||
      nestedTimestamp(payload, "commit", "timestamp") ||
      nowISO(),
    sourceSnapshot: {
      integrationProvider: "gitlab",
      integrationTargetKind: input.integration.targetKind,
      integrationTargetId: input.integration.targetId,
      integrationTargetLabel: input.integration.targetLabel,
      gitlabEvent: headerValue(input.headers, "x-gitlab-event"),
      gitlabEventUuid: headerValue(input.headers, "x-gitlab-event-uuid"),
      gitlabWebhookUuid: headerValue(input.headers, "x-gitlab-webhook-uuid"),
      projectPathWithNamespace: readString(
        asObject(payload.project).path_with_namespace,
      ) || input.integration.targetLabel,
    },
  };
}
