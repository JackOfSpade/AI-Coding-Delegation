import test from 'node:test';
import assert from 'node:assert/strict';
import { assertVerifierCommand, isTsxCliCommand } from '../../src/verifier-command.mjs';

for (const command of [
  'npx tsx scripts/check.ts',
  'tsx --test test/check.ts',
  './node_modules/.bin/tsx check.ts',
  '  npx --no-install tsx check.ts',
  'npx -y tsx@4.23.15 check.ts',
  'npx -- tsx check.ts',
  'NODE_ENV=test npx tsx check.ts',
  'env NODE_ENV=test tsx check.ts',
  '"/opt/my tools/tsx" check.ts',
  "'npx' 'tsx' check.ts",
  'npx tsx watch check.ts',
]) {
  test(`tsx verifier preflight refuses ${command}`, () => {
    assert.equal(isTsxCliCommand(command), true);
    assert.throws(
      () => assertVerifierCommand(command),
      (error) =>
        error.code === 'E_VERIFIER_TSX_CLI' && error.message.includes('node --import tsx') && !error.message.includes('scripts/check.ts'),
    );
  });
}

test('tsx preflight allows loader commands, wrappers and ordinary mentions without changing shell text', () => {
  for (const command of [
    'node --import tsx check.ts',
    'node --import=tsx --test check.ts',
    'npm test',
    'echo npx tsx',
    'node -e \'console.log("npx tsx")\'',
    'npx tsx-other check.ts',
    'npx prettier tsx',
    'tsx-check test',
    undefined,
  ]) {
    assert.equal(isTsxCliCommand(command), false, String(command));
    assert.doesNotThrow(() => assertVerifierCommand(command));
  }
});
