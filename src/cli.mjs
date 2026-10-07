import { createCore } from './core.mjs';
import { createMcpServer } from './mcp.mjs';
import { createDiagnosticLog, resolveLogWindow } from './diagnostics.mjs';
import { validateExplicitRepoPath, validateJobRequest, validJobId } from './job-manager.mjs';
import { normalizeInterpreterDeclaration } from './verify-interpreter.mjs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { doctor, doctorLive } from './doctor.mjs';
import { redactText } from './redact.mjs';
import { MAX_RETROSPECTIVE_JOBS } from './retrospective.mjs';

const binPath = fileURLToPath(new URL('../bin/offload.mjs', import.meta.url));

const CLI_COMMANDS = Object.freeze({
  mcp: { valueFlags: [], booleanFlags: [], positionals: 'none' },
  doctor: { valueFlags: ['maxUsd', 'repoPath'], booleanFlags: ['live', 'hook'], positionals: 'none' },
  worker: { valueFlags: ['repoPath'], booleanFlags: [], positionals: 'one' },
  start: {
    valueFlags: [
      'task',
      'mode',
      'ownedPaths',
      'inputFiles',
      'acceptanceCriteria',
      'relevantPaths',
      'testCommand',
      'verifierMode',
      'verifierTimeoutSec',
      'verifierInterpreter',
      'profile',
      'effort',
      'maxRepairRounds',
      'budget',
      'maxUsd',
      'maxTurns',
      'turnPolicy',
      'timeoutMinutes',
      'extraWritable',
      'repoPath',
    ],
    booleanFlags: ['allowNetwork', 'foreground', 'unsafe-policy-only-verifier'],
    positionals: 'task',
  },
  wait: { valueFlags: ['timeoutSec', 'repoPath', 'detail'], booleanFlags: [], positionals: 'one' },
  job: {
    valueFlags: ['include', 'repoPath', 'detail', 'tail', 'limit', 'maxJobs', 'verifierInterpreter'],
    booleanFlags: ['all'],
    positionals: 'zero-or-one',
  },
  retrospective: { valueFlags: ['jobs', 'last', 'repoPath'], booleanFlags: [], positionals: 'zero-or-one' },
  repair: { valueFlags: ['defects', 'repoPath'], booleanFlags: ['foreground'], positionals: 'one' },
  revert: { valueFlags: ['repoPath'], booleanFlags: ['apply'], positionals: 'one' },
  cancel: { valueFlags: ['repoPath'], booleanFlags: [], positionals: 'one' },
});
const booleanText = (value) => value === 'true' || value === 'false';
const decimalText = (value) => typeof value === 'string' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value);

export function parseArgs(argv) {
  // Parse untrusted option names into a dictionary without a prototype. A
  // normal object gives `__proto__` assignment special behavior and can make
  // an unknown flag disappear before command-specific validation.
  const [command, ...rest] = argv;
  const flags = Object.create(null);
  const positionals = [];
  const shape = CLI_COMMANDS[command];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    // Treat the conventional end-of-options marker as positional input. This
    // lets callers provide task text beginning with `--` without it becoming a
    // flag, and avoids surprising parsing differences across shells.
    if (arg === '--') {
      positionals.push(...rest.slice(i + 1));
      break;
    }
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    // Splitting with a limit drops everything after a second `=`. That breaks
    // legitimate task text and values such as signed URLs, so split only at
    // the first delimiter.
    const text = arg.slice(2);
    const equals = text.indexOf('=');
    const key = equals < 0 ? text : text.slice(0, equals);
    const inline = equals < 0 ? undefined : text.slice(equals + 1);
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') throw new Error(`unsafe option --${key}`);
    const isBoolean = !!shape?.booleanFlags.includes(key);
    const needsValue = !!shape?.valueFlags.includes(key);
    let value;
    if (isBoolean) {
      if (inline !== undefined) {
        if (!booleanText(inline)) throw new Error(`option --${key} accepts only true or false`);
        value = inline;
      } else {
        // Do not let `--apply false` mean both "apply" and a positional job
        // named false.  Require the explicit form for literal boolean values.
        if (booleanText(rest[i + 1])) throw new Error(`option --${key} must use =true or =false before boolean text`);
        value = true;
      }
    } else if (needsValue) {
      if (inline !== undefined) {
        if (!inline) throw new Error(`option --${key} requires a value`);
        value = inline;
      } else {
        const next = rest[i + 1];
        if (!next || next.startsWith('--')) throw new Error(`option --${key} requires a value`);
        value = rest[++i];
      }
    } else value = inline ?? (rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : true);
    // Every current option is scalar.  Repeating one can otherwise silently
    // replace a safety/budget value with a later spelling, so reject the
    // ambiguity rather than choosing an arbitrary winner.
    if (Object.hasOwn(flags, key)) throw new Error(`duplicate option --${key}`);
    flags[key] = value;
  }
  return { command, positionals, flags: Object.fromEntries(Object.entries(flags)) };
}
const safeText = (value) =>
  redactText(String(value))
    .replace(/\x1B\][\s\S]*?(?:\x07|\x1B\\)/g, '')
    .replace(/\x1B\[[0-?]*[ -\/]*[@-~]/g, '')
    .replace(/[\x00-\x1F\x7F]/g, '');
const decode = (value, fallback) => {
  if (value == null) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    throw new Error('invalid JSON argument');
  }
};
const bool = (value) => value === true || value === 'true';
// One path, or a JSON array of up to four.
const interpreterFlag = (value) => (String(value).trimStart().startsWith('[') ? decode(value) : [value]);
const validId = validJobId;
const finiteNumber = (value, key, { integer = false, minimum, maximum, exclusiveMinimum = false } = {}) => {
  if (!decimalText(value)) throw new Error(`option --${key} must be a decimal number`);
  const number = Number(value);
  const below = minimum !== undefined && (exclusiveMinimum ? number <= minimum : number < minimum);
  if (!Number.isFinite(number) || (integer && !Number.isInteger(number)) || below || (maximum !== undefined && number > maximum)) {
    const lower = minimum === undefined ? '' : `${exclusiveMinimum ? 'greater than' : 'at least'} ${minimum}`;
    const upper = maximum === undefined ? '' : `at most ${maximum}`;
    throw new Error(
      `option --${key} must be a ${integer ? 'finite integer' : 'finite number'}${lower || upper ? ` (${[lower, upper].filter(Boolean).join(', ')})` : ''}`,
    );
  }
  return number;
};
const MAX_REPAIR_ITEMS = 32,
  MAX_REPAIR_ITEM = 4_000,
  MAX_REPAIR_CHARS = 16_000;
const cleanText = (value, maximum) => typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\0\r]/.test(value);
function decodedFlag(flags, key, fallback) {
  return decode(flags[key], fallback);
}
/** Validate caller-decodable values before Core is constructed. Core setup can
 * create durable job/integrity state, so malformed CLI input must not defer
 * rejection to JobManager after those side effects have happened. */
function validateDecodedInvocation(command, flags, positionals) {
  validateExplicitRepoPath(flags.repoPath);
  if (command === 'worker' && flags.repoPath === undefined) throw new Error('worker --repoPath is required');
  if (['worker', 'wait', 'repair', 'revert', 'cancel'].includes(command) && !validId(positionals[0]))
    throw new Error('valid job id is required');
  if (command === 'job' && positionals[0] != null && !validId(positionals[0])) throw new Error('invalid job id');
  if (command === 'job' && flags.include !== undefined && !['summary', 'diff', 'files', 'log'].includes(flags.include))
    throw new Error('job --include must be summary, diff, files, or log');
  if (command === 'repair') {
    const defects = decodedFlag(flags, 'defects', []);
    if (
      !Array.isArray(defects) ||
      !defects.length ||
      defects.length > MAX_REPAIR_ITEMS ||
      !defects.every((value) => cleanText(value, MAX_REPAIR_ITEM)) ||
      defects.reduce((total, value) => total + value.length, 0) > MAX_REPAIR_CHARS
    )
      throw new Error('repair --defects must be 1-32 non-empty bounded strings');
  }
  if (command !== 'start') return;
  validateJobRequest({
    task: flags.task ?? positionals.join(' '),
    mode: flags.mode,
    ownedPaths: decodedFlag(flags, 'ownedPaths', undefined),
    inputFiles: decodedFlag(flags, 'inputFiles', undefined),
    acceptanceCriteria: decodedFlag(flags, 'acceptanceCriteria', []),
    relevantPaths: decodedFlag(flags, 'relevantPaths', []),
    testCommand: flags.testCommand,
    ...(flags.verifierMode !== undefined ? { verifierMode: flags.verifierMode } : {}),
    ...(flags.verifierTimeoutSec !== undefined ? { verifierTimeoutSec: Number(flags.verifierTimeoutSec) } : {}),
    ...(flags.verifierInterpreter !== undefined ? { verifierInterpreter: interpreterFlag(flags.verifierInterpreter) } : {}),
    profile: flags.profile,
    effort: flags.effort,
    maxRepairRounds: flags.maxRepairRounds == null ? undefined : Number(flags.maxRepairRounds),
    budget: decodedFlag(
      flags,
      'budget',
      flags.maxUsd != null || flags.maxTurns != null || flags.timeoutMinutes != null || flags.turnPolicy != null
        ? {
            ...(flags.maxUsd != null ? { maxUsd: Number(flags.maxUsd) } : {}),
            ...(flags.maxTurns != null ? { maxTurns: Number(flags.maxTurns) } : {}),
            ...(flags.turnPolicy != null ? { turnPolicy: flags.turnPolicy } : {}),
            ...(flags.timeoutMinutes != null ? { timeoutMinutes: Number(flags.timeoutMinutes) } : {}),
          }
        : undefined,
    ),
    ...(flags.allowNetwork !== undefined ? { allowNetwork: bool(flags.allowNetwork) } : {}),
    ...(flags['unsafe-policy-only-verifier'] !== undefined ? { unsafePolicyOnlyVerifier: bool(flags['unsafe-policy-only-verifier']) } : {}),
    ...(flags.extraWritable !== undefined ? { extraWritable: decodedFlag(flags, 'extraWritable', []) } : {}),
    repoPath: flags.repoPath,
  });
}
/** `--jobs a,b` as 1-16 distinct valid job ids. */
function retrospectiveJobIds(value) {
  const ids = String(value).split(',');
  if (ids.length > MAX_RETROSPECTIVE_JOBS || new Set(ids).size !== ids.length || !ids.every(validId))
    throw new Error(`retrospective --jobs must be 1-${MAX_RETROSPECTIVE_JOBS} distinct valid job ids separated by commas`);
  return ids;
}
/** `--tail`/`--limit` as numbers; a non-numeric value stays NaN so the shared bounds check rejects it. */
function logWindowFlags(flags) {
  const number = (value) => (String(value).trim() === '' ? NaN : Number(value));
  return {
    ...(flags.tail !== undefined ? { tail: number(flags.tail) } : {}),
    ...(flags.limit !== undefined ? { limit: number(flags.limit) } : {}),
  };
}
function validateInvocation(command, flags, positionals) {
  const shape = CLI_COMMANDS[command];
  if (!shape) throw new Error('usage: offload <start|wait|job|repair|revert|cancel|retrospective|doctor|mcp>');
  const allowed = new Set([...shape.valueFlags, ...shape.booleanFlags]);
  for (const key of Object.keys(flags)) if (!allowed.has(key)) throw new Error(`unknown option --${key} for ${command}`);
  if (shape.positionals === 'none' && positionals.length) throw new Error(`${command} does not accept positional arguments`);
  if (shape.positionals === 'one' && positionals.length !== 1) throw new Error(`${command} requires exactly one job id`);
  if (shape.positionals === 'zero-or-one' && positionals.length > 1)
    throw new Error(`${command} accepts at most one ${command === 'job' ? 'job id' : 'argument'}`);
  // `start` deliberately accepts free-form positional task text, including
  // values after `--`. Do not silently discard it when --task was also used.
  if (shape.positionals === 'task' && flags.task !== undefined && positionals.length)
    throw new Error('start accepts either --task or positional task text, not both');
  if (command === 'doctor') {
    if (flags.maxUsd !== undefined && !bool(flags.live)) throw new Error('doctor --maxUsd requires --live');
    if (bool(flags.live) && bool(flags.hook)) throw new Error('doctor --live and --hook cannot be combined');
    if (bool(flags.live) && flags.maxUsd === undefined) throw new Error('doctor --live requires --maxUsd');
    // A live doctor request has the same hard cap as doctorLive. Validate it
    // here so a malformed/over-cap request cannot create a core first.
    if (flags.maxUsd !== undefined) finiteNumber(flags.maxUsd, 'maxUsd', { minimum: 0, exclusiveMinimum: true, maximum: 0.02 });
  }
  if (command === 'start') {
    if (flags.budget !== undefined && ['maxUsd', 'maxTurns', 'turnPolicy', 'timeoutMinutes'].some((key) => flags[key] !== undefined))
      throw new Error('start --budget cannot be combined with individual budget options');
    if (flags.maxUsd !== undefined) finiteNumber(flags.maxUsd, 'maxUsd', { minimum: 0, maximum: 10_000 });
    if (flags.maxTurns !== undefined) finiteNumber(flags.maxTurns, 'maxTurns', { integer: true, minimum: 1, maximum: 1000 });
    if (flags.turnPolicy !== undefined && !['auto', 'fixed'].includes(flags.turnPolicy))
      throw new Error('turnPolicy must be auto or fixed');
    if (flags.timeoutMinutes !== undefined) finiteNumber(flags.timeoutMinutes, 'timeoutMinutes', { minimum: 1, maximum: 1440 });
    if (flags.maxRepairRounds !== undefined)
      finiteNumber(flags.maxRepairRounds, 'maxRepairRounds', { integer: true, minimum: 0, maximum: 4 });
  }
  if (command === 'wait' && flags.timeoutSec !== undefined) finiteNumber(flags.timeoutSec, 'timeoutSec', { minimum: 0 });
  if (command === 'retrospective') {
    const history = positionals[0];
    if (history !== undefined && !['list', 'export'].includes(history)) throw new Error('retrospective accepts only list or export');
    if (flags.jobs !== undefined && (history || flags.last !== undefined))
      throw new Error('retrospective --jobs cannot be combined with list, export or --last');
    // `last` counts jobs for a digest and stored digests for list/export.
    if (flags.last !== undefined)
      finiteNumber(flags.last, 'last', { integer: true, minimum: 1, maximum: history ? 1000 : MAX_RETROSPECTIVE_JOBS });
    if (flags.jobs !== undefined) retrospectiveJobIds(flags.jobs);
    if (history && flags.repoPath !== undefined)
      throw new Error(`retrospective ${history} reads the local history and takes no --repoPath`);
  }
  if (command === 'job' && flags.include !== undefined && positionals.length !== 1) throw new Error('job --include requires a job id');
  if (command === 'job' && positionals.length === 1 && (flags.all !== undefined || flags.maxJobs !== undefined))
    throw new Error('job --all and --maxJobs apply only to the job list');
  if (command === 'job' && flags.maxJobs !== undefined) finiteNumber(flags.maxJobs, 'maxJobs', { integer: true, minimum: 1, maximum: 100 });
  if (command === 'job' && flags.verifierInterpreter !== undefined) {
    if (positionals.length === 1) throw new Error('job --verifierInterpreter applies only to the health call (no job id)');
    normalizeInterpreterDeclaration(interpreterFlag(flags.verifierInterpreter));
  }
  if (command === 'job' && (flags.tail !== undefined || flags.limit !== undefined)) {
    if (flags.include !== 'log') throw new Error('job --tail/--limit require --include log');
    resolveLogWindow(logWindowFlags(flags));
  }
}
// The detached worker is the trusted process that resolves keyRef. Commands
// get their own scrubbed environment in Runner, so this must retain env:
// credentials and proxy/CA settings needed for the provider HTTPS request.
function detachedEnvironment(env = process.env) {
  return { ...env };
}
export function spawnDetachedWorker({ jobId, repoPath, spawnProcess = spawn, env = process.env } = {}) {
  if (!validId(jobId) || typeof repoPath !== 'string' || !repoPath) throw new Error('job id and repo path are required to start worker');
  const child = spawnProcess(process.execPath, [binPath, 'worker', jobId, '--repoPath', repoPath], {
    detached: true,
    stdio: 'ignore',
    env: detachedEnvironment(env),
    windowsHide: true,
  });
  // Spawn failures may otherwise surface as an unhandled EventEmitter error
  // after the parent has persisted a running job. Wait for spawn readiness so
  // the caller can mark that job failed and release its lease.
  if (typeof child?.once !== 'function') {
    if (!Number.isInteger(child?.pid) || child.pid <= 0) return Promise.reject(new Error('worker process did not provide a valid pid'));
    child?.unref?.();
    return Promise.resolve(child);
  }
  return new Promise((resolve, reject) => {
    const failed = (error) => {
      child.removeListener?.('spawn', ready);
      reject(error);
    };
    const ready = () => {
      child.removeListener?.('error', failed);
      if (!Number.isInteger(child.pid) || child.pid <= 0) {
        reject(new Error('worker process did not provide a valid pid'));
        return;
      }
      try {
        child.unref?.();
        resolve(child);
      } catch (error) {
        reject(error);
      }
    };
    child.once('error', failed);
    child.once('spawn', ready);
  });
}
export async function runCli(argv = process.argv.slice(2), options = {}) {
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;
  let parsed;
  try {
    parsed = parseArgs(argv);
    validateInvocation(parsed.command, parsed.flags, parsed.positionals);
    validateDecodedInvocation(parsed.command, parsed.flags, parsed.positionals);
  } catch (error) {
    stderr.write(`offload: ${safeText(error.message || error)}\n`);
    return 2;
  }
  const { command, positionals, flags } = parsed;
  const injectedCore = Object.hasOwn(options, 'core');
  let core;
  try {
    // The installed skill is a client-side protocol contract only for the
    // MCP host. Direct CLI use has no loaded skill and must remain independent
    // of an unrelated Claude/Codex installation in the caller's home.
    core =
      options.core ||
      (options.createCore ? options.createCore() : createCore({ config: { enforceInstalledSkillPreflight: command === 'mcp' } }));
  } catch (error) {
    stderr.write(`offload: ${safeText(error.message || error)}\n`);
    return 2;
  }
  const spawnWorker = options.spawnWorker || spawnDetachedWorker;
  const runLiveDoctor = options.doctorLive || doctorLive;
  if (command === 'mcp') {
    createMcpServer(core, { log: createDiagnosticLog() });
    return 0;
  }
  if (command === 'doctor') {
    try {
      // A spelled false value must never turn a local doctor command into a
      // paid network probe. parseArgs preserves flag values as strings, so a
      // truthiness check would incorrectly treat `--live=false` as enabled.
      if (bool(flags.live)) {
        const maxUsd = Number(flags.maxUsd);
        if (!Number.isFinite(maxUsd)) throw new Error('doctor --live requires a finite --maxUsd cap');
        const result = await runLiveDoctor({ maxUsd, repoPath: flags.repoPath });
        stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return 0;
      }
      const diagnostic = doctor({ root: fileURLToPath(new URL('..', import.meta.url)), repoPath: flags.repoPath });
      const health = (await core.job()).health;
      const result = { ...diagnostic, worker: health?.worker, coreSandbox: health?.sandbox, verifierTmp: health?.verifierTmp };
      if (bool(flags.hook)) {
        stdout.write(
          `offload: node ${result.nodeOk ? 'ok' : 'bad'} · git ${result.git ? 'ok' : 'missing'} · key ${result.key.ok ? 'ok' : 'missing'} · sandbox ${result.sandbox}\n`,
        );
        return result.nodeOk && result.git ? 0 : 2;
      }
      stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return 0;
    } catch (error) {
      stderr.write(`offload: ${safeText(error.message || error)}\n`);
      return 2;
    } finally {
      // `doctor` asks the core only for local health.  Close a core created by
      // this command so an embedding's managers/timers cannot outlive it; an
      // injected core belongs to its caller and is deliberately untouched.
      if (!injectedCore) await Promise.resolve(core.shutdown?.({ timeoutMs: 5_000 })).catch(() => {});
    }
  }
  try {
    let result;
    if (command === 'worker') {
      if (!validId(positionals[0])) throw new Error('valid job id is required');
      let stopping = false;
      const stop = () => {
        if (stopping) return;
        stopping = true;
        Promise.resolve(core.shutdown?.({ timeoutMs: 5_000 })).finally(() => process.exit(143));
      };
      for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.once(signal, stop);
      try {
        await core.runDetached(positionals[0], flags.repoPath);
        return 0;
      } finally {
        for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.removeListener(signal, stop);
      }
    } else if (command === 'start') {
      const input = {
        task: flags.task || positionals.join(' '),
        mode: flags.mode,
        ownedPaths: decode(flags.ownedPaths, undefined),
        inputFiles: decode(flags.inputFiles, undefined),
        acceptanceCriteria: decode(flags.acceptanceCriteria, []),
        relevantPaths: decode(flags.relevantPaths, []),
        testCommand: flags.testCommand,
        ...(flags.verifierMode !== undefined ? { verifierMode: flags.verifierMode } : {}),
        ...(flags.verifierTimeoutSec !== undefined ? { verifierTimeoutSec: Number(flags.verifierTimeoutSec) } : {}),
        ...(flags.verifierInterpreter !== undefined ? { verifierInterpreter: interpreterFlag(flags.verifierInterpreter) } : {}),
        profile: flags.profile,
        effort: flags.effort,
        maxRepairRounds: flags.maxRepairRounds == null ? undefined : Number(flags.maxRepairRounds),
        budget: decode(
          flags.budget,
          flags.maxUsd != null || flags.maxTurns != null || flags.timeoutMinutes != null || flags.turnPolicy != null
            ? {
                ...(flags.maxUsd != null ? { maxUsd: Number(flags.maxUsd) } : {}),
                ...(flags.maxTurns != null ? { maxTurns: Number(flags.maxTurns) } : {}),
                ...(flags.turnPolicy != null ? { turnPolicy: flags.turnPolicy } : {}),
                ...(flags.timeoutMinutes != null ? { timeoutMinutes: Number(flags.timeoutMinutes) } : {}),
              }
            : undefined,
        ),
        ...(flags.allowNetwork !== undefined ? { allowNetwork: bool(flags.allowNetwork) } : {}),
        ...(flags['unsafe-policy-only-verifier'] !== undefined
          ? { unsafePolicyOnlyVerifier: bool(flags['unsafe-policy-only-verifier']) }
          : {}),
        ...(flags.extraWritable !== undefined ? { extraWritable: decode(flags.extraWritable, []) } : {}),
        repoPath: flags.repoPath,
      };
      if (injectedCore || bool(flags.foreground)) result = await core.start(input);
      else {
        result = await core.start(input, { launch: false });
        try {
          const child = await spawnWorker({ jobId: result.jobId, repoPath: result.repo });
          await core.assignWorkerPid(result.jobId, child.pid, result.repo);
        } catch (error) {
          await core.failDetached?.(result.jobId, result.repo, error);
          throw error;
        }
      }
    } else if (command === 'wait') {
      if (!validId(positionals[0])) throw new Error('valid job id is required');
      result = await core.wait(positionals[0], {
        timeoutSec: flags.timeoutSec == null ? undefined : Number(flags.timeoutSec),
        repoPath: flags.repoPath,
        // The terminal user asked for a report; the compact default is for
        // token-sensitive model clients (MCP).
        detail: flags.detail ?? 'full',
      });
    } else if (command === 'job') {
      if (positionals[0] != null && !validId(positionals[0])) throw new Error('invalid job id');
      result = await core.job(positionals[0], {
        include: flags.include,
        ...logWindowFlags(flags),
        detail: flags.detail ?? 'full',
        // Each CLI call is a fresh process, so "this session" would hide every
        // terminal job: the terminal list stays complete unless --all=false.
        ...(positionals[0] == null ? { all: flags.all === undefined ? true : bool(flags.all) } : {}),
        ...(flags.maxJobs !== undefined ? { maxJobs: Number(flags.maxJobs) } : {}),
        ...(flags.verifierInterpreter !== undefined ? { verifierInterpreter: interpreterFlag(flags.verifierInterpreter) } : {}),
        repoPath: flags.repoPath || (positionals[0] == null ? process.cwd() : undefined),
      });
    } else if (command === 'retrospective') {
      const history = positionals[0];
      if (history) {
        const stored = await core.retrospectiveHistory({ ...(flags.last !== undefined ? { limit: Number(flags.last) } : {}) });
        result = history === 'list' ? { path: stored.path, ...stored.aggregate } : { path: stored.path, records: stored.records };
      } else {
        // A terminal call is its own process: "this session" would be empty, so read the newest jobs (or the named ones).
        const jobIds = flags.jobs === undefined ? undefined : retrospectiveJobIds(flags.jobs);
        const { maintainerPromptSkeleton, ...digest } = await core.retrospective({
          ...(jobIds ? { jobIds } : { last: flags.last === undefined ? 5 : Number(flags.last) }),
          repoPath: flags.repoPath || process.cwd(),
          persist: false,
        });
        result = `${JSON.stringify(digest, null, 2)}\n\n--- maintainer prompt skeleton (edit before pasting) ---\n${maintainerPromptSkeleton}`;
      }
    } else if (command === 'repair') {
      if (!validId(positionals[0])) throw new Error('valid job id is required');
      const defects = decode(flags.defects, []);
      if (injectedCore || bool(flags.foreground)) result = await core.repair(positionals[0], defects, { repoPath: flags.repoPath });
      else {
        result = await core.repair(positionals[0], defects, { repoPath: flags.repoPath, launch: false });
        try {
          const child = await spawnWorker({ jobId: result.jobId, repoPath: result.repo });
          await core.assignWorkerPid(result.jobId, child.pid, result.repo);
        } catch (error) {
          await core.failDetached?.(result.jobId, result.repo, error);
          throw error;
        }
      }
    } else if (command === 'cancel') {
      if (!validId(positionals[0])) throw new Error('valid job id is required');
      result = await core.cancel(positionals[0], { repoPath: flags.repoPath });
    } else if (command === 'revert') {
      if (!validId(positionals[0])) throw new Error('valid job id is required');
      result = await core.revert(positionals[0], { apply: bool(flags.apply), repoPath: flags.repoPath });
    } else throw new Error('usage: offload <start|wait|job|repair|revert|cancel|retrospective|doctor|mcp>');
    stdout.write(`${typeof result === 'string' ? result : JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    stderr.write(`offload: ${safeText(error.message || error)}\n`);
    return 2;
  }
}
