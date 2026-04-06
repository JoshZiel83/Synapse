import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { inferRelaySpecialAuthorizationPlan } from './relay-special-mcp.js';

test('inferRelaySpecialAuthorizationPlan infers a filesystem read action and a single range option', () => {
  const directory = path.resolve('/tmp/synapse-relay-special-mcp');
  const filePath = path.join(directory, 'note.txt');

  const plan = inferRelaySpecialAuthorizationPlan({
    visibleToolName: 'View',
    toolInput: {
      file_path: filePath,
    },
    exposureMetadata: {
      builtinKind: 'filesystem',
    },
  });

  assert.ok(plan);
  assert.equal(plan.kind, 'filesystem');
  assert.equal(plan.requestedAction.capability, 'filesystem');
  assert.equal(plan.requestedAction.filesystem?.access, 'read');
  assert.deepEqual(plan.requestedAction.filesystem?.pathPrefixes, [directory]);
  assert.equal(plan.grantOptions.length, 1);
  assert.deepEqual(plan.grantOptions[0]?.grantSpec.filesystem, {
    access: 'read',
    pathPrefixes: [directory],
  });
});

test('inferRelaySpecialAuthorizationPlan adds browser host, domain, and global options', () => {
  const plan = inferRelaySpecialAuthorizationPlan({
    visibleToolName: 'navigate',
    toolInput: {
      url: 'https://sub.example.com/dashboard',
    },
    exposureMetadata: {
      builtinKind: 'browser',
    },
  });

  assert.ok(plan);
  assert.equal(plan.kind, 'browser');
  assert.equal(plan.requestedAction.capability, 'browser');
  assert.equal(plan.requestedAction.browser?.action, 'write');
  assert.equal(plan.requestedAction.browser?.scopeType, 'host');
  assert.equal(plan.requestedAction.browser?.host, 'sub.example.com');
  assert.equal(
    plan.grantOptions.some(
      (option) =>
        option.grantSpec.browser?.scopeType === 'host' &&
        option.grantSpec.browser?.host === 'sub.example.com',
    ),
    true,
  );
  assert.equal(
    plan.grantOptions.some(
      (option) =>
        option.grantSpec.browser?.scopeType === 'domain' &&
        option.grantSpec.browser?.registrableDomain === 'example.com',
    ),
    true,
  );
  assert.equal(
    plan.grantOptions.some(
      (option) =>
        option.grantSpec.browser?.scopeType === undefined &&
        option.grantSpec.browser?.action === 'write',
    ),
    true,
  );
});

test('inferRelaySpecialAuthorizationPlan adds exact, prefix, and tool commandline options', () => {
  const plan = inferRelaySpecialAuthorizationPlan({
    visibleToolName: 'bash',
    toolInput: {
      command: 'python manage.py migrate',
      cwd: '/workspace/app',
    },
    exposureMetadata: {
      builtinKind: 'commandline',
    },
  });

  assert.ok(plan);
  assert.equal(plan.kind, 'commandline');
  assert.equal(plan.requestedAction.capability, 'commandline');
  assert.equal(plan.requestedAction.commandline?.commandText, 'python manage.py migrate');
  assert.equal(plan.requestedAction.commandline?.workingDirectory, '/workspace/app');
  assert.equal(
    plan.grantOptions.some(
      (option) =>
        option.grantSpec.commandline?.commandMatchType === 'exact' &&
        option.grantSpec.commandline?.commandText === 'python manage.py migrate',
    ),
    true,
  );
  assert.equal(
    plan.grantOptions.some(
      (option) =>
        option.grantSpec.commandline?.commandMatchType === 'prefix' &&
        option.grantSpec.commandline?.commandText === 'python',
    ),
    true,
  );
  assert.equal(
    plan.grantOptions.some(
      (option) =>
        option.grantSpec.commandline?.commandMatchType === 'tool' &&
        option.grantSpec.commandline?.commandText === 'bash',
    ),
    true,
  );
});

test('inferRelaySpecialAuthorizationPlan suppresses prefix options for compound commands', () => {
  const plan = inferRelaySpecialAuthorizationPlan({
    visibleToolName: 'bash',
    toolInput: {
      command: 'python manage.py migrate && echo done',
    },
    exposureMetadata: {
      builtinKind: 'commandline',
    },
  });

  assert.ok(plan);
  assert.equal(
    plan.grantOptions.some(
      (option) => option.grantSpec.commandline?.commandMatchType === 'prefix',
    ),
    false,
  );
  assert.equal(
    plan.grantOptions.some(
      (option) => option.grantSpec.commandline?.commandMatchType === 'tool',
    ),
    true,
  );
});
