import test from "node:test";
import assert from "node:assert/strict";
import type { ToolDefinition } from "@synapse/shared";
import {
  classifyRelayLocalPermissionDenial,
  injectRelayAuthorizationToolParameter,
  parseRelayServerInvokeOptions,
} from "./relay-invoke-options.js";

function baseDefinition(): ToolDefinition {
  return {
    name: "bash",
    description: "Run a command",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Command text",
        },
      },
      required: ["command"],
    },
  };
}

test("injectRelayAuthorizationToolParameter augments builtin relay tools only", () => {
  const injected = injectRelayAuthorizationToolParameter(baseDefinition(), {
    builtinKind: "commandline",
  });
  const untouched = injectRelayAuthorizationToolParameter(baseDefinition(), {
    builtinKind: "custom",
  });

  assert.ok(injected.parameters.properties.request_authorization);
  assert.equal(untouched.parameters.properties.request_authorization, undefined);
});

test("parseRelayServerInvokeOptions strips request_authorization for eligible builtin tools", () => {
  const parsed = parseRelayServerInvokeOptions(
    {
      command: "python app.py",
      request_authorization: "background",
    },
    {
      builtinKind: "commandline",
    },
  );

  assert.equal(parsed.validationError, undefined);
  assert.deepEqual(parsed.clientToolArgs, {
    command: "python app.py",
  });
  assert.equal(parsed.serverInvokeOptions.requestAuthorization, "background");
});

test("parseRelayServerInvokeOptions rejects invalid request_authorization values", () => {
  const parsed = parseRelayServerInvokeOptions(
    {
      command: "python app.py",
      request_authorization: "later",
    },
    {
      builtinKind: "commandline",
    },
  );

  assert.match(parsed.validationError || "", /must be one of/i);
  assert.deepEqual(parsed.clientToolArgs, {
    command: "python app.py",
  });
  assert.equal(parsed.serverInvokeOptions.requestAuthorization, "none");
});

test("classifyRelayLocalPermissionDenial matches approvable local denial codes only", () => {
  const serverDisabled = classifyRelayLocalPermissionDenial({
    isError: true,
    structuredContent: {
      code: "server_disabled",
      relay_access_denial: {
        kind: "permission_denied",
        resolution: "server_grant",
      },
      message: "Enable it locally",
    },
  });
  const remoteControlDisabled = classifyRelayLocalPermissionDenial({
    isError: true,
    structuredContent: {
      code: "cua_remote_control_disabled",
      relay_access_denial: {
        kind: "runtime_constraint",
        resolution: "unresolvable",
      },
    },
  });

  assert.equal(serverDisabled?.code, "server_disabled");
  assert.equal(serverDisabled?.denial.resolution, "server_grant");
  assert.equal(remoteControlDisabled, null);
});
