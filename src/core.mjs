import { execFileSync } from 'node:child_process';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { LeaseManager, getGitDir } from './lease.mjs';
import { JobStore } from './store.mjs';
import { Runner } from './runner.mjs';
import {
  JobManager,
  executionFallbacks,
  recordedProviderStage,
  mergeListings,
  validateExplicitRepoPath,
  validateJobId,
  validateJobRequest,
} from './job-manager.mjs';
import { probeVerifierTemp, sandboxAvailable, sandboxStatus } from './sandbox.mjs';
import { healthIdentity, runtimeIdentity } from './identity.mjs';
import { assertStartRuntimeCurrent, installedSkillHealth, withSkillHealth } from './skill-health.mjs';
import {
  normalizeInterpreterDeclaration,
  normalizeVerifierImports,
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
import { defaultConfigPath, legacyRoutingStatus, loadConfig, resolveConfigRelativePath } from './config.mjs';
import { WINDOWS_INTEGRITY_ROOT_CREDENTIAL, readWindowsCredential, resolveKeyRef, storeWindowsCredential } from './secrets.mjs';
import {
  PosixIntegrityRoot,
  WindowsIntegrityRoot,
  canonicalIntegrityStatePath,
  credentialFingerprint,
  deriveJobMacKey,
  sameCredentialFingerprint,
  validCredentialFingerprint,
  validCredentialFingerprints,
} from './integrity.mjs';
import { DEFAULT_ATTEMPT_TIMEOUT_MS, OpenAIChatProvider, ProviderError } from './provider/openai-chat.mjs';
import { AnthropicMessagesProvider, resolveLatestAnthropicSonnet, resolveLatestAnthropicOpus } from './provider/anthropic-messages.mjs';
import { CreditFallbackProvider } from './provider/fallback.mjs';
import { PathPolicy } from './policy.mjs';
import { LocalTools, availableToolDefinitions } from './agent/tools.mjs';
import { AgentLoop } from './agent/loop.mjs';
import { AgentContext } from './agent/context.mjs';
import { annotateRelevantPaths, buildSystemPrompt } from './agent/prompt.mjs';
import { loadPricing } from './pricing-registry.mjs';
import {
  assertModelAllowed,
  OFFLOAD_ANTHROPIC_LATEST_SONNET,
  OFFLOAD_ANTHROPIC_LATEST_OPUS,
  isDeepSeekEndpoint,
  isOpenAIEndpoint,
  isOpenAITerraModel,
  isOpenAISolModel,
  OFFLOAD_OPENAI_LATEST_TERRA,
  OFFLOAD_OPENAI_LATEST_SOL,
  OFFLOAD_DEEPSEEK_LATEST_FLASH,
  OFFLOAD_DEEPSEEK_MODEL,
} from './model-policy.mjs';
import { resolveModel, validatePricingTable } from './pricing.mjs';
import { readRegularFileSync } from './regular-file.mjs';
import { matchesAny } from './glob.mjs';
import { assertVerifierCommand } from './verifier-command.mjs';

// Repository discovery must not pass provider credentials, ambient Git
// redirects, filters, hooks, or fsmonitor helpers to a repository command.
const command = (repo, args) => snapshotGit(repo, args).trim();
const MAX_PRICING_BYTES = 1024 * 1024;
// The Offload checkout this server runs from: the one a maintainer prompt names.
const PACKAGE_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
// The configured verifier duration thresholds a job records at start; undefined keeps the defaults.
const verifierDurationConfig = (verifier) => {
  const value = {
    ...(verifier?.minDurationFraction !== undefined ? { minFraction: verifier.minDurationFraction } : {}),
    ...(verifier?.expectedMsPerKiB !== undefined ? { msPerKiB: verifier.expectedMsPerKiB } : {}),
  };
  return Object.keys(value).length ? value : undefined;
};
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

export async function resolveLatestDeepSeekFlash({ baseUrl, apiKey, fetchImpl = globalThis.fetch, signal } = {}) {
  let response;
  try {
    response = await fetchImpl(new URL('models', `${baseUrl.replace(/\/+$/, '')}/`).href, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal,
      redirect: 'error',
    });
  } catch {
    throw new Error('DeepSeek model discovery failed');
  }
  if (!response.ok) throw new Error(`DeepSeek model discovery failed (HTTP ${response.status})`);
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error('DeepSeek model discovery returned invalid JSON');
  }
  const model = Array.isArray(body?.data) ? body.data.find((entry) => entry?.id === OFFLOAD_DEEPSEEK_MODEL) : undefined;
  if (!model) throw new Error('No provider-maintained DeepSeek Flash model is available');
  return model.id;
}

const OPENAI_LINES = {
  terra: { label: 'Terra', matches: isOpenAITerraModel },
  sol: { label: 'Sol', matches: isOpenAISolModel },
};
/** Highest `gpt-<major>[.<minor>]-<line>` by numeric version, never by `created` or list order. */
export async function resolveLatestOpenAI(line, { baseUrl, key, apiKey = key, fetch, fetchImpl = fetch ?? globalThis.fetch, signal } = {}) {
  const spec = OPENAI_LINES[line];
  if (!spec) throw new TypeError('unsupported OpenAI model line');
  let response;
  try {
    response = await fetchImpl(new URL('models', `${baseUrl.replace(/\/+$/, '')}/`).href, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal,
      redirect: 'error',
    });
  } catch {
    throw new ProviderError('OpenAI model discovery failed');
  }
  if (!response.ok) throw new ProviderError('OpenAI model discovery failed', { status: response.status, kind: 'http' });
  let body;
  try {
    body = await response.json();
  } catch {
    throw new ProviderError('OpenAI model discovery returned invalid JSON');
  }
  const version = (id) => {
    const [, major, minor] = /^gpt-(\d+)(?:\.(\d+))?-/.exec(id);
    return [Number(major), Number(minor ?? 0)];
  };
  let best;
  for (const entry of Array.isArray(body?.data) ? body.data : []) {
    const id = entry?.id;
    if (!spec.matches(id)) continue;
    const [major, minor] = version(id);
    if (!best || major > best.major || (major === best.major && minor > best.minor)) best = { id, major, minor };
  }
  if (!best) throw new ProviderError(`No supported OpenAI ${spec.label} model is available`);
  return best.id;
}

// Only a ProviderError's bare HTTP status is safe to surface from discovery;
// its message, body and every other field may carry provider detail.
function safeDiscoveryStatusSuffix(error) {
  if (!(error instanceof ProviderError)) return '';
  const status = error.status;
  return Number.isSafeInteger(status) && status >= 100 && status <= 599 ? ` (HTTP ${status})` : '';
}

/** How to supply a missing worker key; the save command is only printed where it is real. */
function keySaveHint(keyRef, provider) {
  return /^keychain:[\w.-]+$/.test(String(keyRef)) && /^[\w-]+$/.test(String(provider))
    ? `save it with: node install.mjs --key=${provider} (from the Offload checkout)`
    : 'run offload doctor or configure keyRef';
}

async function resolveProfileModel(profile, provider, key, { fetchImpl, signal } = {}) {
  if (profile.model === OFFLOAD_ANTHROPIC_LATEST_OPUS)
    return resolveLatestAnthropicOpus({ baseUrl: provider.baseUrl, apiKey: key, fetchImpl, signal });
  if (profile.model === OFFLOAD_ANTHROPIC_LATEST_SONNET)
    return resolveLatestAnthropicSonnet({ baseUrl: provider.baseUrl, apiKey: key, fetchImpl, signal });
  if (profile.model === OFFLOAD_DEEPSEEK_LATEST_FLASH)
    return resolveLatestDeepSeekFlash({ baseUrl: provider.baseUrl, apiKey: key, fetchImpl, signal });
  if (profile.model === OFFLOAD_OPENAI_LATEST_TERRA)
    return resolveLatestOpenAI('terra', { baseUrl: provider.baseUrl, key, fetchImpl, signal });
  if (profile.model === OFFLOAD_OPENAI_LATEST_SOL) return resolveLatestOpenAI('sol', { baseUrl: provider.baseUrl, key, fetchImpl, signal });
  return profile.model;
}

function providerInstance(providerConfig, key, model, { fetchImpl, reasoningEffort } = {}) {
  const options = {
    baseUrl: providerConfig.baseUrl,
    apiKey: key,
    model,
    timeoutMs: providerConfig.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS,
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(fetchImpl ? { fetchImpl } : {}),
  };
  if (providerConfig.type === 'anthropic-messages') return new AnthropicMessagesProvider(options);
  if (providerConfig.type === 'openai-chat')
    return new OpenAIChatProvider({
      ...options,
      ...(isDeepSeekEndpoint(providerConfig.baseUrl) ? { thinking: { type: 'enabled' }, reasoningEffort: reasoningEffort ?? 'high' } : {}),
      ...(isOpenAIEndpoint(providerConfig.baseUrl) ? { reasoningEffort: 'high' } : {}),
    });
  throw new Error(`unsupported provider type: ${providerConfig?.type || 'missing'}`);
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
        const routes = executionFallbacks(execution);
        if (!routes.length) return { primary: credential };
        // Legacy records carry only the singular fingerprint of their one fallback.
        const stored =
          job.fallbackCredentialFingerprints ?? (job.fallbackCredentialFingerprint ? [job.fallbackCredentialFingerprint] : undefined);
        if (
          !validCredentialFingerprints(stored) ||
          stored.length !== routes.length ||
          routes.some((route) => typeof route.keyRef !== 'string')
        )
          throw new Error('stored job credential check failed');
        const fallbacks = routes.map((route, index) => {
          const value = resolveCredential(route.keyRef);
          if (!sameCredentialFingerprint(stored[index], credentialFingerprint(root.value, value)))
            throw new Error('stored job credential check failed');
          return value;
        });
        return { primary: credential, fallback: fallbacks[0], fallbacks };
      },
      async prepare(job) {
        const execution = job?.executionProfile;
        if (!execution || typeof execution.keyRef !== 'string') throw new Error('job credential is unavailable');
        const credential = resolveCredential(execution.keyRef);
        const routes = executionFallbacks(execution);
        if (routes.some((route) => typeof route.keyRef !== 'string')) throw new Error('job credential is unavailable');
        const fingerprints = routes.map((route) => credentialFingerprint(root.value, resolveCredential(route.keyRef)));
        return {
          ...job,
          credentialFingerprint: credentialFingerprint(root.value, credential),
          ...(fingerprints.length ? { fallbackCredentialFingerprint: fingerprints[0], fallbackCredentialFingerprints: fingerprints } : {}),
        };
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
        if (!['openai-chat', 'anthropic-messages'].includes(providerConfig?.type))
          throw new Error(`unsupported provider type: ${providerConfig?.type || 'missing'}`);
        // Execution profiles contain a concrete model snapshot. A direct
        // embedded worker without one remains limited to ordinary configured
        // models; selectors are resolved only while accepting a job.
        assertModelAllowed({ type: providerConfig.type, baseUrl: providerConfig.baseUrl, model: profile.model });
        let key, authenticated;
        try {
          authenticated = state.integrity ? await state.integrity.authenticate(job) : undefined;
          key = authenticated?.primary || (config.resolveKey || resolveKeyRef)(providerConfig.keyRef);
        } catch {
          throw new Error('worker key is unavailable; run offload doctor or configure keyRef');
        }
        state.store.secrets ||= [];
        if (!state.store.secrets.includes(key)) state.store.secrets.push(key);
        let provider = providerInstance(providerConfig, key, profile.model, {
          reasoningEffort: (job.effort || profile.effort) === 'high' ? 'high' : undefined,
        });
        const fallbackConfigs = executionFallbacks(execution);
        if (fallbackConfigs.length) {
          const routes = [{ provider, model: profile.model }];
          fallbackConfigs.forEach((fallbackConfig, index) => {
            assertModelAllowed({ type: fallbackConfig.type, baseUrl: fallbackConfig.baseUrl, model: fallbackConfig.model });
            let fallbackKey;
            try {
              fallbackKey = authenticated?.fallbacks?.[index] || (config.resolveKey || resolveKeyRef)(fallbackConfig.keyRef);
            } catch {
              throw new Error('fallback worker key is unavailable; run offload doctor or configure keyRef');
            }
            if (!state.store.secrets.includes(fallbackKey)) state.store.secrets.push(fallbackKey);
            routes.push({
              provider: providerInstance(fallbackConfig, fallbackKey, fallbackConfig.model, {
                reasoningEffort: (job.effort || fallbackConfig.effort) === 'high' ? 'high' : undefined,
              }),
              model: fallbackConfig.model,
            });
          });
          // A continuation or repair resumes on the persisted stage, never the primary.
          const stage = recordedProviderStage(job);
          if (stage >= routes.length) throw new Error('stored job has an invalid provider stage');
          provider = new CreditFallbackProvider({
            routes,
            stage,
            onTransition: (toStage) => api.progress({ action: 'provider_credit_fallback', providerStage: toStage, creditFallback: true }),
          });
        }
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
        // Retained jobs also need an exact fallback price before any request;
        // an older/static execution snapshot must not bypass the start gate.
        for (const fallbackConfig of fallbackConfigs)
          if (!pricing || !resolveModel(pricing, fallbackConfig.model))
            throw new Error(`pricing is unknown for selected fallback model ${fallbackConfig.model}`);
        // Report workers may read caller-supplied external bodies. Their
        // conversational/tool transcript is therefore intentionally
        // ephemeral: only the separately-sanitized report result is durable.
        // Write jobs retain their exact resume and transcript semantics.
        const stored = job.mode === 'report' ? [] : (await state.store.readMessages?.(job.id)) || [];
        // A named assertion pass starts a fresh protocol conversation; replaying
        // the implementation history can consume its entire fixed allowance.
        // Retain that history for audit, and resume from this sealed offset.
        const prior = job.assertionRepair ? stored.slice(job.assertionRepair.transcriptStart) : stored;
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
          reportMode: job.mode === 'report',
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
          ...(job.mode === 'report'
            ? {}
            : {
                checkOwnedPaths: async () => {
                  const after = await resolvedSnapshots.create(executionPath);
                  const changed = await resolvedSnapshots.files(executionPath, job.before, after);
                  return job.ownedPaths.filter((pattern) => !changed.some((file) => matchesAny(file.path, [pattern])));
                },
              }),
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
                  task: job.assertionRepair?.round === (job.rounds || 0) ? repair : job.task,
                },
        );
        const responseModel = rawResult.model;
        const mismatch =
          responseModel && responseModel !== profile.model && provider.allowsResponseModel?.(profile.model, responseModel) !== true
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
      if (loaded.disabled || !['openai-chat', 'anthropic-messages'].includes(provider?.type)) return false;
      // Resolve only as a boolean preflight; never place the key or resolver
      // diagnostics in a health response.
      const key = (config.resolveKey || resolveKeyRef)(provider.keyRef);
      return typeof key === 'string' && key.length > 0;
    } catch {
      return false;
    }
  };
  // A config copied from an earlier example still routes a command Claude
  // first; health names it so every client, not only the Claude banner, sees it.
  const legacyRouting = (root) => {
    try {
      const loaded = config.loaded || loadConfig({ configPath: config.configPath, repoPath: root });
      const status = legacyRoutingStatus({ profiles: loaded.config.profiles, configPath: loaded.configPath });
      return status ? { legacyClaudeFirst: status } : {};
    } catch {
      return {};
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
        (config.skillHealth || installedSkillHealth)({
          expectedHash: runtimeIdentity().skillHash,
          expectedOpusHash: runtimeIdentity().opusSkillHash,
        }),
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
                    ...legacyRouting(root),
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
      health: {
        ...(await sandboxHealth()),
        worker: false,
        repositories: [...states.keys()],
        verifierEnvironmentFailures: (
          await Promise.all(
            [...states.values()].map(async (state) =>
              (await state.manager.verifierEnvironmentFailures()).map((failure) => ({ ...failure, repo: state.repoPath })),
            ),
          )
        ).flat(),
      },
    };
  };
  const pricingMetadata = (providerConfigs, loaded, requiredModels = []) => {
    const inputs = Array.isArray(providerConfigs) ? providerConfigs : [providerConfigs];
    const tables = inputs.map((providerConfig, index) => {
      // An injected table is a test/embedding override for the selected
      // primary provider only. A fallback always receives its own recorded
      // table, so it cannot inherit unrelated rates by accident.
      let table = index === 0 ? config.pricingTable || loadPricing(providerConfig.pricing) : loadPricing(providerConfig.pricing);
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
      if (table) validatePricingTable(table);
      return { table, identifier };
    });
    const supplied = tables.filter((entry) => entry.table);
    let table;
    if (supplied.length === 1) table = structuredClone(supplied[0].table);
    else if (supplied.length > 1) {
      table = { models: {}, legacy_aliases: {}, sources: [] };
      for (const entry of supplied) {
        if (entry.table.peak) {
          if (table.peak && JSON.stringify(table.peak) !== JSON.stringify(entry.table.peak))
            throw new Error('fallback pricing peak schedule conflicts with the primary provider');
          table.peak ||= structuredClone(entry.table.peak);
        }
        for (const [model, price] of Object.entries(entry.table.models)) {
          if (Object.hasOwn(table.models, model) && JSON.stringify(table.models[model]) !== JSON.stringify(price))
            throw new Error(`conflicting pricing entries for ${model}`);
          table.models[model] = structuredClone(price);
        }
        for (const [alias, model] of Object.entries(entry.table.legacy_aliases || {})) {
          if (Object.hasOwn(table.legacy_aliases, alias) && table.legacy_aliases[alias] !== model)
            throw new Error(`conflicting pricing aliases for ${alias}`);
          table.legacy_aliases[alias] = model;
        }
        if (Array.isArray(entry.table.sources)) table.sources.push(...entry.table.sources);
      }
    }
    // A finite job must not discover an unpriced newer model after a paid
    // request. Dynamic discovery is therefore paired with a price snapshot;
    // an unfamiliar release fails before a job, lease, or provider call. Every
    // fallback requires an exact price, including a concrete configured route.
    for (const model of requiredModels) {
      const spec = table && resolveModel(table, model);
      if (!spec) throw new Error(`pricing is unknown for selected model ${model}`);
      if (/^claude-/.test(model) && !spec.usd_per_1m.input_cache_write)
        throw new Error(`cache write pricing is unknown for selected model ${model}; update the trusted pricing table before starting`);
    }
    return {
      pricingId:
        tables
          .map((entry) => entry.identifier)
          .filter(Boolean)
          .join('+') || undefined,
      pricingFetchedAt: supplied
        .map((entry) => entry.table.fetched_at)
        .filter(Boolean)
        .sort()
        .at(-1),
      ...(table ? { pricingSnapshot: table } : {}),
    };
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
      assertVerifierCommand(input.testCommand);
      // Health remains visible through offload_job, but stale runtime/skill
      // state is a hard boundary here: a client must not spend budget simply
      // because it skipped or overlooked the preflight response.
      const startHealth = skillHealth();
      assertStartRuntimeCurrent(startHealth, { requireCurrentSkill: config.enforceInstalledSkillPreflight === true });
      const state = await makeState(input?.repoPath);
      if (closing) throw new Error('offload core is shutting down');
      const loaded = config.loaded || loadConfig({ configPath: config.configPath, repoPath: state.repoPath });
      if (loaded.disabled) throw new Error('offload is disabled for this repository');
      if (input.mode !== 'report') assertVerifierCommand(input.testCommand ?? loaded.repoConfig.testCommand);
      if (input?.profile && !loaded.config.profiles[input.profile]) throw new Error(`unknown profile: ${input.profile}`);
      const profileName = input.profile || loaded.config.default;
      const profile = loaded.config.profiles[profileName];
      const providerConfig = loaded.config.providers[profile.provider];
      if (!['openai-chat', 'anthropic-messages'].includes(providerConfig?.type))
        throw new Error(`unsupported provider type: ${providerConfig?.type || 'missing'}`);
      // The whole chain is snapshotted: primary plus up to two fallbacks, each
      // taken only after the previous route's explicit credit exhaustion.
      const chain = [{ name: profile.provider, profile, providerConfig }];
      for (
        let next = profile.fallback, seen = new Set([profileName]);
        next && chain.length < 3 && !seen.has(next);
        next = chain.at(-1).profile.fallback
      ) {
        seen.add(next);
        const fallbackProfile = loaded.config.profiles[next];
        const fallbackProviderConfig = fallbackProfile && loaded.config.providers[fallbackProfile.provider];
        if (!['openai-chat', 'anthropic-messages'].includes(fallbackProviderConfig?.type))
          throw new Error(`unsupported fallback provider type: ${fallbackProviderConfig?.type || 'missing'}`);
        chain.push({ name: fallbackProfile.provider, profile: fallbackProfile, providerConfig: fallbackProviderConfig });
      }
      // Resolve before snapshotting or acquiring a lease so a missing key can
      // never leave an executable but unsigned durable job behind.
      const resolveStartCredential = (route, label) => {
        try {
          return state.integrity
            ? state.integrity.preflight(route.providerConfig.keyRef)
            : (config.resolveKey || resolveKeyRef)(route.providerConfig.keyRef);
        } catch {
          throw new Error(
            `${label} worker key is unavailable${label === 'primary' ? '' : ` for provider ${route.name}`}; ${keySaveHint(route.providerConfig.keyRef, route.name)}`,
          );
        }
      };
      const primaryNeedsDiscovery = [
        OFFLOAD_ANTHROPIC_LATEST_SONNET,
        OFFLOAD_ANTHROPIC_LATEST_OPUS,
        OFFLOAD_DEEPSEEK_LATEST_FLASH,
        OFFLOAD_OPENAI_LATEST_TERRA,
        OFFLOAD_OPENAI_LATEST_SOL,
      ].includes(profile.model);
      // A fallback can be selected only after the previous route reports the exact
      // credit-exhausted refusal, so verify every key before accepting a job.
      const keys = chain.map((route, index) =>
        index === 0 && !state.integrity && !primaryNeedsDiscovery
          ? undefined
          : resolveStartCredential(route, index === 0 ? 'primary' : 'fallback'),
      );
      for (const credential of keys) {
        if (!credential) continue;
        // Preserve the resolved value only in the in-memory redaction set.
        // A caller can otherwise put a non-heuristic literal credential in
        // initial task/criteria/test-command text before the worker runs.
        state.store.secrets ||= [];
        if (!state.store.secrets.includes(credential)) state.store.secrets.push(credential);
      }
      const models = [];
      for (const [index, route] of chain.entries()) {
        try {
          models.push(await resolveProfileModel(route.profile, route.providerConfig, keys[index], { fetchImpl: config.fetchImpl }));
        } catch (error) {
          throw new Error(`${index === 0 ? 'primary' : 'fallback'} provider model discovery failed${safeDiscoveryStatusSuffix(error)}`);
        }
        assertModelAllowed({ type: route.providerConfig.type, baseUrl: route.providerConfig.baseUrl, model: models[index] });
      }
      const [model] = models;
      const snapshotRoute = (route, concrete) => ({
        type: route.providerConfig.type,
        baseUrl: route.providerConfig.baseUrl,
        keyRef: route.providerConfig.keyRef,
        model: concrete,
        effort: route.profile.effort,
        pricing: route.providerConfig.pricing,
        attemptTimeoutMs: route.providerConfig.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS,
        ...(route.providerConfig.pricingFile
          ? { pricingFile: resolveConfigRelativePath(route.providerConfig.pricingFile, loaded.configPath) }
          : {}),
      });
      const fallbackRoutes = chain.slice(1).map((route, index) => snapshotRoute(route, models[index + 1]));
      // `fallback` stays the first fallback for readers of older records.
      const executionProfile = {
        ...snapshotRoute(chain[0], model),
        ...(fallbackRoutes.length ? { fallback: fallbackRoutes[0], fallbacks: fallbackRoutes } : {}),
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
          // Server configuration only: a caller cannot loosen the thresholds.
          verifierDuration: reportMode ? undefined : verifierDurationConfig(loaded.config.verifier),
          sandboxMode: sandboxAvailable() ? 'macos' : 'policy-only',
          configuredModel: model,
          executionProfile,
          ...pricingMetadata(
            chain.map((route) => route.providerConfig),
            loaded,
            [...(primaryNeedsDiscovery ? [model] : []), ...models.slice(1)],
          ),
        },
        {
          launch,
          // This is a trusted fact about the accepted start boundary, not a
          // re-check of files on disk. A worker can legitimately edit this
          // checkout, which makes a still-running MCP process stale only
          // after the job has already begun.
          runtimePreflight: { server: 'current' },
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
        // This process's round ended without publishing (a store write that kept
        // failing): finish it rather than poll a record no one will advance.
        if (!state.manager.running.has(id)) await state.manager.settleOrphan(id);
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
      if (opts.verifierImports !== undefined) {
        if (id !== undefined) throw new Error('verifierImports applies only to the health call; omit jobId');
        if (opts.verifierInterpreter === undefined) throw new Error('verifierImports requires verifierInterpreter');
        normalizeVerifierImports(opts.verifierImports);
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
          ...(opts.verifierImports !== undefined ? { imports: opts.verifierImports } : {}),
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
     * The evidence digest and prompt skeleton for an Offload command run (see
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
      return state.manager.repair(id, defects, { launch: opts.launch !== false, assertionPaths: opts.assertionPaths });
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
              ...(opts.applyThenVerifyIn !== undefined ? { applyThenVerifyIn: opts.applyThenVerifyIn } : {}),
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
