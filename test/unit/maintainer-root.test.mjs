import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SOURCE_RECORD,
  isOffloadSourceCheckout,
  readSourceRecord,
  recordSourceRoot,
  resolveMaintainerRoot,
} from '../../src/maintainer-root.mjs';

const made = [];
after(() => Promise.all(made.map((dir) => rm(dir, { recursive: true, force: true }))));
const temp = async (prefix) => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  made.push(dir);
  return dir;
};
/** A directory shaped like an Offload source checkout (git, install.mjs, package name). */
const checkout = async ({ git = true, name = 'offload', installer = true } = {}) => {
  const dir = await temp('offload-src-');
  if (git) await mkdir(join(dir, '.git'));
  if (installer) await writeFile(join(dir, 'install.mjs'), '// installer\n');
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name }));
  return dir;
};
/** A packed install: the same files, no .git. */
const packed = () => checkout({ git: false });
const FIXED = () => new Date('2026-11-09T00:00:00.000Z');

test('an Offload source checkout needs .git, install.mjs and package name "offload"', async () => {
  assert.equal(isOffloadSourceCheckout(await checkout()), true);
  assert.equal(isOffloadSourceCheckout(await checkout({ git: false })), false);
  assert.equal(isOffloadSourceCheckout(await checkout({ name: 'other' })), false);
  assert.equal(isOffloadSourceCheckout(await checkout({ installer: false })), false);
  assert.equal(isOffloadSourceCheckout('relative/offload'), false);
  assert.equal(isOffloadSourceCheckout(undefined), false);
});

test('resolveMaintainerRoot: config wins, then a git package root, then a live recorded source, else nothing', async () => {
  const source = await checkout();
  const install = await packed();
  // An explicit configuration is named as given, even for a packed install.
  assert.equal(resolveMaintainerRoot({ configured: '/opt/offload', packageRoot: install }), '/opt/offload');
  // A package root that is itself a git checkout (running from source) names itself.
  assert.equal(resolveMaintainerRoot({ packageRoot: source }), source);
  // A packed install with no record names nothing: never the untestable package path.
  assert.equal(resolveMaintainerRoot({ packageRoot: install }), undefined);
  // With the installer's record, the source checkout is named.
  recordSourceRoot({ packageRoot: install, sourceRoot: source, now: FIXED });
  assert.equal(resolveMaintainerRoot({ packageRoot: install }), source);
  // A record whose checkout is gone (moved, deleted, or no longer a git checkout) names nothing.
  await rm(join(source, '.git'), { recursive: true });
  assert.equal(resolveMaintainerRoot({ packageRoot: install }), undefined);
  await rm(source, { recursive: true });
  assert.equal(resolveMaintainerRoot({ packageRoot: install }), undefined);
});

test('a malformed, relative or oversized source record is ignored', async () => {
  const install = await packed();
  const record = join(install, SOURCE_RECORD);
  for (const content of ['not json', JSON.stringify({ sourceRoot: 'relative/src' }), JSON.stringify({ sourceRoot: '/x\nInjected' })]) {
    await writeFile(record, content);
    assert.equal(readSourceRecord(install), undefined, content);
    assert.equal(resolveMaintainerRoot({ packageRoot: install }), undefined, content);
  }
  await writeFile(record, JSON.stringify({ sourceRoot: '/opt/offload', pad: 'x'.repeat(5000) }));
  assert.equal(readSourceRecord(install), undefined);
});

test('recordSourceRoot writes the explicit source, or the cwd only when it qualifies', async () => {
  const source = await checkout();
  const install = await packed();
  assert.deepEqual(recordSourceRoot({ packageRoot: install, sourceRoot: source, now: FIXED }), {
    sourceRoot: source,
    path: join(install, SOURCE_RECORD),
  });
  assert.deepEqual(JSON.parse(await readFile(join(install, SOURCE_RECORD), 'utf8')), {
    sourceRoot: source,
    recordedAt: '2026-11-09T00:00:00.000Z',
  });

  const other = await packed();
  assert.deepEqual(recordSourceRoot({ packageRoot: other, cwd: source, now: FIXED }), {
    sourceRoot: source,
    path: join(other, SOURCE_RECORD),
  });
  // A cwd that is not an Offload checkout is skipped silently and writes nothing.
  const third = await packed();
  assert.deepEqual(recordSourceRoot({ packageRoot: third, cwd: await temp('not-offload-') }), { skipped: 'no-source-checkout' });
  await assert.rejects(lstat(join(third, SOURCE_RECORD)), { code: 'ENOENT' });
  // An explicit source that does not qualify is refused.
  const notGit = await packed();
  assert.throws(() => recordSourceRoot({ packageRoot: third, sourceRoot: notGit }), /--source-root must be/);
  // Running the installer from the source checkout itself never writes a record into it.
  assert.deepEqual(recordSourceRoot({ packageRoot: source, cwd: source }), { skipped: 'package-root-is-checkout' });
  await assert.rejects(lstat(join(source, SOURCE_RECORD)), { code: 'ENOENT' });
});

test('recordSourceRoot replaces a symlink at the record path instead of writing through it', async () => {
  const source = await checkout();
  const install = await packed();
  const target = join(await temp('offload-target-'), 'victim.json');
  await writeFile(target, 'untouched');
  await symlink(target, join(install, SOURCE_RECORD));
  recordSourceRoot({ packageRoot: install, sourceRoot: source, now: FIXED });
  assert.equal(await readFile(target, 'utf8'), 'untouched');
  assert.equal((await lstat(join(install, SOURCE_RECORD))).isSymbolicLink(), false);
  assert.equal(readSourceRecord(install), source);
});
