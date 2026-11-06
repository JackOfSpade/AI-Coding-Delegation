import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { gitBinary } from '../../src/git-binary.mjs';

const REAL = '/Applications/Xcode.app/Contents/Developer/usr/bin/git';

// A fake filesystem: `files` maps a path to { exec, real } (real defaults to itself).
const fakeFs = (files) => ({
  statSync(path) {
    if (!Object.hasOwn(files, path)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return { isFile: () => files[path].dir !== true };
  },
  accessSync(path) {
    if (!Object.hasOwn(files, path) || !files[path].exec) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
  },
  realpathSync(path) {
    if (!Object.hasOwn(files, path)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return files[path].real ?? path;
  },
});
const xcrun = (output, calls = []) =>
  Object.assign(
    (file, args, options) => {
      calls.push({ file, args, env: options.env });
      if (output instanceof Error) throw output;
      return output;
    },
    { calls },
  );
const shimFs = (extra = {}) => fakeFs({ '/usr/bin/git': { exec: true }, [REAL]: { exec: true }, ...extra });
const resolve = (env, { fs = shimFs(), execFile = xcrun(`${REAL}\n`), platform = 'darwin', memo = new Map() } = {}) =>
  gitBinary(env, { fs, execFile, platform, memo });

test('gitBinary keeps plain git off macOS without probing anything', () => {
  const execFile = xcrun(`${REAL}\n`);
  for (const platform of ['linux', 'win32']) assert.equal(resolve({ PATH: '/usr/bin' }, { platform, execFile, fs: fakeFs({}) }), 'git');
  assert.equal(execFile.calls.length, 0);
});

test('gitBinary replaces the macOS /usr/bin/git shim with the binary xcrun names, asked with the call environment', () => {
  const execFile = xcrun(`${REAL}\n`);
  const env = { PATH: '/nowhere:/usr/bin', HOME: '/h' };
  assert.equal(resolve(env, { execFile }), REAL);
  assert.deepEqual(
    execFile.calls.map(({ file, args }) => [file, args]),
    [['/usr/bin/xcrun', ['--find', 'git']]],
  );
  assert.equal(execFile.calls[0].env, env);
});

test('gitBinary leaves a git found earlier on PATH alone', () => {
  const execFile = xcrun(`${REAL}\n`);
  const fs = shimFs({ '/opt/homebrew/bin/git': { exec: true, real: '/opt/homebrew/Cellar/git/2.50.0/bin/git' } });
  assert.equal(resolve({ PATH: '/opt/homebrew/bin:/usr/bin' }, { fs, execFile }), 'git');
  // A non-executable or relative entry is skipped exactly as a PATH search skips it.
  const skipped = shimFs({ '/opt/homebrew/bin/git': { exec: false } });
  assert.equal(resolve({ PATH: 'relative:/opt/homebrew/bin:/usr/bin' }, { fs: skipped }), REAL);
  assert.equal(execFile.calls.length, 0);
});

test('gitBinary falls back to plain git when the shim cannot be resolved safely', () => {
  const cases = [
    ['xcrun fails', { execFile: xcrun(new Error('xcrun: error: invalid active developer path')) }],
    ['relative answer', { execFile: xcrun('usr/bin/git\n') }],
    ['control characters', { execFile: xcrun(`${REAL}\u001b[0m\n`) }],
    ['the shim itself', { execFile: xcrun('/usr/bin/git\n') }],
    ['missing target', { fs: fakeFs({ '/usr/bin/git': { exec: true } }) }],
    ['non-executable target', { fs: shimFs({ [REAL]: { exec: false } }) }],
    ['directory target', { fs: shimFs({ [REAL]: { exec: true, dir: true } }) }],
    ['no git on PATH', { fs: fakeFs({}) }],
    ['undefined PATH', { env: {} }],
  ];
  for (const [name, options] of cases) assert.equal(resolve(options.env ?? { PATH: '/usr/bin' }, options), 'git', name);
});

test('gitBinary resolves once per environment and re-resolves a cached path that disappeared', () => {
  const memo = new Map();
  const files = { '/usr/bin/git': { exec: true }, [REAL]: { exec: true } };
  const execFile = xcrun(`${REAL}\n`);
  const fs = fakeFs(files);
  const env = { PATH: '/usr/bin' };
  assert.equal(resolve(env, { fs, execFile, memo }), REAL);
  assert.equal(resolve(env, { fs, execFile, memo }), REAL);
  assert.equal(execFile.calls.length, 1, 'a cached path is reused');
  // DEVELOPER_DIR selects what the shim runs, so it gets its own entry.
  assert.equal(resolve({ ...env, DEVELOPER_DIR: '/Library/Developer/CommandLineTools' }, { fs, execFile, memo }), REAL);
  assert.equal(execFile.calls.length, 2);
  delete files[REAL];
  assert.equal(resolve(env, { fs, execFile, memo }), 'git', 'a removed developer directory falls back');
  assert.equal(execFile.calls.length, 3, 'a vanished cached path is resolved again, not reused');
});

test('gitBinary on this host runs the same git as PATH resolution would', { skip: process.platform !== 'darwin' }, () => {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME };
  const resolved = gitBinary(env);
  if (resolved !== 'git') {
    assert.ok(resolved.startsWith('/') && existsSync(resolved));
    assert.notEqual(resolved, '/usr/bin/git');
  }
  const version = (bin) => execFileSync(bin, ['--version'], { encoding: 'utf8', env }).trim();
  assert.equal(version(resolved), version('git'));
});
