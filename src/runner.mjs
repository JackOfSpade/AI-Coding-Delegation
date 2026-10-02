import { runCommand } from './sandbox.mjs';

export class Runner {
  constructor({ execute = runCommand, defaults = {} } = {}) {
    this.execute = execute;
    this.defaults = defaults;
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
