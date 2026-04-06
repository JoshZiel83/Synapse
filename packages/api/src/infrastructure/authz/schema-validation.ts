import { ACCESS_ACTIONS } from "../../modules/access/actions.js";

interface AccessActionSpec {
  resourceType: string;
  permission: string;
}

export interface AuthzSchemaDefinitionEntry {
  relations: Set<string>;
  permissions: Set<string>;
}

export function parseAuthzSchemaDefinitions(schemaText: string) {
  const definitions = new Map<string, AuthzSchemaDefinitionEntry>();
  const definitionPattern = /definition\s+([a-z_][a-z0-9_]*)\s*\{([\s\S]*?)\}/g;

  for (const match of schemaText.matchAll(definitionPattern)) {
    const name = match[1];
    const body = match[2] || "";
    const relations = new Set<string>();
    const permissions = new Set<string>();

    for (const relationMatch of body.matchAll(
      /^\s*relation\s+([a-z_][a-z0-9_]*)\s*:/gm,
    )) {
      relations.add(relationMatch[1]!);
    }

    for (const permissionMatch of body.matchAll(
      /^\s*permission\s+([a-z_][a-z0-9_]*)\s*=/gm,
    )) {
      permissions.add(permissionMatch[1]!);
    }

    definitions.set(name, {
      relations,
      permissions,
    });
  }

  return definitions;
}

export function findMissingAccessActionSchemaEntries(
  schemaText: string,
  accessActions: Record<string, AccessActionSpec> = ACCESS_ACTIONS,
) {
  const definitions = parseAuthzSchemaDefinitions(schemaText);
  const missing: string[] = [];

  for (const [action, spec] of Object.entries(accessActions)) {
    const definition = definitions.get(spec.resourceType);
    if (!definition) {
      missing.push(`${action} -> definition ${spec.resourceType}`);
      continue;
    }

    if (
      !definition.permissions.has(spec.permission)
      && !definition.relations.has(spec.permission)
    ) {
      missing.push(
        `${action} -> ${spec.resourceType}.${spec.permission}`,
      );
    }
  }

  return missing;
}

export function assertAccessActionsMatchAuthzSchema(params: {
  schemaText: string;
  schemaPath?: string;
  accessActions?: Record<string, AccessActionSpec>;
}) {
  const missing = findMissingAccessActionSchemaEntries(
    params.schemaText,
    params.accessActions,
  );

  if (missing.length === 0) {
    return;
  }

  const schemaLabel = params.schemaPath
    ? ` ${params.schemaPath}`
    : "";
  throw new Error(
    `SpiceDB schema${schemaLabel} is missing relation/permission entries referenced by ACCESS_ACTIONS: ${missing.join(", ")}`,
  );
}
