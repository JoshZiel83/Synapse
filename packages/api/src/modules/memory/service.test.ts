import test from 'node:test';
import assert from 'node:assert/strict';
import { textBlocks } from '@synapse/shared';
import { buildMemoryRecallQuery } from './service.js';

function hasIsolatedSurrogate(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);

    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (!(nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff)) {
        return true;
      }
      index += 1;
      continue;
    }

    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }

  return false;
}

test('buildMemoryRecallQuery preserves surrogate pairs when truncating long text', () => {
  const latestMessage = `${'a'.repeat(236)}🧠xyzz`;

  const query = buildMemoryRecallQuery({
    actorName: 'Mia',
    contextItems: [
      {
        kind: 'message',
        parts: textBlocks(latestMessage),
      } as any,
    ],
  });

  assert.equal(hasIsolatedSurrogate(query), false);
  assert.match(query, /🧠\.\.\.\nactor:Mia$/);
});
