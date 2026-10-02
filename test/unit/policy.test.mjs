import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { PathPolicy } from '../../src/policy.mjs';
import { cleanup, tempDir, write } from './helpers.mjs';

test('path policy permits only declared writes and protects secrets', () => {
  const repo = tempDir();
  try {
    write(join(repo, 'src', 'a.mjs'), 'export {}');
    write(join(repo, '.env'), 'TOP_SECRET');
    const policy = new PathPolicy({ repoPath: repo, ownedPaths: ['src/**'], extraWritable: ['build/**'] });
    assert.equal(policy.assertReadable('src/a.mjs'), join(policy.repoPath, 'src', 'a.mjs'));
    assert.throws(
      () => policy.assertReadable('.env'),
      (error) => error.code === 'E_READ_DENIED',
    );
    assert.equal(policy.assertWritable('src/new.mjs'), join(policy.repoPath, 'src', 'new.mjs'));
    assert.equal(policy.assertWritable('build/out.txt'), join(policy.repoPath, 'build', 'out.txt'));
    assert.throws(
      () => policy.assertWritable('README.md'),
      (error) => error.code === 'E_WRITE_SCOPE',
    );
    assert.throws(
      () => policy.resolve('../elsewhere'),
      (error) => error.code === 'E_PATH_ESCAPE',
    );
    assert.throws(
      () => policy.resolve(join(outsidePath(repo), 'outside')),
      (error) => error.code === 'E_PATH_ESCAPE',
    );
    assert.throws(
      () => policy.assertReadable('.git'),
      (error) => error.code === 'E_READ_DENIED',
    );
  } finally {
    cleanup(repo);
  }
});
test(
  'path policy rejects broken symlink and lexical escapes before a write can follow them',
  { skip: process.platform === 'win32' && 'Windows symlink creation requires Developer Mode or elevation' },
  () => {
    const repo = tempDir();
    const outside = tempDir();
    try {
      mkdirSync(join(repo, 'src'), { recursive: true });
      symlinkSync(join(outside, 'future.txt'), join(repo, 'src', 'broken'));
      const policy = new PathPolicy({ repoPath: repo, ownedPaths: ['src/**'], denyRead: ['src/private/**'] });
      assert.throws(
        () => policy.assertWritable('src/broken'),
        (error) => error.code === 'E_PATH_ESCAPE',
      );
      assert.throws(
        () => policy.assertReadable('src/../README.md'),
        (error) => error.code === 'E_PATH_ESCAPE',
      );
      write(join(repo, 'src', 'private', 'x.txt'), 'x');
      assert.throws(
        () => policy.assertReadable('src/private/x.txt'),
        (error) => error.code === 'E_READ_DENIED',
      );
    } finally {
      cleanup(repo);
      cleanup(outside);
    }
  },
);
test('write scope cannot override protected Git metadata or likely secret paths', () => {
  const repo = tempDir();
  try {
    mkdirSync(join(repo, '.git'), { recursive: true });
    write(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    write(join(repo, '.env.production'), 'secret');
    write(join(repo, 'id_rsa'), 'key');
    const policy = new PathPolicy({ repoPath: repo, ownedPaths: ['**'], extraWritable: ['**'] });
    for (const path of ['.git/HEAD', '.env.production', 'id_rsa', '.offload.json', 'nested/.offload.json']) {
      assert.throws(
        () => policy.assertWritable(path),
        (error) => error.code === 'E_WRITE_DENIED',
      );
    }
  } finally {
    cleanup(repo);
  }
});
test('nested sensitive roots deny exact pointer files to broad read and write scopes', () => {
  const repo = tempDir();
  try {
    const pointers = ['nested/.git', 'nested/.aws', 'nested/.ssh', 'nested/.azure', 'nested/.kube', 'nested/.config/gcloud'];
    for (const pointer of pointers) write(join(repo, pointer), 'credential-or-pointer');
    const policy = new PathPolicy({ repoPath: repo, ownedPaths: ['**'], extraWritable: ['**'] });
    for (const pointer of pointers) {
      assert.throws(
        () => policy.assertReadable(pointer),
        (error) => error.code === 'E_READ_DENIED',
        `${pointer} must not be readable`,
      );
      assert.throws(
        () => policy.assertWritable(pointer),
        (error) => error.code === 'E_WRITE_DENIED',
        `${pointer} must not be writable`,
      );
    }
  } finally {
    cleanup(repo);
  }
});
test('default read deny covers common credential files without blocking normal source', () => {
  const repo = tempDir();
  try {
    for (const file of [
      '.npmrc',
      '.netrc',
      '.pypirc',
      '.git-credentials',
      '.pgpass',
      '.credentials/token',
      'deploy/credentials/token',
      'credentials.json',
      'deploy/credentials.yaml',
      'credential.json',
      'certs/client.p12',
      'certs/client.pfx',
      'certs/client.jks',
      'certs/client.keystore',
      'terraform.tfstate',
      'terraform.tfstate.backup',
      '.aws/credentials',
      '.config/gcloud/application_default_credentials.json',
      '.docker/config.json',
      'id_ed25519',
      'src/id_utils.mjs',
      'src/credentials.ts',
    ])
      write(join(repo, file), 'value');
    const policy = new PathPolicy({ repoPath: repo, ownedPaths: ['src/**'] });
    for (const file of [
      '.npmrc',
      '.netrc',
      '.pypirc',
      '.git-credentials',
      '.pgpass',
      '.credentials/token',
      'deploy/credentials/token',
      'credentials.json',
      'deploy/credentials.yaml',
      'credential.json',
      'certs/client.p12',
      'certs/client.pfx',
      'certs/client.jks',
      'certs/client.keystore',
      'terraform.tfstate',
      'terraform.tfstate.backup',
      '.aws/credentials',
      '.config/gcloud/application_default_credentials.json',
      '.docker/config.json',
      'id_ed25519',
    ])
      assert.throws(
        () => policy.assertReadable(file),
        (error) => error.code === 'E_READ_DENIED',
      );
    assert.equal(policy.assertReadable('src/id_utils.mjs'), join(policy.repoPath, 'src', 'id_utils.mjs'));
    assert.equal(policy.assertReadable('src/credentials.ts'), join(policy.repoPath, 'src', 'credentials.ts'));
  } finally {
    cleanup(repo);
  }
});

test('default credential deny patterns are case-insensitive on every host', () => {
  const repo = tempDir();
  try {
    for (const file of ['.PGPASS', 'CONFIG/CREDENTIALS.JSON', 'keys/CLIENT.P12', 'state/TERRAFORM.TFSTATE.BACKUP'])
      write(join(repo, file), 'value');
    const policy = new PathPolicy({ repoPath: repo, ownedPaths: ['src/**'], platform: 'linux' });
    for (const file of ['.PGPASS', 'CONFIG/CREDENTIALS.JSON', 'keys/CLIENT.P12', 'state/TERRAFORM.TFSTATE.BACKUP'])
      assert.throws(
        () => policy.assertReadable(file),
        (error) => error.code === 'E_READ_DENIED',
      );
  } finally {
    cleanup(repo);
  }
});

test('Windows policy folds casing and rejects alias/stream path inputs', () => {
  const repo = tempDir();
  try {
    write(join(repo, '.ENV'), 'secret');
    write(join(repo, 'ID_ED25519'), 'secret');
    write(join(repo, 'SRC', 'a.mjs'), 'source');
    const policy = new PathPolicy({ repoPath: repo, ownedPaths: ['src/**'], platform: 'win32' });
    assert.throws(
      () => policy.assertReadable('.ENV'),
      (error) => error.code === 'E_READ_DENIED',
    );
    assert.throws(
      () => policy.assertReadable('ID_ED25519'),
      (error) => error.code === 'E_READ_DENIED',
    );
    assert.equal(policy.assertWritable('SRC/new.mjs'), join(policy.repoPath, 'SRC', 'new.mjs'));
    for (const input of ['src/file:secret', 'CON', 'NUL.txt', 'src/trailing '])
      assert.throws(
        () => policy.assertWritable(input),
        (error) => error.code === 'E_PATH_INVALID',
      );
  } finally {
    cleanup(repo);
  }
});

test('scope patterns reject every control character before reaching tool or sandbox boundaries', () => {
  const repo = tempDir();
  try {
    for (const value of ['src/with\ttab.txt', 'src/with\u001bescape.txt', 'src/with\u007fdelete.txt']) {
      assert.throws(
        () => new PathPolicy({ repoPath: repo, ownedPaths: [value] }),
        (error) => error.code === 'E_PATH_PATTERNS',
      );
    }
  } finally {
    cleanup(repo);
  }
});

test('secret denies fold casing on every host while owned scopes retain host semantics', () => {
  const repo = tempDir();
  try {
    write(join(repo, '.ENV'), 'secret');
    write(join(repo, 'ID_RSA'), 'secret');
    write(join(repo, 'SRC', 'a.mjs'), 'source');
    const policy = new PathPolicy({ repoPath: repo, ownedPaths: ['src/**'], platform: 'linux' });
    assert.throws(
      () => policy.assertReadable('.ENV'),
      (error) => error.code === 'E_READ_DENIED',
    );
    assert.throws(
      () => policy.assertReadable('ID_RSA'),
      (error) => error.code === 'E_READ_DENIED',
    );
    assert.throws(
      () => policy.assertWritable('SRC/a.mjs'),
      (error) => error.code === 'E_WRITE_SCOPE',
    );
  } finally {
    cleanup(repo);
  }
});

function outsidePath(repo) {
  return `${repo}/../outside`;
}
test(
  'path policy blocks symlink escapes and scope bypasses through internal symlinks',
  { skip: process.platform === 'win32' && 'Windows symlink creation requires Developer Mode or elevation' },
  () => {
    const repo = tempDir();
    const outside = tempDir();
    try {
      write(join(outside, 'secret.txt'), 'secret');
      mkdirSync(join(repo, 'src'), { recursive: true });
      symlinkSync(outside, join(repo, 'src', 'out'));
      const policy = new PathPolicy({ repoPath: repo, ownedPaths: ['src/**'] });
      assert.throws(
        () => policy.assertReadable('src/out/secret.txt'),
        (error) => error.code === 'E_PATH_ESCAPE',
      );
      write(join(repo, 'other', 'a.txt'), 'x');
      symlinkSync(join(repo, 'other'), join(repo, 'src', 'other'));
      assert.throws(
        () => policy.assertWritable('src/other/b.txt'),
        (error) => error.code === 'E_WRITE_SCOPE',
      );
    } finally {
      cleanup(repo);
      cleanup(outside);
    }
  },
);
