import test from 'node:test';
import assert from 'node:assert/strict';
import { globsOverlap, matchGlob, matchesAny, normalizePath, pathsOverlap } from '../../src/glob.mjs';

test('glob matching supports path segments, recursive stars and character classes', () => {
  assert.equal(matchGlob('src/a/file.mjs', 'src/**/*.mjs'), true);
  assert.equal(matchGlob('src/file.mjs', 'src/**/*.mjs'), true);
  assert.equal(matchGlob('src/file.js', 'src/**/*.mjs'), false);
  assert.equal(matchGlob('x/a1.txt', 'x/a[0-9].txt'), true);
  assert.equal(matchesAny('test/a.mjs', ['src/**', 'test/**']), true);
  assert.equal(matchGlob('.env.local', '.env*'), true);
  assert.equal(matchGlob('a/b', '**/b'), true);
  assert.equal(matchGlob('a/[', 'a/['), true);
  assert.equal(matchGlob('a/x', 'a/[]'), false);
  assert.equal(matchGlob('a/b', 'a/[!a]'), true);
  assert.equal(matchGlob('a/', 'a/[!a]'), false, 'a character class must never cross a path separator');
  assert.equal(normalizePath('./src/./a.mjs'), 'src/a.mjs');
  assert.throws(() => normalizePath('C:/outside'));
  assert.throws(() => normalizePath('../secret'));
});
test('overlap detection proves obvious disjoint scopes and is conservative for wildcard scopes', () => {
  assert.equal(globsOverlap('src/**', 'test/**'), false);
  assert.equal(globsOverlap('src/a.mjs', 'src/b.mjs'), false);
  assert.equal(globsOverlap('src/**', 'src/a.mjs'), true);
  assert.equal(globsOverlap('src/*.mjs', 'src/*.js'), true);
  assert.equal(globsOverlap('src/[ab].js', 'src/c.js'), false);
  assert.equal(globsOverlap('src/**/a.js', 'src/a.js'), true);
  assert.equal(globsOverlap('src/a/**', 'src/a'), true);
  assert.equal(pathsOverlap(['src/**'], ['docs/**', 'src/x/**']), true);
});

test('Windows matching is case-insensitive and rejects ADS/device aliases', () => {
  const win = { platform: 'win32' };
  assert.equal(matchGlob('.ENV', '.env*', win), true);
  assert.equal(matchGlob('.ENV', '.env*', { platform: 'linux' }), false);
  assert.equal(pathsOverlap(['SRC/**'], ['src/a.mjs'], win), true);
  for (const value of ['src/file:secret', 'CON', 'nul.txt', 'src/trailing.'])
    assert.throws(() => normalizePath(value, win), /Windows path/);
});
