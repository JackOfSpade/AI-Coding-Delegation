import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { macosProfile } from '../../src/sandbox.mjs';
import { repairBrief, REPAIR_FIXTURE_NOTE } from '../../src/core.mjs';

const profile = (extra = {}) => macosProfile({ repoPath: '/repo', tempPath: '/tmp/offload-sandbox-x', ...extra });

test('the verifier profile grants loopback only on request and never a general network rule', () => {
  assert.doesNotMatch(profile(), /allow network/);
  const on = profile({ allowLoopback: true });
  assert.match(on, /\(allow network-bind \(local ip "localhost:\*"\)\)/);
  assert.match(on, /\(allow network-inbound \(local ip "localhost:\*"\)\)/);
  assert.match(on, /\(allow network-outbound \(remote ip "localhost:\*"\)\)/);
  assert.doesNotMatch(on, /\(allow network\*\)/);
  assert.throws(() => profile({ allowLoopback: 'yes' }), /allowLoopback must be boolean/);
});

test(
  'real sandbox-exec: loopback bind and connect work only when granted, and egress stays denied',
  { skip: process.platform !== 'darwin' },
  (t) => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'loopback-')));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const serve = join(dir, 'serve.mjs');
    writeFileSync(
      serve,
      `import net from 'node:net';
const s = net.createServer((c) => c.end('hi'));
s.on('error', (e) => { console.log('ERR ' + e.message); process.exit(2); });
s.listen(0, '127.0.0.1', () => {
  const c = net.connect(s.address().port, '127.0.0.1');
  c.on('data', (d) => { console.log('OK ' + d); s.close(); });
  c.on('error', (e) => { console.log('CERR ' + e.message); process.exit(3); });
});`,
    );
    const egress = join(dir, 'egress.mjs');
    writeFileSync(
      egress,
      `import net from 'node:net';
const c = net.connect(443, '1.1.1.1');
c.setTimeout(2000);
c.on('connect', () => { console.log('EGRESS'); process.exit(1); });
c.on('error', (e) => { console.log('blocked ' + e.code); process.exit(0); });
c.on('timeout', () => { console.log('blocked timeout'); process.exit(0); });`,
    );
    const base = '(version 1)(deny default)(allow process*)(allow sysctl-read)(allow file-read*)';
    const lines = profile({ allowLoopback: true })
      .split('\n')
      .filter((line) => /network/.test(line));
    const run = (sb, file) => spawnSync('sandbox-exec', ['-p', sb, process.execPath, file], { encoding: 'utf8', timeout: 20_000 });
    const denied = run(base, serve);
    assert.match(denied.stdout, /ERR listen EPERM: operation not permitted/);
    assert.equal(run(`${base}\n${lines.join('\n')}`, serve).stdout.trim(), 'OK hi');
    const outside = run(`${base}\n${lines.join('\n')}`, egress);
    assert.equal(outside.status, 0, outside.stdout);
    assert.match(outside.stdout, /blocked/);
  },
);

test('every repair brief tells the worker not to restructure pre-existing fixtures around a sandbox denial', () => {
  for (const brief of [repairBrief(['Verifier failed:\nlisten EPERM']), repairBrief([]), repairBrief(undefined)]) {
    assert.match(brief, /^Repair these concrete defects:\n- /);
    assert.ok(brief.endsWith(REPAIR_FIXTURE_NOTE));
  }
  assert.match(REPAIR_FIXTURE_NOTE, /Do not restructure, skip, or weaken pre-existing test files or fixtures/);
  assert.match(REPAIR_FIXTURE_NOTE, /failed listen\/bind/);
  assert.match(REPAIR_FIXTURE_NOTE, /list the denial under concerns/);
});
