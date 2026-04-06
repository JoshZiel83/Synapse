import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  assertAccessActionsMatchAuthzSchema,
  findMissingAccessActionSchemaEntries,
  parseAuthzSchemaDefinitions,
} from "./schema-validation.js";

const schemaUrl = new URL("../../../../../docs/spicedb-schema.zed", import.meta.url);
const schemaText = readFileSync(schemaUrl, "utf-8");

test("ACCESS_ACTIONS entries all exist in the bundled SpiceDB schema", () => {
  const missing = findMissingAccessActionSchemaEntries(schemaText);
  assert.deepEqual(missing, []);
  assert.doesNotThrow(() =>
    assertAccessActionsMatchAuthzSchema({
      schemaPath: schemaUrl.pathname,
      schemaText,
    }),
  );
});

test("relay authorization schema uses canonical relay naming", () => {
  const definitions = parseAuthzSchemaDefinitions(schemaText);
  const relayDevice = definitions.get("relay_device");
  const relayCapability = definitions.get("relay_capability");

  assert.ok(relayDevice);
  assert.ok(relayCapability);

  assert.ok(relayDevice.permissions.has("authorize_relay_authorization"));
  assert.ok(!relayDevice.permissions.has("authorize_runtime_access"));
  assert.ok(relayDevice.relations.has("relay_authorizer"));
  assert.ok(!relayDevice.relations.has("runtime_authorizer"));

  assert.ok(relayCapability.permissions.has("request_relay_authorization"));
  assert.ok(!relayCapability.permissions.has("request_runtime_authorization"));
});

test("assertAccessActionsMatchAuthzSchema reports missing relay authorization permissions", () => {
  const brokenSchema = schemaText
    .replace(
      "permission authorize_relay_authorization = owner + operator + relay_authorizer + workspace->manage_relays",
      "permission authorize_runtime_access = owner + operator + relay_authorizer + workspace->manage_relays",
    )
    .replace(
      "permission request_relay_authorization = use",
      "permission request_runtime_authorization = use",
    );

  assert.throws(
    () =>
      assertAccessActionsMatchAuthzSchema({
        schemaText: brokenSchema,
      }),
    /relay_device\.authorize_relay_authorization.*relay_capability\.request_relay_authorization/,
  );
});
