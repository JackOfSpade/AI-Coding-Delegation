import { join, resolve, win32 } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { loadConfig, resolveConfigRelativePath } from './config.mjs';
import { resolveKeyRef } from './secrets.mjs';
import { macosProfile, sandboxStatus } from './sandbox.mjs';
import { healthIdentity } from './identity.mjs';
import { resolveClientPaths } from './client-paths.mjs';
import { DEFAULT_ATTEMPT_TIMEOUT_MS, OpenAIChatProvider } from './provider/openai-chat.mjs';
import { loadPricing } from './pricing-registry.mjs';
import { priceUsage, resolveModel, samePricedModel, validatePricingTable } from './pricing.mjs';
import { snapshotGitEnv } from './git-snapshot.mjs';
import { readRegularFileSync } from './regular-file.mjs';
import { skillCopyStatus, skillFileHash } from './skill-health.mjs';

const MAX_PRICING_BYTES = 1024 * 1024;
const read = (file) => {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(readRegularFileSync(file, MAX_PRICING_BYTES));
  } catch {
    return '';
  }
};
const parsed = (file) => {
  try {
    return JSON.parse(read(file));
  } catch {
    return undefined;
  }
};
const boundedRead = (file) => {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(readRegularFileSync(file, MAX_PRICING_BYTES));
  } catch {
    throw new Error('file exceeds live probe limit');
  }
};
const gitProbe = (args, { env = process.env, platform = process.platform, spawnProcess = spawnSync } = {}) => {
  const inertHooks = platform === 'win32' ? 'NUL' : '/dev/null';
  // Doctor needs only local plumbing. Do not give a repository config a
  // chance to invoke hooks/fsmonitor with provider credentials in scope.
  return spawnProcess('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${inertHooks}`, ...args], {
    encoding: 'utf8',
    timeout: 2_000,
    maxBuffer: 64 * 1024,
    windowsHide: true,
    env: snapshotGitEnv(env),
  });
};
const plainRecord = (value) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const exactArgs = (value, bin) => Array.isArray(value) && value.length === 2 && value[0] === bin && value[1] === 'mcp';

// This is deliberately a narrow TOML reader, not a general TOML parser.  It
// recognizes only the installer-owned table and its five canonical fields.
// That lets doctor fail closed on duplicates, malformed values, or lookalike
// text elsewhere in config.toml without importing install.mjs (which imports
// doctor for its CLI hook).
function tomlWithoutComment(value) {
  let escaped = false,
    quoted = false;
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (quoted && escaped) {
      escaped = false;
      continue;
    }
    if (quoted && char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') quoted = !quoted;
    else if (!quoted && char === '#') return value.slice(0, index).trim();
  }
  return quoted || escaped ? undefined : value.trim();
}
function tomlString(value) {
  if (!value.startsWith('"')) return undefined;
  let escaped = false;
  for (let index = 1; index < value.length; index++) {
    const char = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      if (value.slice(index + 1).trim()) return undefined;
      try {
        const parsedValue = JSON.parse(value.slice(0, index + 1));
        return typeof parsedValue === 'string' ? parsedValue : undefined;
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}
function tomlArgs(value) {
  if (!value.startsWith('[') || !value.endsWith(']')) return undefined;
  const items = [];
  let index = 1;
  while (true) {
    while (/\s/.test(value[index] || '')) index++;
    if (value[index] === ']') return index === value.length - 1 ? items : undefined;
    if (value[index] !== '"') return undefined;
    let escaped = false,
      end = index + 1;
    for (; end < value.length; end++) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (value[end] === '\\') {
        escaped = true;
        continue;
      }
      if (value[end] === '"') break;
    }
    if (end === value.length) return undefined;
    let item;
    try {
      item = JSON.parse(value.slice(index, end + 1));
    } catch {
      return undefined;
    }
    if (typeof item !== 'string') return undefined;
    items.push(item);
    index = end + 1;
    while (/\s/.test(value[index] || '')) index++;
    if (value[index] === ',') {
      index++;
      continue;
    }
    if (value[index] === ']') return index === value.length - 1 ? items : undefined;
    return undefined;
  }
}
function codexTables(toml) {
  const lines = toml.split(/\n/).map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
  const header = /^[ \t]*\[[ \t]*mcp_servers[ \t]*\.[ \t]*offload[ \t]*\][ \t]*(?:#.*)?$/;
  const anyHeader = /^[ \t]*\[/;
  const marker = /^[ \t]*# offload managed MCP[ \t]*$/;
  const tables = [];
  for (let index = 0; index < lines.length; index++)
    if (header.test(lines[index])) {
      let end = index + 1;
      while (end < lines.length && !anyHeader.test(lines[end])) end++;
      tables.push({ lines: lines.slice(index + 1, end), managed: index > 0 && marker.test(lines[index - 1]) });
    }
  return tables;
}
function codexRegistration(toml, bin) {
  const tables = codexTables(toml);
  if (tables.length !== 1 || !tables[0].managed) return false;
  const values = {};
  for (const source of tables[0].lines) {
    const line = tomlWithoutComment(source);
    if (line === undefined || !line) {
      if (line === undefined) return false;
      continue;
    }
    const match = /^([A-Za-z0-9_-]+)[ \t]*=[ \t]*(.*)$/.exec(line);
    if (
      !match ||
      !['command', 'args', 'startup_timeout_sec', 'tool_timeout_sec', 'default_tools_approval_mode'].includes(match[1]) ||
      Object.hasOwn(values, match[1])
    )
      return false;
    const [, key, raw] = match;
    if (key === 'command' || key === 'default_tools_approval_mode') values[key] = tomlString(raw);
    else if (key === 'args') values.args = tomlArgs(raw);
    else if (/^(?:0|[1-9][0-9]*)$/.test(raw)) values[key] = Number(raw);
    else return false;
    if (values[key] === undefined) return false;
  }
  // The installer supports its conservative write-prompt default and an
  // explicit Offload-only autonomous approval mode. Both are managed,
  // supported registrations; any other value is an altered entry.
  return (
    values.command === process.execPath &&
    exactArgs(values.args, bin) &&
    values.startup_timeout_sec === 15 &&
    values.tool_timeout_sec === 60 &&
    ['writes', 'approve'].includes(values.default_tools_approval_mode)
  );
}
function registrations(home, root, platform, env) {
  const bin = (platform === 'win32' ? win32 : { join }).join(root, 'bin', 'offload.mjs');
  const claudeRegistration = (file) => {
    const entry = parsed(file)?.mcpServers?.offload;
    const expectedEnvironment =
      plainRecord(entry?.env) &&
      (Object.keys(entry.env).length === 0 || (Object.keys(entry.env).length === 1 && entry.env.OFFLOAD_MCP_APPROVAL_MODE === 'approve'));
    return (
      plainRecord(entry) &&
      entry.type === 'stdio' &&
      entry.command === process.execPath &&
      exactArgs(entry.args, bin) &&
      expectedEnvironment
    );
  };
  const cursorRegistration = (file) => {
    const entry = parsed(file)?.mcpServers?.offload;
    return plainRecord(entry) && entry.command === process.execPath && exactArgs(entry.args, bin);
  };
  const paths = resolveClientPaths({ home, env, platform });
  return {
    codex: codexRegistration(read(paths.codexConfig), bin),
    claude: claudeRegistration(paths.claudeState),
    cursor: cursorRegistration(paths.cursorConfig),
  };
}

// The installed skill is a copy of the packaged one. A copy that differs means
// the agent follows protocol rules the running server no longer implements (or
// the reverse), so report it instead of letting the preflight fail obscurely.
// A missing copy is normal (client not installed, or a plugin supplies it).
// Health (offload_job) reaches the same verdict for the same file through
// skillCopyStatus, so the hook banner and `server.skill` cannot disagree.
function skillStatus(paths, root, path) {
  const packaged = skillFileHash(path.join(root, 'plugins', 'offload', 'skills', 'offload', 'SKILL.md'));
  const status = (file) => {
    const { status: state } = skillCopyStatus(file, packaged.hash);
    return state === 'unreadable' ? 'missing' : state;
  };
  return { claude: status(paths.claudeSkill), codex: status(paths.codexSkill) };
}
// Session hooks from another Offload install root print a second, possibly
// older runtime banner at every start. Installer ownership rules mean it will
// not remove them, so surface them here.
function otherDoctorHooks(paths, root, path) {
  const own = path.join(root, 'install.mjs');
  const found = new Set();
  const entries = parsed(paths.claudeSettings)?.hooks?.SessionStart;
  if (!Array.isArray(entries)) return [];
  for (const entry of entries)
    for (const hook of Array.isArray(entry?.hooks) ? entry.hooks : []) {
      const matched = typeof hook?.command === 'string' && /(['"])([^'"\r\n]*install\.mjs)\1 --doctor-hook$/.exec(hook.command);
      if (matched && matched[2] !== own) found.add(matched[2]);
    }
  return [...found];
}

/** Local-only diagnostic. It never makes an HTTP request or prints a key. */
export function doctor({
  root,
  home,
  configPath,
  repoPath,
  platform = process.platform,
  env = process.env,
  spawnProcess = spawnSync,
  sandboxSpawnProcess,
} = {}) {
  // HOME is commonly present in Windows shells (Git Bash, CI) but client
  // registrations belong under the native user profile, as does the installer.
  const clientPaths = resolveClientPaths({ home, env, platform });
  home = clientPaths.home;
  const path = platform === 'win32' ? win32 : { resolve, join };
  const node = process.versions.node.split('.').map(Number);
  const git = gitProbe(['--version'], { env, platform, spawnProcess });
  const rootPath = path.resolve(root || process.cwd());
  const repoCandidate = path.resolve(repoPath || process.cwd());
  const repoProbe =
    git.status === 0 ? gitProbe(['-C', repoCandidate, 'rev-parse', '--show-toplevel'], { env, platform, spawnProcess }) : { status: 1 };
  let config = { ok: false },
    key = { ok: false };
  try {
    const loaded = loadConfig({ configPath, repoPath, env });
    const profile = loaded.config.profiles[loaded.config.default];
    config = { ok: true, path: loaded.configPath, profile: loaded.config.default, disabled: loaded.disabled };
    try {
      resolveKeyRef(loaded.config.providers[profile.provider].keyRef, { env, platform });
      key = { ok: true };
    } catch (error) {
      key = { ok: false, error: error.code || 'unavailable' };
    }
  } catch (error) {
    config = { ok: false, error: error.code || String(error.message || error) };
  }
  const sandboxStatusResult = sandboxStatus(
    platform,
    platform === 'darwin' ? macosProfile({ repoPath: rootPath, tempPath: tmpdir() }) : undefined,
    sandboxSpawnProcess ? { spawnProcess: sandboxSpawnProcess } : undefined,
  );
  const sandbox = sandboxStatusResult.available ? 'macos' : 'policy-only';
  // `sandboxAvailable` performs a bounded execution with the exact generated
  // profile, which establishes that macOS can apply that profile. It does not
  // prove every future filesystem allow/deny rule, so do not advertise it as
  // a complete sandbox self-test.
  return {
    server: healthIdentity(),
    node: process.versions.node,
    nodeOk: node[0] >= 20,
    git: git.status === 0,
    root: rootPath,
    repo: { ok: repoProbe.status === 0, path: repoProbe.status === 0 ? repoProbe.stdout.trim() : repoCandidate },
    sandbox,
    sandboxProbe: sandbox === 'macos' ? 'profile-applied' : 'not-available',
    sandboxReason: sandboxStatusResult.reason,
    sandboxProbeCommand: sandboxStatusResult.probe,
    ...(sandboxStatusResult.error ? { sandboxProbeError: sandboxStatusResult.error } : {}),
    ...(sandboxStatusResult.exitCode != null ? { sandboxProbeExitCode: sandboxStatusResult.exitCode } : {}),
    ...(sandboxStatusResult.signal ? { sandboxProbeSignal: sandboxStatusResult.signal } : {}),
    config,
    key,
    registration: registrations(home, rootPath, platform, env),
    skill: skillStatus(clientPaths, rootPath, path),
    otherDoctorHooks: otherDoctorHooks(clientPaths, rootPath, path),
  };
}

const MAX_LIVE_USD = 0.02;
const LIVE_MAX_TOKENS = 32;
const LIVE_FRAMING_TOKENS = 1024;
const LIVE_TOOL = [
  {
    type: 'function',
    function: {
      name: 'offload_doctor_echo',
      description: 'Return a fixed health acknowledgement.',
      parameters: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
    },
  },
];
const safeRemoteMetadata = (value) => typeof value === 'string' && value.length > 0 && value.length <= 256 && /^[\x20-\x7e]+$/.test(value);

function pricingForLive(provider, configPath) {
  let table = loadPricing(provider.pricing);
  if (!table && provider.pricingFile) {
    try {
      table = JSON.parse(boundedRead(resolveConfigRelativePath(provider.pricingFile, configPath)));
    } catch {
      throw new Error('live probe pricing file is unavailable');
    }
  }
  try {
    validatePricingTable(table);
  } catch {
    throw new Error('live probe requires a validated pricing table');
  }
  return table;
}
function worstReservation(table, model, messages, options = {}) {
  const spec = resolveModel(table, model);
  if (!spec) throw new Error('live probe refuses unknown priced model');
  // The serialized request is a deliberately pessimistic token estimate: every
  // UTF-8 byte plus framing is counted as one input token, then the maximum
  // possible output is reserved at the highest dated tier.
  const wireBytes = Buffer.byteLength(
    JSON.stringify({
      ...options,
      model,
      messages,
      tools: LIVE_TOOL,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: LIVE_MAX_TOKENS,
      thinking: { type: 'disabled' },
    }),
    'utf8',
  );
  const inputTokens = wireBytes + LIVE_FRAMING_TOKENS;
  const inputRate = Math.max(spec.usd_per_1m.input_cache_miss.off_peak, spec.usd_per_1m.input_cache_miss.peak);
  const outputRate = Math.max(spec.usd_per_1m.output.off_peak, spec.usd_per_1m.output.peak);
  return { inputTokens, outputTokens: LIVE_MAX_TOKENS, usd: (inputTokens * inputRate + LIVE_MAX_TOKENS * outputRate) / 1_000_000 };
}
async function chatProbe(provider, messages, options = {}) {
  const response = { model: undefined, usage: undefined, toolCalls: undefined, reasoning: undefined, acknowledged: false };
  let usageRecords = 0;
  for await (const event of provider.chat({ messages, tools: LIVE_TOOL, max_tokens: LIVE_MAX_TOKENS, ...options })) {
    if (event.modelConflict) throw new Error('live probe returned conflicting model metadata');
    if (event.model) {
      if (!safeRemoteMetadata(event.model)) throw new Error('live probe returned invalid model metadata');
      if (response.model && response.model !== event.model) throw new Error('live probe returned conflicting model metadata');
      response.model ||= event.model;
    }
    // `null`, an empty string, and an absent reasoning field have distinct
    // DeepSeek transcript meanings. Streaming providers can use null as an
    // incremental placeholder around string fragments; a string wins and is
    // concatenated exactly for the tool-result replay.
    if (Object.hasOwn(event, 'reasoning')) {
      if (event.reasoning === null) {
        if (response.reasoning === undefined) response.reasoning = null;
      } else if (typeof event.reasoning === 'string') {
        response.reasoning = `${typeof response.reasoning === 'string' ? response.reasoning : ''}${event.reasoning}`;
      } else throw new Error('live probe received invalid reasoning');
    }
    if (event.text) response.acknowledged = true;
    if (event.toolCalls) response.toolCalls = event.toolCalls;
    if (event.usage) {
      usageRecords++;
      response.usage = event.usage;
    }
  }
  if (usageRecords !== 1 || !response.usage) throw new Error('live probe expected exactly one usage record');
  return response;
}

/**
 * Explicit, tiny provider capability check. It has no repository input, makes
 * exactly two no-retry requests, and reserves worst-tier cost before each one.
 * `probe` remains an injection seam for callers that only need budget plumbing.
 */
export async function doctorLive({ probe, maxUsd, configPath, repoPath, env = process.env, fetchImpl, now = () => new Date() } = {}) {
  if (!Number.isFinite(maxUsd) || maxUsd <= 0 || maxUsd > MAX_LIVE_USD)
    throw new Error('live probe requires maxUsd greater than 0 and at most 0.02');
  if (typeof probe === 'function') return { live: true, maxUsd, result: await probe({ maxUsd }) };
  const loaded = loadConfig({ configPath, repoPath, env });
  const profile = loaded.config.profiles[loaded.config.default];
  const providerConfig = loaded.config.providers[profile.provider];
  if (providerConfig.type !== 'openai-chat') throw new Error('live probe supports only openai-chat providers');
  const table = pricingForLive(providerConfig, loaded.configPath);
  if (!resolveModel(table, profile.model)) throw new Error('live probe refuses unknown priced model');
  let apiKey;
  try {
    apiKey = resolveKeyRef(providerConfig.keyRef, { env });
  } catch {
    throw new Error('live probe key is unavailable');
  }
  // The probe forces one exact function call. DeepSeek enables thinking by
  // default and rejects named tool choice in that mode, so explicitly disable
  // it for both capability-check turns regardless of the job profile's effort.
  const provider = new OpenAIChatProvider({
    baseUrl: providerConfig.baseUrl,
    apiKey,
    model: profile.model,
    retries: 0,
    thinking: { type: 'disabled' },
    timeoutMs: providerConfig.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  const firstMessages = [{ role: 'user', content: 'Use offload_doctor_echo once with {"ok":true}.' }];
  let measuredUsd = 0,
    reservedUsd = 0;
  const request = async (messages, options) => {
    const reservation = worstReservation(table, profile.model, messages, options);
    if (measuredUsd + reservation.usd > maxUsd) throw new Error('live probe cap is insufficient for the next reserved request');
    reservedUsd += reservation.usd;
    const response = await chatProbe(provider, messages, options);
    const chargedModel = response.model || profile.model;
    if (response.model && !samePricedModel(table, profile.model, response.model))
      throw new Error('live probe returned a model not authorized by its reservation');
    const priced = priceUsage(table, chargedModel, response.usage, now());
    measuredUsd += priced.usd;
    if (measuredUsd > maxUsd || priced.usd > reservation.usd) throw new Error('live probe observed usage beyond its reserved cap');
    return { response, priced };
  };
  const first = await request(firstMessages, { tool_choice: { type: 'function', function: { name: 'offload_doctor_echo' } } });
  if (first.response.toolCalls?.length !== 1) throw new Error('live probe first response must contain exactly one tool call');
  const call = first.response.toolCalls[0];
  let callArguments;
  try {
    callArguments = JSON.parse(call.arguments);
  } catch {
    throw new Error('live probe first tool arguments are invalid');
  }
  if (
    !call?.id ||
    call.name !== 'offload_doctor_echo' ||
    !callArguments ||
    callArguments.ok !== true ||
    Object.keys(callArguments).some((key) => key !== 'ok')
  )
    throw new Error('live probe first tool call is invalid');
  const assistant = {
    role: 'assistant',
    content: '',
    tool_calls: [{ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } }],
  };
  if (first.response.reasoning !== undefined) assistant.reasoning_content = first.response.reasoning;
  const secondMessages = [
    ...firstMessages,
    assistant,
    { role: 'tool', tool_call_id: call.id, content: '{"ok":true}' },
    { role: 'user', content: 'Acknowledge the tool result in one short sentence; do not call a tool.' },
  ];
  const second = await request(secondMessages);
  if (second.response.toolCalls?.length || !second.response.acknowledged)
    throw new Error('live probe follow-up did not acknowledge the tool result');
  const summarize = ({ response, priced }) => ({
    usage: response.usage,
    cache: { hit: response.usage.cacheHitTokens, miss: response.usage.cacheMissTokens },
    returnedModel: response.model || profile.model,
    estimatedUsd: priced.usd,
    toolCall: !!response.toolCalls?.length,
    reasoningReturned: response.reasoning !== undefined,
  });
  return {
    live: true,
    maxUsd,
    requestedModel: profile.model,
    first: summarize(first),
    followup: summarize(second),
    reasoningReplayed: first.response.reasoning !== undefined,
    measuredUsd,
    reservedUsd,
  };
}
