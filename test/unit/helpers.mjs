import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

export function tempDir(prefix = 'offload-test-') {
  return mkdtempSync(join(tmpdir(), prefix));
}
export function cleanup(path) {
  rmSync(path, { recursive: true, force: true });
}
export function write(path, contents, mode) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, mode === undefined ? undefined : { mode });
}
export function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
export function makeRepo() {
  const repo = tempDir('offload-repo-');
  git(repo, ['init']);
  git(repo, ['config', 'user.email', 'tests@example.invalid']);
  git(repo, ['config', 'user.name', 'Tests']);
  write(join(repo, 'tracked.txt'), 'base\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'initial']);
  return repo;
}
