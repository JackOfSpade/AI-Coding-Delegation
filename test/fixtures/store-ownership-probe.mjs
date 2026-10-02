import { JobStore } from '../../src/store.mjs';

const gitDir = process.env.OFFLOAD_TEST_GIT_DIR;
if (typeof gitDir !== 'string' || !gitDir) throw new Error('OFFLOAD_TEST_GIT_DIR is required');
process.getuid = () => 987654;
try {
  await new JobStore({ gitDir }).init();
  process.exitCode = 1;
} catch (error) {
  if (!/job storage (ancestry|directory) is insecure/.test(error.message)) throw error;
}
