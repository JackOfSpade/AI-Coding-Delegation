import { execFileSync } from 'node:child_process';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { LeaseManager, getGitDir } from './lease.mjs';
import { JobStore } from './store.mjs';
import { Runner } from './runner.mjs';
import { JobManager, mergeListings, validateExplicitRepoPath, validateJobId, validateJobRequest } from './job-manager.mjs';
import { probeVerifierTemp, sandboxAvailable, sandboxStatus } from './sandbox.mjs';
import { healthIdentity, runtimeIdentity } from './identity.mjs';
import { assertStartRuntimeCurrent, installedSkillHealth, withSkillHealth } from './skill-health.mjs';
import {
  normalizeInterpreterDeclaration,
  probeVerifierInterpreter,
  pythonProjectMarkers,
  resolveVerifierInterpreters,
  verifierPythonStatus,
} from './verify-interpreter.mjs';
import { snapshotWorkingTree, diffTrees, diffTreeFiles, git as snapshotGit, snapshotGitEnv } from './git-snapshot.mjs';
import {
  createIsolatedWorktree,
  openIsolatedWorktree,
  cleanupIsolatedWorktree,
  isolatedDependencyReadPaths,
  verifierDependencyStatus,
  workingTreeStatus,
  integrateRecordedTree,
  pinJobTrees,
  releaseJobTrees,
} from './worktree.mjs';
import { resolveLogWindow } from './diagnostics.mjs';
import { MAX_RETROSPECTIVE_JOBS, buildRetrospective } from './retrospective.mjs';
import { createRetrospectiveLog } from './retrospective-log.mjs';
import { defaultConfigPath, loadConfig, resolveConfigRelativePath } from './config.mjs';
import { WINDOWS_INTEGRITY_ROOT_CREDENTIAL, readWindowsCredential, resolveKeyRef, storeWindowsCredential } from './secrets.mjs';
import {
  PosixIntegrityRoot,
  WindowsIntegrityRoot,
  canonicalIntegrityStatePath,
  credentialFingerprint,
  deriveJobMacKey,
  sameCredentialFingerprint,
  validCredentialFingerprint,
} from './integrity.mjs';
import { DEFAULT_ATTEMPT_TIMEOUT_MS, OpenAIChatProvider } from './provider/openai-chat.mjs';
import { PathPolicy } from './policy.mjs';
import { LocalTools, availableToolDefinitions } from './agent/tools.mjs';
import { AgentLoop } from './agent/loop.mjs';
import { AgentContext } from './agent/context.mjs';
import { annotateRelevantPaths, buildSystemPrompt } from './agent/prompt.mjs';
import { loadPricing } from './pricing-registry.mjs';
import { assertModelAllowed } from './model-policy.mjs';
import { validatePricingTable } from './pricing.mjs';
import { readRegularFileSync } from './regular-file.mjs';

// Repository discovery must not pass provider credentials, ambient Git
// redirects, filters, hooks, or fsmonitor helpers to a repository command.
const command = (repo, args) => snapshotGit(repo, args).trim();
const MAX_PRICING_BYTES = 1024 * 1024;
// The Offload checkout this server runs from: the one a maintainer prompt names.
const PACKAGE_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const parentHandoff = (job) => job?.status === 'QUEUED' && job.handoffState === 'PARENT_QUEUED';
const handoffIdentity = (job) => ({
  status: job?.status,
  handoffState: job?.handoffState,
  leaseOwnerNonce: job?.leaseOwnerNonce,
  runnerPid: job?.runnerPid,
  runnerHeartbeatAt: job?.runnerHeartbeatAt,
});
export function insidePath(path, parent, { relativePath = relative, isAbsolutePath = isAbsolute, platform = process.platform } = {}) {
  const part = relativePath(parent, path);
  // On Windows, `path.relative` returns an absolute target when paths live on
  // different drives or UNC shares. That is never containment.
  return !isAbsolutePath(part) && (part === '' || (part !== '..' && !part.startsWith(`..${platform === 'win32' ? '\\' : '/'}`)));
}
/**
 * What the loop guard may call each absolute prefix when it records a failing
 * call for the primary. Both the lexical and the resolved form are listed
 * (macOS temp dirs resolve through /private), longest prefix wins.
 */
export function failurePathAliases(executionPath, repoPath, home = homedir()) {
  const real = (path) => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  };
  const pairs = [];
  for (const [path, label] of [
    [executionPath, '<worktree>'],
    [repoPath, '<repo>'],
    [home, '~'],
  ])
    if (typeof path === 'string' && path) for (const variant of new Set([path, real(path)])) pairs.push([variant, label]);
  return pairs.slice(0, 16);
}
/**
 * The only external read root a worker command may receive is the direct
 * parent of its authenticated isolated worktree. This is needed for macOS
 * cwd resolution; it intentionally grants no parent to primary checkouts.
 */
export function isolatedWorkspaceReadablePaths(job, executionPath) {
  return typeof job?.workspacePath === 'string' && isAbsolute(job.workspacePath) && job.workspacePath === executionPath
    ? [dirname(executionPath), ...isolatedDependencyReadPaths(executionPath, job.repoPath)]
    : [];
}
export function defaultIntegrityStatePath({ platform = process.platform, env = process.env, home } = {}) {
  if (platform === 'win32') return undefined;
  return join(resolve(defaultConfigPath(env, home, platform), '..'), 'integrity-state');
}
export function integrityStateHintAllowed(hint, { platform = process.platform } = {}) {
  return platform !== 'win32' || !hint;
}
function integrityStatePath({ hint, repoPath, gitDir, platform = process.platform } = {}) {
  if (!integrityStateHintAllowed(hint, { platform })) throw new Error('custom integrity state paths are unsupported on Windows');
  const path = canonicalIntegrityStatePath(hint || defaultIntegrityStatePath());
  // Canonicalize every side before containment. Git and Node may render the
  // same Windows path with a short-name alias, which must not let an in-repo
  // integrity root bypass the authority check.
  const root = canonicalIntegrityStatePath(repoPath);
  const gitRoot = canonicalIntegrityStatePath(gitDir);
  if (insidePath(path, root) || insidePath(path, gitRoot))
    throw new Error('integrity state directory must not be inside the repository or git directory');
  return path;
}
function nativeWindowsIntegrityVault({ execFile } = {}) {
  const options = execFile ? { platform: 'win32', execFile } : { platform: 'win32' };
  return {
    read(credential) {
      if (credential !== WINDOWS_INTEGRITY_ROOT_CREDENTIAL) throw new Error('invalid integrity credential identity');
      try {
        return readWindowsCredential(credential, options);
      } catch (error) {
        if (error?.code === 'E_SECRET_NOT_FOUND') return undefined;
        throw error;
      }
    },
    writeIfAbsent(credential, value) {
      if (credential !== WINDOWS_INTEGRITY_ROOT_CREDENTIAL) throw new Error('invalid integrity credential identity');
      storeWindowsCredential(credential, value, { ...options, ifAbsent: true });
    },
  };
}
function pricingFile(path) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(readRegularFileSync(path, MAX_PRICING_BYTES));
  } catch {
    throw new Error('pricing file is invalid or exceeds 1048576 bytes');
  }
  let table;
  try {
    table = JSON.parse(text);
  } catch {
    throw new Error('pricing file contains invalid JSON');
  }
  if (
    !table ||
    typeof table !== 'object' ||
    Array.isArray(table) ||
    !table.models ||
    typeof table.models !== 'object' ||
    Array.isArray(table.models)
  )
    throw new Error(`invalid pricing file ${path}: expected models object`);
  return table;
}
/** Snapshot through a temporary index; neither user index nor history changes. */
export function gitSnapshots() {
  return {
    async create(repoPath) {
      return snapshotWorkingTree(repoPath);
    },
    async diff(repoPath, before, after, options) {
      return diffTrees(repoPath, before, after, options);
    },
    async files(repoPath, before, after) {
      return diffTreeFiles(repoPath, before, after);
    },
  };
}
export function gitPatchApplier(repoPath, patch, { reverse, check }) {
  if (!Buffer.isBuffer(patch)) throw new TypeError('patch must be a Buffer');
  // A reverse check is compulsory even when application was requested.
  const env = snapshotGitEnv();
  const hooks = process.platform === 'win32' ? 'NUL' : '/dev/null';
  // Apply exactly the byte-oriented tree semantics used by snapshots. In
  // particular, a host-wide core.autocrlf setting must not rewrite a raw
  // stored patch between apply and reverse/reconciliation on Windows.
  const hardening = [
    '-C',
    repoPath,
    '-c',
    'core.fsmonitor=false',
    '-c',
    `core.hooksPath=${hooks}`,
    '-c',
    'core.autocrlf=false',
    '-c',
    'core.eol=lf',
  ];
  execFileSync('git', [...hardening, 'apply', ...(reverse ? ['-R'] : []), '--check'], {
    input: patch,
    encoding: 'buffer',
    env,
    timeout: 30_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (!check)
    execFileSync('git', [...hardening, 'apply', ...(reverse ? ['-R'] : [])], {
      input: patch,
      encoding: 'buffer',
      env,
      timeout: 30_000,
      maxBuffer: 64 * 1024 * 1024,
    });
  return { dryRun: !!check, applied: !check };
}
export function createCore({ store, runner, worker, snapshots, leases, config = {}, now, sessionStartedAt } = {}) {
  // The no-argument job list is scoped to this server session. The wall clock
  // is used on purpose (not the injectable `now`): real stores stamp real time.
  // `new Date(null|0|false|true)` is a valid epoch instant that would make the
  // filter match every job, so only a Date or a non-empty string is accepted.
  const sessionStartValid =
    sessionStartedAt === undefined || sessionStartedAt instanceof Date || (typeof sessionStartedAt === 'string' && sessionStartedAt !== '');
  const sessionStart = sessionStartedAt === undefined ? new Date() : sessionStartValid ? new Date(sessionStartedAt) : new Date(NaN);
  if (Number.isNaN(sessionStart.getTime())) throw new Error('sessionStartedAt must be an ISO timestamp');
  const sessionStartIso = sessionStart.toISOString();
  const resolvedRunner = runner || new Runner({ defaults: { sandbox: true } });
  const resolvedSnapshots = snapshots || gitSnapshots();
  const nowMs = () => {
    const value = typeof now === 'function' ? now() : undefined;
    if (value instanceof Date) return value.getTime();
    return Number.isFinite(value) ? value : Date.now();
  };
  const states = new Map();
  const pendingStates = new Map();
  let injectedStoreRoot;
  let mcpRepoHint;
  let closing = false;
  const integrityAdapter = ({ repoPath, gitDir, statePath, platform = process.platform, vault } = {}) => {
    const root =
      platform === 'win32'
        ? new WindowsIntegrityRoot({ vault: vault || nativeWindowsIntegrityVault({ execFile: config.integrityExecFile }) })
        : new PosixIntegrityRoot({ statePath });
    const resolveCredential = (keyRef) => {
      if (typeof keyRef !== 'string' || !keyRef) throw new Error('job credential is unavailable');
      let credential;
      try {
        credential = (config.resolveKey || resolveKeyRef)(keyRef);
      } catch {
        throw new Error('job credential is unavailable');
      }
      if (typeof credential !== 'string' || !credential) throw new Error('job credential is unavailable');
      return credential;
    };
    return {
      requiredFor: () => true,
      load: (options) => root.load(options),
      reload: () => root.load({ create: false }),
      keyForId: (id) => deriveJobMacKey(root.value, { repoPath, gitDir, id }),
      // This runs only after JobStore authenticated the complete record with
      // keyForId. keyRef is therefore record-authenticated before resolution.
      async authenticate(job) {
        const execution = job?.executionProfile;
        if (!execution || typeof execution.keyRef !== 'string' || !validCredentialFingerprint(job.credentialFingerprint))
          throw new Error('stored job credential check failed');
        const credential = resolveCredential(execution.keyRef);
        if (!sameCredentialFingerprint(job.credentialFingerprint, credentialFingerprint(root.value, credential)))
          throw new Error('stored job credential check failed');
        return credential;
      },
      async prepare(job) {
        const execution = job?.executionProfile;
        if (!execution || typeof execution.keyRef !== 'string') throw new Error('job credential is unavailable');
        const credential = resolveCredential(execution.keyRef);
        return { ...job, credentialFingerprint: credentialFingerprint(root.value, credential) };
      },
      preflight: (keyRef) => resolveCredential(keyRef),
    };
  };
  const stateForStore = (repoPath) => {
    if (!store) return new JobStore({ repoPath });
    if (injectedStoreRoot && injectedStoreRoot !== repoPath)
      throw new Error('an injected JobStore supports one repository; use a store factory for multi-repository tests');
    injectedStoreRoot ||= repoPath;
    return store;
  };
  const configuredWorker = (state) =>
    worker || {
      async run(job, api) {
        // JobStore authenticates the record MAC before resolving its sealed keyRef
        // and compares the freshly resolved credential fingerprint before this
        // worker can construct a provider.
        if (state.integrity) job = await state.store.get(job.id);
        if (job.cappedFinishRecovery !== undefined && !['queued', 'consumed', 'settled'].includes(job.cappedFinishRecovery))
          throw new Error('stored job has invalid capped implementation recovery state');
        if (job.budgetFinishRecovery !== undefined && !['queued', 'consumed'].includes(job.budgetFinishRecovery))
          throw new Error('stored job has invalid budget finish recovery state');
        const execution = job.executionProfile;
        // Accepted jobs contain their resolved execution and budget snapshot. A
        // detached child must not require a still-valid mutable config/repo file.
        const loaded = execution ? null : config.loaded || loadConfig({ configPath: config.configPath, repoPath: job.repoPath });
        const profileName = job.profile || loaded?.config.default;
        const configured = execution ? null : loaded.config.profiles[profileName];
        if (!execution && !configured) throw new Error(`unknown profile: ${profileName}`);
        const profile = execution ? { model: execution.model, effort: execution.effort } : configured;
        const providerConfig = execution || loaded.config.providers[configured.provider];
        if (providerConfig?.type !== 'openai-chat') throw new Error(`unsupported provider type: ${providerConfig?.type || 'missing'}`);
        assertModelAllowed({ baseUrl: providerConfig.baseUrl, model: profile.model });
        let key;
        try {
          key = state.integrity ? await state.integrity.authenticate(job) : (config.resolveKey || resolveKeyRef)(providerConfig.keyRef);
        } catch {
          throw new Error('worker key is unavailable; run offload doctor or configure keyRef');
        }
        state.store.secrets ||= [];
        if (!state.store.secrets.includes(key)) state.store.secrets.push(key);
        const provider = new OpenAIChatProvider({
          baseUrl: providerConfig.baseUrl,
          apiKey: key,
          model: profile.model,
          reasoningEffort: (job.effort || profile.effort) === 'high' ? 'high' : undefined,
          timeoutMs: providerConfig.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS,
        });
        // A queued job is an immutable execution request.  In particular, do not
        // let a later .offload.json edit relax (or unexpectedly revoke) its policy.
        // repoPath remains the public/lease identity; a real Core job executes
        // only inside its private linked worktree.
        const executionPath = job.workspacePath || job.repoPath;
        const readablePaths = isolatedWorkspaceReadablePaths(job, executionPath);
        const policy = new PathPolicy({
          repoPath: executionPath,
          ownedPaths: job.ownedPaths,
          extraWritable: job.extraWritable || [],
          denyRead: job.denyRead || [],
        });
        const runCommand =
          job.mode !== 'report' && sandboxAvailable()
            ? ({ command, timeoutSec, signal }) => {
                // Commands are only exposed where the OS sandbox can enforce the same
                // secret-read policy as file tools. The worker process keeps the API key.
                return resolvedRunner.run(command, {
                  cwd: executionPath,
                  gitDir: getGitDir(executionPath),
                  timeoutSec,
                  signal: signal || api.commandSignal || api.signal,
                  denyRead: policy.denyRead || [],
                  writablePaths: [...job.ownedPaths, ...(job.extraWritable || [])].map((p) => join(executionPath, p)),
                  // An isolated linked worktree has a server-created private
                  // parent. Node may resolve cwd through that parent, so it
                  // needs traversal/read access but never write authority.
                  ...(readablePaths.length ? { readablePaths } : {}),
                  allowNetwork: job.allowNetwork,
                  requireSandbox: true,
                });
              }
            : undefined;
        const tools = new LocalTools({ repoPath: executionPath, policy, ...(runCommand ? { runCommand } : {}) });
        let pricing = job.pricingSnapshot || config.pricingTable || loadPricing(providerConfig.pricing);
        if (!pricing && providerConfig.pricingFile) {
          const pricePath = execution
            ? providerConfig.pricingFile
            : resolveConfigRelativePath(providerConfig.pricingFile, loaded.configPath);
          try {
            pricing = pricingFile(pricePath);
          } catch (error) {
            throw new Error(`unable to load pricing file ${pricePath}: ${error.message || error}`);
          }
        }
        // Report workers may read caller-supplied external bodies. Their
        // conversational/tool transcript is therefore intentionally
        // ephemeral: only the separately-sanitized report result is durable.
        // Write jobs retain their exact resume and transcript semantics.
        const prior = job.mode === 'report' ? [] : (await state.store.readMessages?.(job.id)) || [];
        const context =
          job.mode === 'report'
            ? new AgentContext()
            : new AgentContext(prior, { onAppend: api.appendMessage, onAppendBatch: api.appendMessages });
        const repair = `Repair these concrete defects:\n${(api.defects?.length ? api.defects : ['Continue the job and re-check the acceptance criteria.']).map((x) => `- ${x}`).join('\n')}`;
        const totalTurns = job.budget?.maxTurns ?? loaded?.config.limits.maxTurns,
          totalUsd = job.budget?.maxUsd ?? loaded?.config.limits.maxUsd;
        const remainingTurns = totalTurns - (job.turns || 0),
          remainingUsd = totalUsd - (job.costUsd || 0);
        const totalTimeoutMs = (job.budget?.timeoutMinutes ?? loaded?.config.limits.timeoutMinutes) * 60_000;
        // A repair is a new active worker round. Its timeout must not be
        // consumed by calendar time between the original run and a later
        // manual repair. Turns and cost remain cumulative above, but the
        // wall-clock allowance begins when this worker claim was made.
        // New records always have the active-run start from JobManager's
        // launch claim. Legacy/interrupted records may not; fall back through
        // their historical lifecycle timestamps and finally use this worker's
        // current clock rather than passing NaN to AgentLoop.
        const activeRunStartedAt =
          [job.startedAt, job.wallStartedAt, job.createdAt].map((value) => Date.parse(value || '')).find(Number.isFinite) ?? nowMs();
        const remainingTimeoutMs = totalTimeoutMs - Math.max(0, nowMs() - activeRunStartedAt);
        if (remainingTurns < 1 || remainingUsd <= 0)
          return {
            status: 'BUDGET',
            turn: 0,
            costUsd: 0,
            usage: {},
            error: 'Cumulative job budget exhausted',
            budgetCap: remainingTurns < 1 ? 'turns' : 'usd',
          };
        if (remainingTimeoutMs < 1) return { status: 'TIMEOUT', turn: 0, costUsd: 0, usage: {}, error: 'Cumulative job timeout exhausted' };
        const loop = new AgentLoop({
          provider,
          tools,
          toolDefinitions: availableToolDefinitions({ allowCommand: !!runCommand, readOnly: job.mode === 'report' }),
          context,
          pricing,
          model: profile.model,
          maxTurns: remainingTurns,
          timeoutMs: remainingTimeoutMs,
          maxUsd: remainingUsd,
          now: nowMs,
          signal: api.signal,
          progress: api.progress,
          persistCappedFinishRecovery: api.progress,
          persistBudgetFinishRecovery: api.progress,
          cappedFinishRecovery: job.cappedFinishRecovery,
          budgetFinishRecovery: job.budgetFinishRecovery,
          serverVerifierConfigured: job.mode !== 'report' && typeof job.testCommand === 'string' && job.testCommand.trim().length > 0,
          pathAliases: failurePathAliases(executionPath, job.repoPath),
        });
        // The initial prompt is durable conversation state. A repair appends only
        // its defect user turn; it never repeats system/task/history prefixes.
        // A capped implementation recovery is different: its authenticated state owns a
        // specific two-message tail, so appending any repair/task text would
        // turn a crash-safe one-shot continuation into a different request.
        const rawResult = await loop.run(
          (job.cappedFinishRecovery !== undefined && job.cappedFinishRecovery !== 'settled') || job.budgetFinishRecovery !== undefined
            ? {}
            : prior.length
              ? { task: repair }
              : {
                  system: await buildSystemPrompt({
                    ...job,
                    relevantPaths: await annotateRelevantPaths(tools, job.relevantPaths),
                    repoPath: executionPath,
                    allowCommand: !!runCommand,
                    remainingTurns,
                    serverVerifierConfigured:
                      job.mode !== 'report' && typeof job.testCommand === 'string' && job.testCommand.trim().length > 0,
                  }),
                  task: job.task,
                },
        );
        const responseModel = rawResult.model;
        const mismatch =
          responseModel && responseModel !== profile.model
            ? `provider response model ${responseModel} differs from configured model ${profile.model}`
            : null;
        const result = {
          ...rawResult,
          model: profile.model,
          responseModel,
          concerns: [...(rawResult.concerns || rawResult.finish?.concerns || []), ...(mismatch ? [mismatch] : [])],
        };
        await api.progress({ turn: result.turn, status: result.status });
        return result;
      },
    };
  const workerHealth = (root) => {
    try {
      const loaded = config.loaded || loadConfig({ configPath: config.configPath, repoPath: root });
      const profile = loaded.config.profiles[loaded.config.default];
      const provider = profile && loaded.config.providers[profile.provider];
      if (loaded.disabled || provider?.type !== 'openai-chat') return false;
      // Resolve only as a boolean preflight; never place the key or resolver
      // diagnostics in a health response.
      const key = (config.resolveKey || resolveKeyRef)(provider.keyRef);
      return typeof key === 'string' && key.length > 0;
    } catch {
      return false;
    }
  };
  // The verifier sandbox can read no interpreter or virtualenv unless the
  // caller declares one (verifierInterpreter), so a Python project's readiness
  // is its own report, and `verifierDeps` (a JavaScript notion) mirrors it
  // rather than claiming `not-applicable`.
  const interpreterAllowlist = (root) => {
    try {
      const loaded = config.loaded || loadConfig({ configPath: config.configPath, repoPath: root });
      return loaded.config.verifier?.interpreterRoots ?? [];
    } catch {
      return [];
    }
  };
  const pythonDeps = (deps, python) =>
    deps.verifierDeps === 'not-applicable' && python.status !== 'not-applicable'
      ? { verifierDeps: python.status, reason: python.reason }
      : {};
  const skillHealth = () => {
    try {
      return withSkillHealth(
        (config.runtimeHealth || healthIdentity)(),
        (config.skillHealth || installedSkillHealth)({ expectedHash: runtimeIdentity().skillHash }),
      );
    } catch {
      // Whether a client's skill copy is current must never fail health.
      return withSkillHealth(healthIdentity(), { stale: false, state: 'unknown', reason: 'skill-check-failed', installedHash: null });
    }
  };
  // Keep the legacy `sandbox` mode stable while exposing why a policy-only
  // host cannot apply Seatbelt. This is returned by offload_job with no id,
  // where an orchestrator needs to decide whether verification is possible.
  // The probe runs a real sandboxed command, so its (promise) answer is shared
  // by concurrent health calls and reused for a minute.
  const VERIFIER_TMP_TTL_MS = 60_000;
  let tempProbe;
  const verifierTmpHealth = () => {
    if (!tempProbe || nowMs() - tempProbe.at > VERIFIER_TMP_TTL_MS)
      tempProbe = {
        at: nowMs(),
        value: Promise.resolve()
          .then(() => (config.probeVerifierTemp || probeVerifierTemp)())
          .catch(() => ({ status: 'unknown', reason: 'probe-failed', systemTmp: 'unknown', gitInit: 'unknown', note: '' })),
      };
    return tempProbe.value;
  };
  const sandboxHealth = async () => {
    const status = sandboxStatus();
    const skill = skillHealth();
    return {
      server: skill.server,
      // Plain flags for the preflight: a stale installed skill is handled like a stale server.
      staleSkill: skill.staleSkill,
      restartRequired: skill.restartRequired,
      ...(skill.restartAction ? { restartAction: skill.restartAction } : {}),
      sandbox: status.available ? 'macos' : 'policy-only',
      sandboxReason: status.reason,
      sandboxStatus: {
        available: status.available,
        reason: status.reason,
        ...(status.error ? { error: status.error } : {}),
        ...(status.exitCode != null ? { exitCode: status.exitCode } : {}),
        ...(status.signal ? { signal: status.signal } : {}),
      },
      sandboxProbeCommand: status.probe,
      ...(status.error ? { sandboxProbeError: status.error } : {}),
      ...(status.exitCode != null ? { sandboxProbeExitCode: status.exitCode } : {}),
      ...(status.signal ? { sandboxProbeSignal: status.signal } : {}),
      // Whether a sandboxed verifier can create temp directories at all.
      verifierTmp: await verifierTmpHealth(),
    };
  };
  const repoHints = (hint) =>
    [
      hint,
      mcpRepoHint,
      config.repoPath,
      process.env.CLAUDE_PROJECT_DIR,
      process.env.CODEX_PROJECT_DIR,
      process.env.CURSOR_PROJECT_DIR,
      process.cwd(),
    ].filter((value) => typeof value === 'string' && value);
  const canonicalRepo = (hint) => {
    let lastError;
    // An explicit path is authoritative. Falling back to the server cwd here
    // can silently run or inspect the wrong checkout after a client typo.
    for (const candidate of hint ? [hint] : repoHints()) {
      try {
        return realpathSync(resolve(command(candidate, ['rev-parse', '--show-toplevel'])));
      } catch (error) {
        lastError = error;
      }
    }
    throw new Error(`repoPath must be inside a git working tree${lastError ? '' : ''}`);
  };
  const makeState = async (repoPath, { exceptRecoveryIds = [] } = {}) => {
    const root = canonicalRepo(repoPath);
    let state = states.get(root);
    if (!state) {
      let pending = pendingStates.get(root);
      if (!pending) {
        pending = (async () => {
          const stateStore = stateForStore(root);
          await stateStore.init(root);
          const created = { repoPath: root, store: stateStore };
          // Only the real built-in provider worker creates executable jobs.
          // Injected workers are frequently used by tests/integrations without
          // a provider credential and retain JobStore's opt-in behavior.
          if (!worker) {
            // Integrity state is independent of mutable config/repository
            // paths. Windows has no filesystem state path at all.
            const integrityPlatform = config.integrityPlatform || process.platform;
            if (integrityPlatform === 'win32' && config.integrityStatePath)
              throw new Error('custom integrity state paths are unsupported on Windows');
            const statePath =
              integrityPlatform === 'win32'
                ? undefined
                : integrityStatePath({
                    hint: config.integrityStatePath,
                    repoPath: root,
                    gitDir: getGitDir(root),
                    platform: integrityPlatform,
                  });
            created.integrity = integrityAdapter({
              repoPath: root,
              gitDir: getGitDir(root),
              statePath,
              platform: integrityPlatform,
              vault: config.integrityVault,
            });
            // A root may be created only for an empty job store. If durable
            // records exist, a missing root is loss/tampering and must fail.
            const existing = await stateStore.hasDurableEntries();
            await created.integrity.load({ create: !existing });
            stateStore.configureIntegrity(created.integrity);
          }
          const stateLeases = leases || new LeaseManager({ gitDir: getGitDir(root) });
          created.manager = new JobManager({
            store: stateStore,
            runner: resolvedRunner,
            worker: configuredWorker(created),
            snapshots: resolvedSnapshots,
            leases: stateLeases,
            now,
            config: {
              ...config,
              repoPath: root,
              sessionStartedAt: sessionStartIso,
              isolation:
                worker || snapshots
                  ? config.isolation
                  : config.isolation || {
                      integrateRecorded: integrateRecordedTree,
                      create: createIsolatedWorktree,
                      open: openIsolatedWorktree,
                      cleanup: cleanupIsolatedWorktree,
                      pin: pinJobTrees,
                      releasePins: releaseJobTrees,
                    },
              applyPatch: config.applyPatch || gitPatchApplier,
              health:
                config.health ||
                (async () => {
                  const deps = verifierDependencyStatus(root);
                  const python = verifierPythonStatus(root, { allowlist: interpreterAllowlist(root) });
                  return {
                    ...(await sandboxHealth()),
                    worker: workerHealth(root),
                    repo: root,
                    ...deps,
                    ...pythonDeps(deps, python),
                    verifierPython: python,
                    workingTree: workingTreeStatus(root),
                  };
                }),
            },
          });
          states.set(root, created);
          return created;
        })();
        pendingStates.set(root, pending);
        pending.finally(() => pendingStates.delete(root)).catch(() => {});
      }
      state = await pending;
    }
    // Do this before any job/list/wait visibility.  A living detached worker
    // records a fresh PID heartbeat and is not mistaken for a dead server.
    await state.integrity?.reload();
    await state.manager.recover({ exceptIds: exceptRecoveryIds });
    return state;
  };
  const knownStateForJob = async (id, repoPath, { exceptRecoveryIds = [], operational = false } = {}) => {
    const get = (state) => (operational && state.store.getOperational ? state.store.getOperational(id) : state.store.get(id));
    // An explicit repository hint is an authority boundary: canonicalize it
    // and require the job to exist there.  Looking through already-loaded
    // repositories first would let a matching id in another checkout win.
    if (repoPath !== undefined) {
      const state = await makeState(repoPath, { exceptRecoveryIds });
      await get(state);
      return state;
    }
    for (const state of states.values()) {
      try {
        await state.integrity?.reload();
      } catch (error) {
        try {
          await get(state);
        } catch (missing) {
          if (/job not found/.test(missing.message || '')) continue;
        }
        throw error;
      }
      await state.manager.recover({ exceptIds: exceptRecoveryIds });
      try {
        await get(state);
        return state;
      } catch (error) {
        if (!/job not found/.test(error.message || '')) throw error;
      }
    }
    const state = await makeState(undefined, { exceptRecoveryIds });
    await get(state);
    return state;
  };
  // A user-level MCP process is often launched from the offload clone, not
  // the client project. Do not bind that incidental cwd for a no-id list.
  const contextualRepoHint = (opts) =>
    opts.repoPath ||
    mcpRepoHint ||
    config.repoPath ||
    process.env.CLAUDE_PROJECT_DIR ||
    process.env.CODEX_PROJECT_DIR ||
    process.env.CURSOR_PROJECT_DIR;
  let retrospectiveLog;
  const retrospectiveHistory = () =>
    (retrospectiveLog ||= config.retrospectiveLog || createRetrospectiveLog({ dir: config.retrospectiveLogDir }));
  const healthWithoutRepo = async (opts = {}) => {
    const listings = await Promise.all(
      [...states.values()].map((state) =>
        state.manager.listing({
          ...(opts.all !== undefined ? { all: opts.all } : {}),
          ...(opts.maxJobs !== undefined ? { maxJobs: opts.maxJobs } : {}),
        }),
      ),
    );
    if (!listings.length) {
      // Same validation as a bound repository, with nothing to list.
      if (opts.all !== undefined && typeof opts.all !== 'boolean') throw new Error('all must be a boolean');
      if (opts.maxJobs !== undefined && (!Number.isInteger(opts.maxJobs) || opts.maxJobs < 1 || opts.maxJobs > 100))
        throw new Error('maxJobs must be an integer from 1 to 100');
    }
    const merged = mergeListings(listings, opts.maxJobs !== undefined ? { maxJobs: opts.maxJobs } : {});
    const scoped = opts.all !== true;
    return {
      jobs: merged.jobs,
      listing: {
        scope: scoped ? 'session' : 'all',
        ...(scoped ? { sessionStartedAt: sessionStartIso } : {}),
        ...merged.totals,
      },
      health: { ...(await sandboxHealth()), worker: false, repositories: [...states.keys()] },
    };
  };
  const pricingMetadata = (providerConfig, loaded) => {
    let table = config.pricingTable || loadPricing(providerConfig.pricing);
    let identifier = providerConfig.pricing;
    if (!table && providerConfig.pricingFile) {
      const pricePath = resolveConfigRelativePath(providerConfig.pricingFile, loaded.configPath);
      try {
        table = pricingFile(pricePath);
      } catch (error) {
        throw new Error(`unable to load pricing file ${pricePath}: ${error.message || error}`);
      }
      identifier ||= `file:${pricePath}`;
    }
    // Reject malformed rates before a snapshot, lease, or durable job exists.
    // Otherwise a supplied pricing file can create a job that is guaranteed
    // to fail only after the worker has started.
    if (table) validatePricingTable(table);
    // Keep the small, public pricing table alongside the accepted job.  The
    // worker must not silently use a modified pricing file after handoff.
    return { pricingId: identifier, pricingFetchedAt: table?.fetched_at, ...(table ? { pricingSnapshot: structuredClone(table) } : {}) };
  };
  return {
    // Exposing this only helps same-process embeddings/tests; normal callers
    // should route through the operations below so they cannot cross repos.
    get manager() {
      return states.values().next().value?.manager;
    },
    setDefaultRepo(path) {
      validateExplicitRepoPath(path);
      mcpRepoHint = canonicalRepo(path);
      return mcpRepoHint;
    },
    async start(input, { launch = true } = {}) {
      if (closing) throw new Error('offload core is shutting down');
      // Reject caller-controlled structure before makeState initializes a
      // repository's durable store, integrity root, or recovery machinery.
      // JobManager repeats this after Core has added trusted config snapshots.
      validateJobRequest(input);
      // Health remains visible through offload_job, but stale runtime/skill
      // state is a hard boundary here: a client must not spend budget simply
      // because it skipped or overlooked the preflight response.
      assertStartRuntimeCurrent(skillHealth(), { requireCurrentSkill: config.enforceInstalledSkillPreflight === true });
      const state = await makeState(input?.repoPath);
      if (closing) throw new Error('offload core is shutting down');
      const loaded = config.loaded || loadConfig({ configPath: config.configPath, repoPath: state.repoPath });
      if (loaded.disabled) throw new Error('offload is disabled for this repository');
      if (input?.profile && !loaded.config.profiles[input.profile]) throw new Error(`unknown profile: ${input.profile}`);
      const profileName = input.profile || loaded.config.default;
      const profile = loaded.config.profiles[profileName];
      const providerConfig = loaded.config.providers[profile.provider];
      if (providerConfig?.type !== 'openai-chat') throw new Error(`unsupported provider type: ${providerConfig?.type || 'missing'}`);
      assertModelAllowed({ baseUrl: providerConfig.baseUrl, model: profile.model });
      // Resolve before snapshotting or acquiring a lease so a missing key can
      // never leave an executable but unsigned durable job behind.
      if (state.integrity) {
        let credential;
        try {
          credential = state.integrity.preflight(providerConfig.keyRef);
        } catch {
          throw new Error('worker key is unavailable; run offload doctor or configure keyRef');
        }
        // Preserve the resolved value only in the in-memory redaction set.
        // A caller can otherwise put a non-heuristic literal credential in
        // initial task/criteria/test-command text before the worker runs.
        state.store.secrets ||= [];
        if (!state.store.secrets.includes(credential)) state.store.secrets.push(credential);
      }
      const executionProfile = {
        type: providerConfig.type,
        baseUrl: providerConfig.baseUrl,
        keyRef: providerConfig.keyRef,
        model: profile.model,
        effort: profile.effort,
        pricing: providerConfig.pricing,
        attemptTimeoutMs: providerConfig.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS,
        ...(providerConfig.pricingFile ? { pricingFile: resolveConfigRelativePath(providerConfig.pricingFile, loaded.configPath) } : {}),
      };
      // Repository policy may tighten reads, but never expands write scope.
      // A repository-provided verifier is always sandbox-required; only a
      // caller-provided verifier can make the deliberately high-friction
      // policy-only exception.
      const reportMode = input.mode === 'report';
      const callerTest = input.testCommand != null;
      const repoTest = loaded.repoConfig.testCommand;
      const testCommand = reportMode ? undefined : (input.testCommand ?? repoTest);
      const unsafePolicyOnlyVerifier = input.unsafePolicyOnlyVerifier === true;
      if (unsafePolicyOnlyVerifier && !callerTest) throw new Error('unsafePolicyOnlyVerifier requires a caller-supplied testCommand');
      if (input.verifierMode === 'baseline-diff' && !testCommand)
        throw new Error('baseline-diff verification requires a testCommand (supply one or configure the repository testCommand)');
      // A declared interpreter/virtualenv is resolved here, before any snapshot,
      // lease or spend: a rejected declaration creates no job. The stored roots
      // are server-derived, never the caller's input.
      const interpreter =
        input.verifierInterpreter !== undefined && !reportMode
          ? resolveVerifierInterpreters(input.verifierInterpreter, {
              repoPath: state.repoPath,
              writeScope: [...(input.ownedPaths || []), ...(input.extraWritable || [])],
              denyRead: [...(input.denyRead || []), ...(loaded.repoConfig.denyRead || [])],
              allowlist: loaded.config.verifier?.interpreterRoots ?? [],
            })
          : undefined;
      const requireSandbox = reportMode
        ? false
        : input.requireSandbox === true || (!!testCommand && (!callerTest || !unsafePolicyOnlyVerifier));
      // Avoid spending provider budget or allocating a linked workspace when
      // the real built-in lifecycle already knows no macOS sandbox can run a
      // required verifier. A profile-specific failure still fails closed in
      // Runner at verification time.
      if (!worker && requireSandbox && !sandboxAvailable()) throw new Error('Required macOS sandbox is unavailable for this verifier');
      // The caller's turn cap (if any) and policy are resolved against the file
      // sizes by JobManager. `turnPolicy` is deliberately not part of the stored
      // budget; USD remains the ceiling a server-scaled turn cap leans on.
      const requestedTurns = input.budget?.maxTurns;
      const turnPolicy = input.budget?.turnPolicy ?? (requestedTurns === undefined ? 'auto' : 'fixed');
      const budget = {
        maxTurns: requestedTurns ?? loaded.config.limits.maxTurns,
        maxUsd: input.budget?.maxUsd ?? loaded.config.limits.maxUsd,
        timeoutMinutes: input.budget?.timeoutMinutes ?? loaded.config.limits.timeoutMinutes,
      };
      const result = await state.manager.start(
        {
          ...input,
          budget,
          repoPath: state.repoPath,
          ...(reportMode
            ? {}
            : {
                ...(testCommand !== undefined ? { testCommand } : {}),
                ...(callerTest || repoTest ? { testCommandSource: callerTest ? 'caller' : 'repo' } : {}),
                requireSandbox,
                unsafePolicyOnlyVerifier,
                extraWritable: [...(input.extraWritable || [])],
              }),
          denyRead: [...new Set([...(input.denyRead || []), ...(loaded.repoConfig.denyRead || [])])],
          verifierInterpreter: interpreter?.declared,
          verifierInterpreterRoots: interpreter?.roots,
          sandboxMode: sandboxAvailable() ? 'macos' : 'policy-only',
          configuredModel: profile.model,
          executionProfile,
          ...pricingMetadata(providerConfig, loaded),
        },
        {
          launch,
          turnBudget: {
            requested: requestedTurns,
            configured: loaded.config.limits.maxTurns,
            policy: turnPolicy,
            timeoutScalable: input.budget?.timeoutMinutes === undefined,
          },
        },
      );
      if (closing) {
        await state.manager.cancel(result.jobId);
        throw new Error('offload core is shutting down');
      }
      // A Python project has no JavaScript dependencies to report, so its start
      // echo carries the interpreter readiness instead of `not-applicable`.
      if (reportMode || result.verifierDeps !== 'not-applicable' || !pythonProjectMarkers(state.repoPath).length) return result;
      const python = interpreter
        ? { status: 'ok', reason: 'interpreter-declared' }
        : verifierPythonStatus(state.repoPath, { allowlist: loaded.config.verifier?.interpreterRoots ?? [] });
      return {
        ...result,
        verifierDeps: python.status,
        verifierDepsReason: python.reason,
        ...(interpreter ? {} : { verifierPython: python }),
      };
    },
    async assignWorkerPid(id, pid, repoPath) {
      validateJobId(id);
      if (!Number.isInteger(pid) || pid <= 0) throw new Error('worker pid is invalid');
      validateExplicitRepoPath(repoPath);
      const state = await knownStateForJob(id, repoPath, { exceptRecoveryIds: [id] });
      const job = await state.store.get(id);
      // A detached child is allowed to claim only the exact record produced by
      // the parent queue path. In particular, never revive a cancellation (or
      // another terminal/recovery outcome) merely because spawn completed late.
      if (!parentHandoff(job)) return { assigned: false, status: job.status };
      const hasWriteLease = (job.ownedPaths?.length || 0) + (job.extraWritable?.length || 0) > 0;
      const nextOwnerNonce = randomUUID();
      let transferred = false;
      const releaseTransferredLease = async () => {
        if (!transferred) return;
        try {
          await state.manager.releaseLease?.(id, { ownerNonce: nextOwnerNonce });
        } catch {}
      };
      try {
        if (hasWriteLease) {
          await state.manager.transferLease(id, { pid, ownerNonce: job.leaseOwnerNonce, nextOwnerNonce });
          transferred = true;
        }
        // Cancellation writes a durable marker before changing lifecycle
        // state. Consume it here so a transfer that completed concurrently is
        // released using its new nonce rather than the parent's stale nonce.
        if (await state.store.cancelRequested?.(id)) {
          const settled = await state.manager.finishDetachedTerminal(id, {
            ownerNonce: nextOwnerNonce,
            expectedOwnerNonce: job.leaseOwnerNonce,
            status: 'CANCELLED',
          });
          return { assigned: false, status: settled.status };
        }
        const current = await state.store.get(id);
        if (!parentHandoff(current)) {
          await releaseTransferredLease();
          return { assigned: false, status: current.status };
        }
        const assignment = {
          runnerPid: pid,
          leaseOwnerNonce: nextOwnerNonce,
          runnerSpawnedAt: new Date().toISOString(),
          runnerHeartbeatAt: new Date().toISOString(),
          handoffState: 'CHILD_ASSIGNED',
        };
        // A recovery pass can stage FINALIZING after our read but before this
        // write. Publish the child tuple only if the parent handoff we checked
        // still exists; otherwise release only the transferred child lease and
        // preserve the lifecycle winner.
        const assigned =
          typeof state.store.updateOperationalIf === 'function'
            ? await state.store.updateOperationalIf(id, handoffIdentity(current), assignment)
            : parentHandoff(await state.store.get(id))
              ? await state.store.update(id, assignment)
              : null;
        if (!assigned) {
          await releaseTransferredLease();
          const settled = await state.store.get(id);
          return { assigned: false, status: settled.status };
        }
        // The marker can arrive after the pre-write check (including from a
        // different CLI/MCP process). Once CHILD_ASSIGNED is durable, the
        // child may already be in resume(); leave marker consumption and
        // cleanup exclusively to that child rather than racing it here.
        if (await state.store.cancelRequested?.(id)) {
          return { assigned: true, status: assigned.status };
        }
        const settled = await state.store.get(id);
        if (
          settled.status !== 'QUEUED' ||
          settled.handoffState !== 'CHILD_ASSIGNED' ||
          settled.runnerPid !== pid ||
          settled.leaseOwnerNonce !== nextOwnerNonce
        ) {
          await releaseTransferredLease();
          return { assigned: false, status: settled.status };
        }
        return { assigned: true, status: assigned.status };
      } catch (error) {
        let current;
        try {
          current = await state.store.get(id);
        } catch {}
        const assignedChild =
          current?.status === 'QUEUED' &&
          current.handoffState === 'CHILD_ASSIGNED' &&
          current.runnerPid === pid &&
          current.leaseOwnerNonce === nextOwnerNonce;
        // A post-assignment read (for example the cancellation-marker read)
        // can fail after the child already has its durable tuple. It alone
        // owns the transferred lease now; do not release it from the parent.
        if (assignedChild) return { assigned: true, status: current.status };
        // A late cancellation wins over any handoff error. Do not turn an
        // acknowledged terminal result into FAILED; release a lease that was
        // already transferred before returning the clean no-op result.
        if (!parentHandoff(current)) {
          await releaseTransferredLease();
          return { assigned: false, status: current?.status || 'UNKNOWN' };
        }
        try {
          const settled = await state.manager.finishDetachedTerminal(id, {
            ownerNonce: transferred ? nextOwnerNonce : job.leaseOwnerNonce,
            expectedOwnerNonce: job.leaseOwnerNonce,
            status: 'FAILED',
            error: `worker handoff failed: ${error.message || error}`,
          });
          if (settled.status === 'CANCELLED') return { assigned: false, status: settled.status };
        } catch {}
        throw error;
      }
    },
    async failDetached(id, repoPath, error) {
      validateJobId(id);
      validateExplicitRepoPath(repoPath);
      const state = await knownStateForJob(id, repoPath, { exceptRecoveryIds: [id] });
      const job = await state.store.get(id);
      // `assignWorkerPid` may have observed a cancellation while the CLI was
      // still handling a late spawn/transfer error. Never overwrite that
      // terminal state from the parent-side error path.
      if (!parentHandoff(job)) return { failed: false, status: job.status };
      const settled = await state.manager.finishDetachedTerminal(id, {
        ownerNonce: job.leaseOwnerNonce,
        expectedOwnerNonce: job.leaseOwnerNonce,
        status: 'FAILED',
        error: `worker spawn failed: ${error?.message || error}`,
      });
      return { failed: settled.status === 'FAILED', status: settled.status };
    },
    async resume(id, repoPath) {
      validateJobId(id);
      validateExplicitRepoPath(repoPath);
      const state = await knownStateForJob(id, repoPath, { exceptRecoveryIds: [id] });
      return state.manager.resume(id);
    },
    async runDetached(id, repoPath) {
      validateJobId(id);
      validateExplicitRepoPath(repoPath);
      if (repoPath === undefined) throw new Error('detached worker repoPath is required');
      const state = await knownStateForJob(id, repoPath, { exceptRecoveryIds: [id] });
      // The parent atomically transfers the initial lease before the child is
      // allowed to execute. This closes the parent-exit/stale-lease window.
      const deadline = Date.now() + 2_000;
      let job;
      do {
        job = await state.store.get(id);
        if (job.runnerPid === process.pid && job.leaseOwnerNonce && job.handoffState === 'CHILD_ASSIGNED') break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      } while (Date.now() < deadline);
      if (job.runnerPid !== process.pid || !job.leaseOwnerNonce || job.handoffState !== 'CHILD_ASSIGNED')
        throw new Error('detached worker lease handoff did not complete');
      await state.manager.resume(id);
      // Verification can queue automatic repair from a finalizer microtask.
      // Stay alive until the durable lifecycle reaches a true terminal state.
      for (;;) {
        await state.manager.running.get(id);
        const current = await state.store.get(id);
        if (
          ['DONE_VERIFIED', 'DONE_UNVERIFIED', 'VERIFY_FAILED', 'VERIFY_ENV_FAILED', 'FAILED', 'TIMEOUT', 'BUDGET', 'CANCELLED'].includes(
            current.status,
          )
        )
          return state.manager.job(id);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    },
    async wait(id, opts = {}) {
      validateJobId(id);
      validateExplicitRepoPath(opts.repoPath);
      const state = await knownStateForJob(id, opts.repoPath);
      return state.manager.wait(id, opts);
    },
    async job(id, opts = {}) {
      validateExplicitRepoPath(opts.repoPath);
      if (id !== undefined && (opts.all !== undefined || opts.maxJobs !== undefined))
        throw new Error('all and maxJobs apply only to the job list; omit jobId');
      if (opts.verifierInterpreter !== undefined) {
        if (id !== undefined) throw new Error('verifierInterpreter applies only to the health call; omit jobId');
        normalizeInterpreterDeclaration(opts.verifierInterpreter);
      }
      if (id === undefined && (opts.tail !== undefined || opts.limit !== undefined)) {
        // Same order as JobManager.job: bad values are named before misuse.
        resolveLogWindow({ tail: opts.tail, limit: opts.limit });
        throw new Error('tail and limit require a jobId and include "log"');
      }
      if (id !== undefined) {
        validateJobId(id);
        const state = await knownStateForJob(id, opts.repoPath);
        return state.manager.job(id, opts);
      }
      const contextualHint = contextualRepoHint(opts);
      const listOptions = {
        ...(opts.all !== undefined ? { all: opts.all } : {}),
        ...(opts.maxJobs !== undefined ? { maxJobs: opts.maxJobs } : {}),
      };
      // `verifierInterpreter` makes health actually run the declared interpreter
      // inside the verifier sandbox, so the primary learns before spending a job.
      const probed = async (listing, root) => {
        if (opts.verifierInterpreter === undefined) return listing;
        const probe = await probeVerifierInterpreter(opts.verifierInterpreter, {
          repoPath: root,
          allowlist: interpreterAllowlist(root),
          ...(config.runVerifierProbe ? { run: config.runVerifierProbe } : {}),
        });
        const mirror = root && pythonProjectMarkers(root).length ? pythonDeps(verifierDependencyStatus(root), probe) : {};
        return { ...listing, health: { ...listing.health, ...mirror, verifierPython: probe } };
      };
      if (!contextualHint) return probed(await healthWithoutRepo(listOptions));
      try {
        const state = await makeState(contextualHint);
        return probed(await state.manager.job(undefined, listOptions), state.repoPath);
      } catch (error) {
        if (/repoPath must be inside/.test(error.message || '')) return probed(await healthWithoutRepo(listOptions));
        throw error;
      }
    },
    /**
     * The evidence digest and prompt skeleton for an `/offload` run (see
     * retrospective.mjs): the jobs of this server session, the named
     * `jobIds`, or the newest `last` of the store. Read-only apart from one
     * bounded local history line, which `persist: false` skips.
     */
    async retrospective(opts = {}) {
      validateExplicitRepoPath(opts.repoPath);
      const ids = opts.jobIds;
      if (ids !== undefined) {
        if (!Array.isArray(ids) || !ids.length || ids.length > MAX_RETROSPECTIVE_JOBS || new Set(ids).size !== ids.length)
          throw new Error(`jobIds must be 1-${MAX_RETROSPECTIVE_JOBS} distinct job ids`);
        ids.forEach(validateJobId);
        if (opts.last !== undefined) throw new Error('last applies only without jobIds');
      }
      if (opts.last !== undefined && (!Number.isInteger(opts.last) || opts.last < 1 || opts.last > MAX_RETROSPECTIVE_JOBS))
        throw new Error(`last must be an integer from 1 to ${MAX_RETROSPECTIVE_JOBS}`);
      let sources;
      if (ids) {
        const byState = new Map();
        for (const id of ids) {
          const state = await knownStateForJob(id, opts.repoPath, { operational: true });
          byState.set(state, [...(byState.get(state) || []), id]);
        }
        sources = [...byState].map(([state, list]) => [state, state.manager.retrospectiveSource({ ids: list })]);
      } else {
        const hint = contextualRepoHint(opts);
        let bound = [...states.values()];
        if (hint) {
          try {
            bound = [await makeState(hint)];
          } catch (error) {
            if (!/repoPath must be inside/.test(error.message || '')) throw error;
          }
        }
        sources = bound.map((state) => [
          state,
          state.manager.retrospectiveSource({ ...(opts.last !== undefined ? { last: opts.last } : {}) }),
        ]);
      }
      const resolved = await Promise.all(sources.map(async ([state, source]) => ({ state, source: await source })));
      const jobs = resolved.flatMap(({ source }) => source.jobs).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      const shown = jobs.slice(0, opts.last ?? MAX_RETROSPECTIVE_JOBS);
      const health = resolved.length
        ? await Promise.resolve(resolved[0].state.manager.config.health?.()).catch(() => ({}))
        : await sandboxHealth().catch(() => ({}));
      const result = buildRetrospective({
        jobs: shown,
        health,
        nowMs: nowMs(),
        scope: ids ? 'jobs' : opts.last !== undefined ? 'recent' : 'session',
        maintainerRoot: config.maintainerRoot || PACKAGE_ROOT,
        secrets: resolved.flatMap(({ source }) => source.secrets),
        omittedJobs:
          opts.last !== undefined ? 0 : resolved.reduce((total, { source }) => total + source.omitted, 0) + jobs.length - shown.length,
      });
      if (opts.persist !== false)
        try {
          retrospectiveHistory().append(result);
        } catch {
          // The history is an aid; the digest is what was asked for.
        }
      return result;
    },
    /** What earlier retrospectives recorded locally and which signals keep coming back. */
    async retrospectiveHistory(opts = {}) {
      return retrospectiveHistory().history(opts);
    },
    async repair(id, defects, opts = {}) {
      if (closing) throw new Error('offload core is shutting down');
      validateJobId(id);
      validateExplicitRepoPath(opts.repoPath);
      const state = await knownStateForJob(id, opts.repoPath);
      return state.manager.repair(id, defects, { launch: opts.launch !== false });
    },
    async continue(id, opts = {}) {
      if (closing) throw new Error('offload core is shutting down');
      validateJobId(id);
      validateExplicitRepoPath(opts.repoPath);
      const state = await knownStateForJob(id, opts.repoPath);
      return state.manager.continue(id, {
        extraTurns: opts.extraTurns,
        extraUsd: opts.extraUsd,
        note: opts.note,
        launch: opts.launch !== false,
      });
    },
    async apply(id, opts = {}) {
      if (closing) throw new Error('offload core is shutting down');
      validateJobId(id);
      validateExplicitRepoPath(opts.repoPath);
      const state = await knownStateForJob(id, opts.repoPath);
      return state.manager.apply(id, {
        apply: opts.apply ?? false,
        verifiedBy: opts.verifiedBy,
        // Only with a command, so a plain apply reaches the manager exactly as before.
        ...(opts.applyThenVerify !== undefined
          ? {
              applyThenVerify: opts.applyThenVerify,
              ...(opts.applyThenVerifyTimeoutSec !== undefined ? { applyThenVerifyTimeoutSec: opts.applyThenVerifyTimeoutSec } : {}),
              ...(opts.unsafePolicyOnlyVerifier !== undefined ? { unsafePolicyOnlyVerifier: opts.unsafePolicyOnlyVerifier } : {}),
              ...(opts.signal ? { signal: opts.signal } : {}),
            }
          : {}),
      });
    },
    async cancel(id, opts = {}) {
      validateJobId(id);
      validateExplicitRepoPath(opts.repoPath);
      const state = await knownStateForJob(id, opts.repoPath, { operational: true });
      return state.manager.cancel(id);
    },
    async revert(id, opts = {}) {
      validateJobId(id);
      validateExplicitRepoPath(opts.repoPath);
      const state = await knownStateForJob(id, opts.repoPath);
      return state.manager.revert(id, opts);
    },
    async recover(repoPath) {
      validateExplicitRepoPath(repoPath);
      const state = await makeState(repoPath);
      return state.manager.recover();
    },
    async shutdown(options) {
      closing = true;
      const pending = [...pendingStates.values()];
      await Promise.allSettled(pending);
      await Promise.all([...states.values()].map((state) => state.manager.shutdown(options)));
    },
  };
}
