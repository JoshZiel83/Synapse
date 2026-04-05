import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { inferRelaySpecialAuthorizationPlan } from './relay-special-mcp.js';

test('inferRelaySpecialAuthorizationPlan infers filesystem read and directory requirements', () => {
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
  assert.deepEqual(
    plan.requiredRequirements.map((requirement) => requirement.kind),
    ['filesystem.read', 'filesystem.directory'],
  );
  assert.equal(
    plan.approvalOptions.some(
      (option) =>
        option.kind === 'filesystem.directory' &&
        option.grantSpec.pathPrefix === directory,
    ),
    true,
  );
});

test('inferRelaySpecialAuthorizationPlan adds browser host and domain options', () => {
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
  assert.deepEqual(
    plan.requiredRequirements.map((requirement) => requirement.kind),
    ['browser.tool', 'browser.write', 'browser.site'],
  );
  assert.equal(
    plan.approvalOptions.some(
      (option) =>
        option.kind === 'browser.site' &&
        option.grantSpec.browserScopeType === 'host' &&
        option.grantSpec.browserHost === 'sub.example.com',
    ),
    true,
  );
  assert.equal(
    plan.approvalOptions.some(
      (option) =>
        option.kind === 'browser.site' &&
        option.grantSpec.browserScopeType === 'domain' &&
        option.grantSpec.browserRegistrableDomain === 'example.com',
    ),
    true,
  );
});

test('inferRelaySpecialAuthorizationPlan adds exact and prefix commandline options', () => {
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
  assert.deepEqual(
    plan.requiredRequirements.map((requirement) => requirement.kind),
    ['commandline.tool', 'commandline.command', 'commandline.directory'],
  );
  assert.equal(
    plan.approvalOptions.some(
      (option) =>
        option.kind === 'commandline.command' &&
        option.grantSpec.commandMatchType === 'exact' &&
        option.grantSpec.commandText === 'python manage.py migrate',
    ),
    true,
  );
  assert.equal(
    plan.approvalOptions.some(
      (option) =>
        option.kind === 'commandline.command' &&
        option.grantSpec.commandMatchType === 'prefix' &&
        option.grantSpec.commandText === 'python',
    ),
    true,
  );
});

test('inferRelaySpecialAuthorizationPlan suppresses prefix option for compound commands', () => {
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
  const commandOptions = plan.approvalOptions.filter(
    (option) => option.kind === 'commandline.command',
  );
  assert.equal(commandOptions.length, 1);
  assert.equal(commandOptions[0]?.grantSpec.commandMatchType, 'exact');
});
