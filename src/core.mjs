import { execFileSync } from 'node:child_process';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { LeaseManager, getGitDir } from './lease.mjs';
import { JobStore } from './store.mjs';
import { Runner } from './runner.mjs';
import { JobManager, validateExplicitRepoPath, validateJobId, validateJobRequest } from './job-manager.mjs';
import { sandboxAvailable } from './sandbox.mjs';
import { snapshotWorkingTree, diffTrees, diffTreeFiles, git as snapshotGit, snapshotGitEnv } from './git-snapshot.mjs';
import { createIsolatedWorktree, openIsolatedWorktree, cleanupIsolatedWorktree, pinJobTrees, releaseJobTrees } from './worktree.mjs';
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
import { OpenAIChatProvider } from './provider/openai-chat.mjs';
import { PathPolicy } from './policy.mjs';
import { LocalTools, availableToolDefinitions } from './agent/tools.mjs';
import { AgentLoop } from './agent/loop.mjs';
import { AgentContext } from './agent/context.mjs';
import { buildSystemPrompt } from './agent/prompt.mjs';
import { loadPricing } from './pricing-registry.mjs';
import { validatePricingTable } from './pricing.mjs';
import { readRegularFileSync } from './regular-file.mjs';

// Repository discovery must not pass provider credentials, ambient Git
// redirects, filters, hooks, or fsmonitor helpers to a repository command.
const command = (repo, args) => snapshotGit(repo, args).trim();
const MAX_PRICING_BYTES = 1024 * 1024;
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
  if (insidePath(path, repoPath) || insidePath(path, gitDir))
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
  const hardening = ['-C', repoPath, '-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${hooks}`];
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
export function createCore({ store, runner, worker, snapshots, leases, config = {}, now } = {}) {
  const resolvedRunner = runner || new Runner({ defaults: { sandbox: true } });
  const resolvedSnapshots = snapshots || gitSnapshots();
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
        });
        // A queued job is an immutable execution request.  In particular, do not
        // let a later .offload.json edit relax (or unexpectedly revoke) its policy.
        // repoPath remains the public/lease identity; a real Core job executes
        // only inside its private linked worktree.
        const executionPath = job.workspacePath || job.repoPath;
        const policy = new PathPolicy({
          repoPath: executionPath,
          ownedPaths: job.ownedPaths,
          extraWritable: job.extraWritable || [],
          denyRead: job.denyRead || [],
        });
        const runCommand = sandboxAvailable()
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
                allowNetwork: job.allowNetwork,
                requireSandbox: true,
              });
            }
          : undefined;
        const tools = new LocalTools({ repoPath: job.repoPath, policy, ...(runCommand ? { runCommand } : {}) });
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
        const prior = (await state.store.readMessages?.(job.id)) || [];
        const context = new AgentContext(prior, { onAppend: api.appendMessage, onAppendBatch: api.appendMessages });
        const repair = `Repair these concrete defects:\n${(api.defects?.length ? api.defects : ['Continue the job and re-check the acceptance criteria.']).map((x) => `- ${x}`).join('\n')}`;
        const totalTurns = job.budget?.maxTurns ?? loaded?.config.limits.maxTurns,
          totalUsd = job.budget?.maxUsd ?? loaded?.config.limits.maxUsd;
        const remainingTurns = totalTurns - (job.turns || 0),
          remainingUsd = totalUsd - (job.costUsd || 0);
        const totalTimeoutMs = (job.budget?.timeoutMinutes ?? loaded?.config.limits.timeoutMinutes) * 60_000;
        const remainingTimeoutMs =
          totalTimeoutMs - Math.max(0, Date.now() - Date.parse(job.wallStartedAt || job.createdAt || new Date().toISOString()));
        if (remainingTurns < 1 || remainingUsd <= 0)
          return { status: 'BUDGET', turn: 0, costUsd: 0, usage: {}, error: 'Cumulative job budget exhausted' };
        if (remainingTimeoutMs < 1) return { status: 'TIMEOUT', turn: 0, costUsd: 0, usage: {}, error: 'Cumulative job timeout exhausted' };
        const loop = new AgentLoop({
          provider,
          tools,
          toolDefinitions: availableToolDefinitions({ allowCommand: !!runCommand }),
          context,
          pricing,
          model: profile.model,
          maxTurns: remainingTurns,
          timeoutMs: remainingTimeoutMs,
          maxUsd: remainingUsd,
          signal: api.signal,
          progress: api.progress,
        });
        // The initial prompt is durable conversation state. A repair appends only
        // its defect user turn; it never repeats system/task/history prefixes.
        const rawResult = await loop.run(
          prior.length
            ? { task: repair }
            : { system: await buildSystemPrompt({ ...job, repoPath: executionPath, allowCommand: !!runCommand }), task: job.task },
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
                : integrityStatePath({ hint: config.integrityStatePath, repoPath: root, gitDir: getGitDir(root), platform: integrityPlatform });
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
              isolation:
                worker || snapshots
                  ? config.isolation
                  : config.isolation || {
                      create: createIsolatedWorktree,
                      open: openIsolatedWorktree,
                      cleanup: cleanupIsolatedWorktree,
                      pin: pinJobTrees,
                      releasePins: releaseJobTrees,
                    },
              applyPatch: config.applyPatch || gitPatchApplier,
              health:
                config.health ||
                (async () => ({ sandbox: sandboxAvailable() ? 'macos' : 'policy-only', worker: workerHealth(root), repo: root })),
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
  const healthWithoutRepo = async () => ({
    jobs: (await Promise.all([...states.values()].map((state) => state.manager.list()))).flat(),
    health: { sandbox: sandboxAvailable() ? 'macos' : 'policy-only', worker: false, repositories: [...states.keys()] },
  });
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
      const state = await makeState(input?.repoPath);
      if (closing) throw new Error('offload core is shutting down');
      const loaded = config.loaded || loadConfig({ configPath: config.configPath, repoPath: state.repoPath });
      if (loaded.disabled) throw new Error('offload is disabled for this repository');
      if (input?.profile && !loaded.config.profiles[input.profile]) throw new Error(`unknown profile: ${input.profile}`);
      const profileName = input.profile || loaded.config.default;
      const profile = loaded.config.profiles[profileName];
      const providerConfig = loaded.config.providers[profile.provider];
      if (providerConfig?.type !== 'openai-chat') throw new Error(`unsupported provider type: ${providerConfig?.type || 'missing'}`);
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
        ...(providerConfig.pricingFile ? { pricingFile: resolveConfigRelativePath(providerConfig.pricingFile, loaded.configPath) } : {}),
      };
      // Repository policy may tighten reads, but never expands write scope.
      // A repository-provided verifier is always sandbox-required; only a
      // caller-provided verifier can make the deliberately high-friction
      // policy-only exception.
      const callerTest = input.testCommand != null;
      const repoTest = loaded.repoConfig.testCommand;
      const testCommand = input.testCommand ?? repoTest;
      const unsafePolicyOnlyVerifier = input.unsafePolicyOnlyVerifier === true;
      if (unsafePolicyOnlyVerifier && !callerTest) throw new Error('unsafePolicyOnlyVerifier requires a caller-supplied testCommand');
      const requireSandbox = input.requireSandbox === true || (!!testCommand && (!callerTest || !unsafePolicyOnlyVerifier));
      // Avoid spending provider budget or allocating a linked workspace when
      // the real built-in lifecycle already knows no macOS sandbox can run a
      // required verifier. A profile-specific failure still fails closed in
      // Runner at verification time.
      if (!worker && requireSandbox && !sandboxAvailable()) throw new Error('Required macOS sandbox is unavailable for this verifier');
      const budget = {
        maxTurns: input.budget?.maxTurns ?? loaded.config.limits.maxTurns,
        maxUsd: input.budget?.maxUsd ?? loaded.config.limits.maxUsd,
        timeoutMinutes: input.budget?.timeoutMinutes ?? loaded.config.limits.timeoutMinutes,
      };
      const result = await state.manager.start(
        {
          ...input,
          budget,
          repoPath: state.repoPath,
          testCommand,
          testCommandSource: callerTest ? 'caller' : repoTest ? 'repo' : undefined,
          requireSandbox,
          unsafePolicyOnlyVerifier,
          extraWritable: [...(input.extraWritable || [])],
          denyRead: [...new Set([...(input.denyRead || []), ...(loaded.repoConfig.denyRead || [])])],
          sandboxMode: sandboxAvailable() ? 'macos' : 'policy-only',
          configuredModel: profile.model,
          executionProfile,
          ...pricingMetadata(providerConfig, loaded),
        },
        { launch },
      );
      if (closing) {
        await state.manager.cancel(result.jobId);
        throw new Error('offload core is shutting down');
      }
      return result;
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
      const nextOwnerNonce = randomUUID();
      let transferred = false;
      const releaseTransferredLease = async () => {
        if (!transferred) return;
        try {
          await state.manager.releaseLease?.(id, { ownerNonce: nextOwnerNonce });
        } catch {}
      };
      try {
        await state.manager.transferLease(id, { pid, ownerNonce: job.leaseOwnerNonce, nextOwnerNonce });
        transferred = true;
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
        if (['DONE_VERIFIED', 'DONE_UNVERIFIED', 'VERIFY_FAILED', 'FAILED', 'TIMEOUT', 'BUDGET', 'CANCELLED'].includes(current.status))
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
      if (id !== undefined) {
        validateJobId(id);
        const state = await knownStateForJob(id, opts.repoPath);
        return state.manager.job(id, opts);
      }
      // A user-level MCP process is often launched from the offload clone, not
      // the client project. Do not bind that incidental cwd for a no-id list.
      const contextualHint =
        opts.repoPath ||
        mcpRepoHint ||
        config.repoPath ||
        process.env.CLAUDE_PROJECT_DIR ||
        process.env.CODEX_PROJECT_DIR ||
        process.env.CURSOR_PROJECT_DIR;
      if (!contextualHint) return healthWithoutRepo();
      try {
        const state = await makeState(contextualHint);
        return state.manager.job();
      } catch (error) {
        if (/repoPath must be inside/.test(error.message || '')) return healthWithoutRepo();
        throw error;
      }
    },
    async repair(id, defects, opts = {}) {
      if (closing) throw new Error('offload core is shutting down');
      validateJobId(id);
      validateExplicitRepoPath(opts.repoPath);
      const state = await knownStateForJob(id, opts.repoPath);
      return state.manager.repair(id, defects, { launch: opts.launch !== false });
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
