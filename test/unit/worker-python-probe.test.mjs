import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { probeWorkerPython } from '../../src/sandbox.mjs';

const harness = (result, { throws } = {}) => {
  const calls = [];
  const removed = [];
  return {
    calls,
    removed,
    options: {
      platform: 'darwin',
      mkdtemp: (prefix) => `${prefix}scratch`,
      rm: (path) => removed.push(path),
      tmpdir: () => '/var/folders/x',
      run: async (command, options) => {
        calls.push({ command, options });
        if (throws) throw throws;
        return result;
      },
    },
  };
};
const probe = async (result, extra) => {
  const h = harness(result, extra);
  return { h, value: await probeWorkerPython(h.options) };
};

test('worker python probe: runs', async () => {
  const { value } = await probe({ code: 0, stdout: '7\n', stderr: '' });
  assert.equal(value.python, 'runs');
});

test('worker python probe: realpath denial is blocked and leaks no path text', async () => {
  const { value } = await probe({
    code: 1,
    stdout: '',
    stderr: ': realpath: /Library/Developer/CommandLineTools/usr/bin/: Operation not permitted',
  });
  assert.equal(value.python, 'blocked');
  assert.equal(value.reason, 'worker-profile-denies-python');
  assert.match(value.note, /verifierInterpreter is verifier-only/);
  assert.doesNotMatch(JSON.stringify(value), /Library|CommandLineTools|realpath|\/var\//);
});

test('worker python probe: exec denial (code 126) is blocked', async () => {
  assert.equal((await probe({ code: 126, stdout: '', stderr: '' })).value.python, 'blocked');
});

test('worker python probe: code 127 is missing', async () => {
  const { value } = await probe({ code: 127, stdout: '', stderr: 'env: python3: No such file or directory' });
  assert.equal(value.python, 'missing');
  assert.doesNotMatch(JSON.stringify(value), /env:/);
});

test('worker python probe: timeout, thrown error and odd output are unknown', async () => {
  assert.deepEqual((await probe({ timedOut: true, code: null })).value, { python: 'unknown', reason: 'probe-timed-out' });
  const thrown = (await probe(undefined, { throws: new Error('boom at /secret/path') })).value;
  assert.deepEqual(thrown, { python: 'unknown', reason: 'probe-failed' });
  assert.equal((await probe({ code: 0, stdout: 'x', stderr: '' })).value.python, 'unknown');
});

test('worker python probe: unavailable sandbox and non-darwin are not-probed', async () => {
  assert.deepEqual((await probe(undefined, { throws: new Error('Required macOS sandbox is unavailable') })).value, {
    python: 'not-probed',
    reason: 'no-worker-sandbox',
  });
  const h = harness({ code: 0, stdout: '7' });
  assert.deepEqual(await probeWorkerPython({ ...h.options, platform: 'linux' }), { python: 'not-probed', reason: 'no-worker-sandbox' });
  assert.equal(h.calls.length, 0);
});

test('worker python probe runs sandboxed with the worker option shape and removes its scratch dir', async () => {
  const { h } = await probe({ code: 126, stdout: '', stderr: '' });
  assert.equal(h.calls.length, 1);
  const { command, options } = h.calls[0];
  assert.equal(command, '/usr/bin/env python3 -c "print(7)"');
  assert.equal(options.requireSandbox, true);
  assert.equal(options.cwd, '/var/folders/x/offload-worker-probe-scratch');
  assert.ok(!('interpreterPaths' in options) && !('interpreterMetadataPaths' in options));
  assert.deepEqual(h.removed, [options.cwd]);
  const failed = await probe(undefined, { throws: new Error('x') });
  assert.equal(failed.h.removed.length, 1, 'scratch removed after a failing run too');
});

test('worker python probe against the real sandbox returns an allowed value', { skip: process.platform !== 'darwin' }, async (t) => {
  const value = await probeWorkerPython();
  assert.ok(['runs', 'blocked', 'missing', 'unknown', 'not-probed'].includes(value.python), JSON.stringify(value));
  if (value.python === 'not-probed') return t.skip('no macOS sandbox on this host');
  // Documents today's worker profile: no interpreter grant, so system Python cannot start.
  if (existsSync('/usr/bin/python3') && value.python !== 'unknown') assert.equal(value.python, 'blocked', JSON.stringify(value));
});
