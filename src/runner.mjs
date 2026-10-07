import { runCommand, sandboxStatus } from './sandbox.mjs';

export class Runner {
  constructor({ execute = runCommand, defaults = {}, probeSandbox = sandboxStatus } = {}) {
    this.execute = execute;
    this.defaults = defaults;
    this.probeSandbox = probeSandbox;
  }
  /**
   * Whether a sandboxed command can run on this host, with the host's reason
   * when not. It is a preflight only: a command that requires the sandbox still
   * fails closed in runCommand if its own profile cannot be applied.
   */
  sandboxStatus(platform = process.platform) {
    return this.probeSandbox(platform);
  }
  sandboxAvailable(platform = process.platform) {
    return this.sandboxStatus(platform).available === true;
  }
  async run(command, options = {}) {
    return this.execute(command, { ...this.defaults, ...options });
  }
  async verify(testCommand, options = {}) {
    if (!testCommand) return { verdict: 'UNVERIFIED', result: null };
    const result = await this.run(testCommand, options);
    return { command: testCommand, verdict: result.code === 0 && !result.timedOut && !result.cancelled ? 'PASS' : 'FAIL', result };
  }
}
