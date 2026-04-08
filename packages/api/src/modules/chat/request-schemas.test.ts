import assert from "node:assert/strict";
import test from "node:test";
import {
  chatClientInstanceParamsSchema,
  chatConversationParamsSchema,
  chatWorkspaceParamsSchema,
} from "./request-schemas.js";

const workspaceId = "56329471-d496-49df-b839-aecbb0669d9d";
const clientInstanceId = "0f4b0c78-1d6a-43b9-8e76-0fdbf6fa4e2a";
const conversationId = "4b2b0efd-93e6-4f17-b28f-e06db9bc76f8";

test("chat workspace params accept UUID workspace ids", () => {
  const result = chatWorkspaceParamsSchema.parse({
    workspaceId,
  });

  assert.deepEqual(result, { workspaceId });
});

test("chat client instance params reject legacy non-UUID ids", () => {
  const result = chatClientInstanceParamsSchema.safeParse({
    workspaceId,
    clientInstanceId: "client-mnolh3eb-cb2c3f660850c",
  });

  assert.equal(result.success, false);
  assert.match(result.error.issues[0]?.message ?? "", /uuid/i);
});

test("chat conversation params reject malformed conversation ids", () => {
  const result = chatConversationParamsSchema.safeParse({
    workspaceId,
    conversationId: "not-a-uuid",
  });

  assert.equal(result.success, false);
  assert.match(result.error.issues[0]?.message ?? "", /uuid/i);
});

test("chat client instance params accept UUID ids", () => {
  const result = chatClientInstanceParamsSchema.parse({
    workspaceId,
    clientInstanceId,
  });

  assert.deepEqual(result, {
    workspaceId,
    clientInstanceId,
  });
});

test("chat conversation params accept UUID ids", () => {
  const result = chatConversationParamsSchema.parse({
    workspaceId,
    conversationId,
  });

  assert.deepEqual(result, {
    workspaceId,
    conversationId,
  });
});
