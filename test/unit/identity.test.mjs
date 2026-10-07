import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { compareRuntimeIdentity, runtimeIdentity, runtimeIdentityFor } from '../../src/identity.mjs';

test('runtime identity is deterministic and stale decisions expose an actionable installed identity', () => {
  const loaded = runtimeIdentity();
  assert.deepEqual(runtimeIdentityFor(), loaded);
  assert.deepEqual(compareRuntimeIdentity(loaded, loaded), { ...loaded, stale: false, restartRequired: false });

  const changed = { ...loaded, buildHash: `sha256:${'a'.repeat(64)}`, skillHash: `sha256:${'b'.repeat(64)}` };
  const stale = compareRuntimeIdentity(loaded, changed);
  assert.equal(stale.stale, true);
  assert.equal(stale.staleReason, 'runtime-artifacts-changed');
  assert.equal(stale.restartRequired, true);
  assert.equal(stale.installedBuildHash, changed.buildHash);
  assert.equal(stale.installedSkillHash, changed.skillHash);
  assert.match(stale.restartAction, /Restart the MCP client/);

  const unreadable = compareRuntimeIdentity(loaded);
  assert.equal(unreadable.stale, true);
  assert.equal(unreadable.staleReason, 'runtime-artifacts-unreadable');
  assert.equal(unreadable.restartRequired, true);
});

async function product(prefix) {
  const root = await mkdtemp(`${tmpdir()}/${prefix}`);
  await Promise.all(
    ['package.json', 'bin', 'src', 'plugins'].map((path) => cp(join(process.cwd(), path), join(root, path), { recursive: true })),
  );
  return root;
}

test('runtime identity rejects a final symlink and oversized package artifact', async () => {
  const linked = await product('offload-identity-link-');
  const oversized = await product('offload-identity-large-');
  try {
    await rm(join(linked, 'package.json'));
    await symlink(join(process.cwd(), 'package.json'), join(linked, 'package.json'));
    assert.throws(() => runtimeIdentityFor(linked), /regular file/);

    await writeFile(join(oversized, 'plugins', 'offload', 'skills', 'offload', 'SKILL.md'), Buffer.alloc(1_048_577));
    assert.throws(() => runtimeIdentityFor(oversized), /size limit/);
  } finally {
    await Promise.all([rm(linked, { recursive: true, force: true }), rm(oversized, { recursive: true, force: true })]);
  }
});

test('runtime identity advertises the baseline verifier without a schema revision bump', () => {
  const identity = runtimeIdentity();
  assert.equal(identity.capabilities.baselineVerifier, true);
  assert.equal(identity.schemaRevision, 2, 'an additive opt-in feature must not invalidate existing skill preflights');
});

test('runtime identity advertises applyThenVerify as an additive capability', () => {
  const identity = runtimeIdentity();
  assert.equal(identity.capabilities.applyThenVerify, true);
  assert.equal(identity.schemaRevision, 2, 'new offload_apply properties are additive: no schema revision bump');
});

test('runtime identity advertises applying a FAILED job as an additive capability', () => {
  const identity = runtimeIdentity();
  assert.equal(identity.capabilities.failedApply, true);
  assert.equal(identity.schemaRevision, 2, 'offload_apply on a FAILED job is additive: no schema revision bump');
});

test('runtime identity advertises failure diagnostics as an additive capability', () => {
  const identity = runtimeIdentity();
  assert.equal(identity.capabilities.failureDiagnostics, true);
  assert.equal(identity.schemaRevision, 2, 'tail/limit and continue-on-FAILED are additive: no schema revision bump');
});

test('runtime identity advertises the timing breakdown as an additive capability', () => {
  const identity = runtimeIdentity();
  assert.equal(identity.capabilities.timingBreakdown, true);
  assert.equal(identity.schemaRevision, 2, 'timing fields and progress.stall are additive: no schema revision bump');
});

test('runtime identity advertises verifierInterpreter as an additive capability', () => {
  const identity = runtimeIdentity();
  assert.equal(identity.capabilities.verifierInterpreter, true);
  assert.equal(identity.schemaRevision, 2, 'a new optional start/health parameter is additive: no schema revision bump');
});

test('runtime identity advertises the retrospective digest as an additive capability', () => {
  const identity = runtimeIdentity();
  assert.equal(identity.capabilities.retrospective, true);
  assert.equal(identity.schemaRevision, 2, 'include "retrospective" and jobIds are additive: no schema revision bump');
});
