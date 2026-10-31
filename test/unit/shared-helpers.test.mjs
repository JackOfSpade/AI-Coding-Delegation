import test from 'node:test';
import assert from 'node:assert/strict';
import { pidAlive } from '../../src/pid.mjs';
import { plainObject } from '../../src/plain-object.mjs';
import { insidePath } from '../../src/path-containment.mjs';
import {
  sameBigintFileStat,
  sameFileIdentity,
  sameStatFields,
  sameStatValue,
  sameTimestamp,
  statTimestamp,
} from '../../src/stat-identity.mjs';
import { MAX_MESSAGE_CHARS, MAX_TOOL_ARGUMENT_CHARS, MAX_TOOL_CALLS, validToolIdentifier } from '../../src/transcript-limits.mjs';
import { escapeRegExp } from '../../src/glob.mjs';
import { applyPathAliases } from '../../src/redact.mjs';
import { escapesRoot } from '../../src/policy.mjs';
import { sep } from 'node:path';

test('pidAlive rejects invalid pids, accepts this process, and treats EPERM as alive', (t) => {
  for (const pid of [0, -1, 1.5, '1', undefined, null]) assert.equal(pidAlive(pid), false);
  assert.equal(pidAlive(process.pid), true);
  const kill = t.mock.method(process, 'kill', () => {
    throw Object.assign(new Error('denied'), { code: 'EPERM' });
  });
  assert.equal(pidAlive(4242), true);
  kill.mock.mockImplementation(() => {
    throw Object.assign(new Error('gone'), { code: 'ESRCH' });
  });
  assert.equal(pidAlive(4242), false);
});

test('plainObject accepts literals and null-prototype objects only', () => {
  assert.equal(plainObject({}), true);
  assert.equal(plainObject(Object.create(null)), true);
  for (const value of [[], null, undefined, 1, 'x', new Map(), new (class A {})()]) assert.equal(plainObject(value), false);
});

test('insidePath treats equal paths and descendants as inside, siblings and other drives as outside', () => {
  assert.equal(insidePath('/a/b', '/a/b'), true);
  assert.equal(insidePath('/a/b/c', '/a/b'), true);
  assert.equal(insidePath('/a/..foo', '/a'), true);
  assert.equal(insidePath('/a', '/a/b'), false);
  assert.equal(insidePath('/c', '/a/b'), false);
  assert.equal(insidePath('D:\\x', 'C:\\y', { relativePath: () => 'D:\\x', isAbsolutePath: () => true, platform: 'win32' }), false);
});

test('stat identity helpers tolerate bigint against number and reject missing timestamps', () => {
  assert.equal(sameStatValue(5n, 5), true);
  assert.equal(sameStatValue(5, 5n), true);
  assert.equal(sameStatValue(5n, 6), false);
  assert.equal(statTimestamp({ mtimeNs: 7n, mtimeMs: 1 }, 'mtime'), 7n);
  assert.equal(statTimestamp({ mtimeMs: 3 }, 'mtime'), 3);
  assert.equal(statTimestamp({ mtime: new Date(9) }, 'mtime'), 9);
  assert.equal(statTimestamp({ mtimeMs: Number.NaN }, 'mtime'), undefined);
  assert.equal(sameTimestamp({}, {}, 'mtime'), false);
  const a = { dev: 1n, ino: 2n, size: 3n, mode: 4n, uid: 5n, mtimeNs: 6n, ctimeNs: 7n };
  assert.equal(sameStatFields(a, { ...a }, ['dev', 'ino', 'uid', 'size', 'mode']), true);
  assert.equal(sameStatFields(a, { ...a, uid: 9n }, ['dev', 'ino', 'uid', 'size', 'mode']), false);
  assert.equal(sameStatFields(a, { ...a, ctimeNs: 8n }, ['dev']), false);
  assert.equal(sameFileIdentity(a, { dev: 1, ino: 2 }), true);
  assert.equal(sameBigintFileStat(a, { ...a }), true);
  assert.equal(sameBigintFileStat({ ...a, dev: 1 }, { ...a, dev: 1 }), false);
  assert.equal(sameBigintFileStat(undefined, a), false);
});

test('transcript limits and identifier rule', () => {
  assert.equal(MAX_MESSAGE_CHARS, 1_000_000);
  assert.equal(MAX_TOOL_CALLS, 64);
  assert.equal(MAX_TOOL_ARGUMENT_CHARS, 512_000);
  assert.equal(validToolIdentifier('call_1', 8), true);
  for (const value of ['', 'x'.repeat(9), 'a\nb', 'a\x7fb', 'a\0b', 5]) assert.equal(validToolIdentifier(value, 8), false);
});

test('escapeRegExp, applyPathAliases and escapesRoot', () => {
  assert.equal(escapeRegExp('a.b*c(x)[y]'), 'a\\.b\\*c\\(x\\)\\[y\\]');
  assert.equal(applyPathAliases('/Users/jack/x /Users/jackson/y', [['/Users/jack', '<home>']]), '<home>/x /Users/jackson/y');
  assert.equal(applyPathAliases('x', [null, ['/a/b', 'L']]), 'x');
  assert.equal(escapesRoot('..'), true);
  assert.equal(escapesRoot(`..${sep}x`), true);
  assert.equal(escapesRoot('/abs'), true);
  for (const rel of ['', 'a', '..b', `a${sep}..b`]) assert.equal(escapesRoot(rel), false);
});
