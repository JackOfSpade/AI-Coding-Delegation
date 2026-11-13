import test from 'node:test';
import assert from 'node:assert/strict';
import { macosProfile } from '../../src/sandbox.mjs';

// The physical per-run directory the profile grants and the host's lexical
// spelling of it (`/var/folders/...` is a symlink to `/private/var/folders/...`).
const physical = '/private/var/folders/ab/T/offload-sandbox-X';
const alias = '/var/folders/ab/T/offload-sandbox-X';
const profile = (extra = {}) => macosProfile({ repoPath: '/repo', tempPath: physical, ...extra });
const lines = (profile) => profile.split('\n');
const metadataLiterals = (profile) =>
  [...profile.matchAll(/^\(allow file-read-metadata \(literal "([^"]*)"\)\)$/gm)].map((match) => match[1]);
const writeRoots = (profile) => [...profile.matchAll(/^\(allow file-write\* \(subpath "([^"]*)"\)\)$/gm)].map((match) => match[1]);

test('the macOS profile resolves the host spelling of the temp directory from metadata only', () => {
  const plain = profile();
  const aliased = profile({ tempAliasPath: alias });
  const plainMetadata = metadataLiterals(plain).filter((value) => value === '/var' || value.startsWith('/var/'));
  assert.deepEqual(plainMetadata, [], 'without the alias nothing under /var is metadata-readable');

  // Seatbelt resolves `/var/...` through the symlink onto the granted physical
  // directory; it only needs to stat the symlink path's own nodes.
  const aliasedMetadata = metadataLiterals(aliased);
  for (const ancestor of ['/var', '/var/folders', '/var/folders/ab', '/var/folders/ab/T'])
    assert.ok(aliasedMetadata.includes(ancestor), `${ancestor} is readable as metadata`);

  // The addition is exactly those literals: every rule that names the lexical
  // spelling is a metadata literal, never a read or write grant.
  for (const line of lines(aliased)) {
    if (!line.includes('"/var')) continue;
    assert.match(line, /^\(allow file-read-metadata \(literal "\/var[^"]*"\)\)$/, line);
  }
  assert.doesNotMatch(aliased, /\(allow file-(?:read|write)[^\n]*subpath "\/var/);
  const plainLines = new Set(lines(plain));
  const added = lines(aliased).filter((line) => !plainLines.has(line));
  assert.notDeepEqual(added, [], 'the alias adds rules');
  for (const line of added) assert.match(line, /^\(allow file-read-metadata \(literal "\/var[^"]*"\)\)$/, line);
  assert.ok(added.includes('(allow file-read-metadata (literal "/var"))'), added.join('\n'));

  // Write grants are untouched by the alias: still the one physical root.
  assert.deepEqual(writeRoots(aliased), writeRoots(plain));
  assert.deepEqual(writeRoots(aliased), [physical]);
});

test('tempAliasPath requires an absolute path and a tempPath to grant', () => {
  assert.throws(() => macosProfile({ repoPath: '/repo', tempAliasPath: alias }), {
    name: 'TypeError',
    message: /tempAliasPath requires tempPath/,
  });
  assert.throws(() => macosProfile({ repoPath: '/repo', tempPath: physical, tempAliasPath: 'var/folders/ab/T/x' }), {
    name: 'TypeError',
    message: /tempAliasPath must be absolute/,
  });
});
