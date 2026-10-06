import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  copyReportInputs,
  MAX_REPORT_INPUT_FILE_BYTES,
  REPORT_INPUT_DIRECTORY,
  prepareReportInputsForCleanup,
  reportInputRootCandidates,
  reportInputRoots,
  validateReportInputFiles,
} from '../../src/report-inputs.mjs';

test('report input root candidates add the physical macOS temp root only on Darwin', () => {
  const darwin = reportInputRootCandidates({ platform: 'darwin', tempDirectory: '/var/folders/example/T', environment: {} });
  const linux = reportInputRootCandidates({ platform: 'linux', tempDirectory: '/tmp', environment: {} });
  assert.deepEqual(darwin, ['/var/folders/example/T', '/private/tmp']);
  assert.deepEqual(linux, ['/tmp']);
});

test('report input roots ignore relative ambient temp spellings rather than resolving them from the server cwd', async () => {
  const roots = await reportInputRoots([], {
    platform: 'linux',
    tempDirectory: '.',
    environment: { TMPDIR: '.', TMP: 'relative', TEMP: '/missing' },
  });
  assert.deepEqual(roots, []);
});

test(
  'Darwin default roots accept /private/tmp and its /tmp alias after canonicalization',
  { skip: process.platform !== 'darwin' },
  async () => {
    const root = await mkdtemp('/private/tmp/offload-report-inputs-');
    const workspace = await mkdtemp(join(tmpdir(), 'offload-report-workspace-'));
    const input = join(root, 'private-tmp-source.json');
    try {
      await writeFile(input, '{"ok":true}\n', { mode: 0o600 });
      const privateTmp = await realpath('/private/tmp');
      const roots = await reportInputRoots();
      assert.ok(roots.includes(privateTmp), 'the physical Darwin scratch root is allowlisted');
      const manifest = await copyReportInputs({ inputFiles: [input.replace('/private/tmp/', '/tmp/')], workspacePath: workspace, roots });
      assert.deepEqual(manifest, [{ path: '.offload-report-inputs/input-01', bytes: Buffer.byteLength('{"ok":true}\n') }]);
    } finally {
      await rm(root, { recursive: true, force: true });
      await prepareReportInputsForCleanup(workspace);
      await rm(workspace, { recursive: true, force: true });
    }
  },
);

test('report inputs reject duplicate paths, final symlinks, and size limits without retaining partial copies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'offload-report-inputs-'));
  const workspace = join(root, 'workspace');
  const good = join(root, 'good.txt');
  const target = join(root, 'target.txt');
  const linked = join(root, 'linked.txt');
  const oversized = join(root, 'oversized.txt');
  const totalFiles = ['first.txt', 'second.txt', 'third.txt', 'fourth.txt', 'fifth.txt'].map((name) => join(root, name));
  await mkdir(workspace);
  await writeFile(good, 'good');
  await writeFile(target, 'target');
  await symlink(target, linked);
  await writeFile(oversized, Buffer.alloc(MAX_REPORT_INPUT_FILE_BYTES + 1));
  for (const file of totalFiles) await writeFile(file, Buffer.alloc(7 * 1024 * 1024));
  try {
    const roots = [await realpath(root)];
    assert.throws(() => validateReportInputFiles([good, good]), /duplicates/);
    await assert.rejects(() => copyReportInputs({ inputFiles: [linked], workspacePath: workspace, roots }), /regular file/);
    await assert.rejects(() => copyReportInputs({ inputFiles: [oversized], workspacePath: workspace, roots }), /no larger/);
    await assert.rejects(() => copyReportInputs({ inputFiles: totalFiles, workspacePath: workspace, roots }), /total limit/);
    assert.equal(existsSync(join(workspace, REPORT_INPUT_DIRECTORY)), false, 'a rejected later input removes the earlier private copy');
    await assert.rejects(access(join(workspace, REPORT_INPUT_DIRECTORY)), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('report input allowlist rejects sibling-prefix and directory-symlink escapes with actionable, basename-free diagnostics', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'offload-report-input-roots-'));
  const root = join(parent, 'allowed');
  const sibling = join(parent, 'allowed-evil');
  const workspace = join(parent, 'workspace');
  const secretName = 'customer-private-export.json';
  try {
    await mkdir(root);
    await mkdir(sibling);
    await mkdir(workspace);
    await writeFile(join(sibling, secretName), 'private');
    await symlink(sibling, join(root, 'escape'));
    const canonicalRoot = await realpath(root);
    const escaped = join(root, 'escape', secretName);
    await assert.rejects(
      () => copyReportInputs({ inputFiles: [join(sibling, secretName)], workspacePath: workspace, roots: [canonicalRoot] }),
      (error) => {
        assert.match(error.message, /outside the caller scratch\/temp allowlist/);
        assert.match(error.message, new RegExp(canonicalRoot.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&')));
        assert.doesNotMatch(error.message, new RegExp(secretName.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&')));
        return true;
      },
    );
    await assert.rejects(
      () => copyReportInputs({ inputFiles: [escaped], workspacePath: workspace, roots: [canonicalRoot] }),
      /outside the caller scratch\/temp allowlist/,
    );
    assert.equal(existsSync(join(workspace, REPORT_INPUT_DIRECTORY)), false, 'rejection leaves no private copied input directory');
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
