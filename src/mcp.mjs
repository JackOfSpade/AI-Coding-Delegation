/** Newline-delimited JSON-RPC 2.0 MCP stdio adapter; supports legacy and modern discovery. */
import { createHash } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { redactText } from './redact.mjs';
import { readRegularFile } from './regular-file.mjs';
const SKILL_NAME = 'offload';
const SKILL_URI = 'skill://offload/offload/SKILL.md';
const SKILL_ROOT = fileURLToPath(new URL('../plugins/offload/skills/offload/', import.meta.url));
// These keep the static catalog within OpenAI's import caps as well as SEP-2640's
// broader 512-resource/16 MiB interoperability limits.
const MAX_SKILL_FILES = 100,
  MAX_SKILL_FILE_BYTES = 1_048_576,
  MAX_SKILL_MD_BYTES = 262_144,
  MAX_SKILL_TOTAL_BYTES = 5_242_880;
const SERVER_INSTRUCTIONS =
  'Offload skill: read skill://offload/offload/SKILL.md for bounded implementation, test, or debugging delegation. Start a job, wait for its verified result, then review its diff. Supply an absolute repoPath when ambiguous. Do not edit paths owned by a running job.';
const SKILLS_EXTENSION = { 'io.modelcontextprotocol/skills': {} };
const startProps = {
  task: { type: 'string', minLength: 1, maxLength: 32_000 },
  acceptanceCriteria: { type: 'array', maxItems: 100, items: { type: 'string', minLength: 1, maxLength: 4_000 } },
  ownedPaths: {
    type: 'array',
    minItems: 1,
    maxItems: 128,
    items: { type: 'string', minLength: 1, maxLength: 1_024 },
    description: 'Required relative paths or globs this job exclusively owns while it runs; do not edit them concurrently.',
  },
  relevantPaths: { type: 'array', maxItems: 128, items: { type: 'string', minLength: 1, maxLength: 1_024 } },
  testCommand: {
    type: 'string',
    minLength: 1,
    maxLength: 8_192,
    description:
      'Verifier command run by the server. It requires an actual macOS sandbox unless unsafePolicyOnlyVerifier is explicitly true.',
  },
  unsafePolicyOnlyVerifier: {
    type: 'boolean',
    description:
      'High-friction consent for this caller-supplied testCommand to run policy-only when no macOS sandbox can be applied. A policy-only result can never trigger repair.',
  },
  profile: { type: 'string', minLength: 1, maxLength: 128 },
  effort: { enum: ['normal', 'high'] },
  maxRepairRounds: { type: 'integer', minimum: 0, maximum: 4 },
  budget: {
    type: 'object',
    description: 'Hard cumulative provider-spend and execution limits for this job.',
    properties: {
      maxUsd: { type: 'number', minimum: 0, maximum: 10_000 },
      maxTurns: { type: 'integer', minimum: 1, maximum: 1_000 },
      timeoutMinutes: { type: 'number', minimum: 1, maximum: 1_440 },
    },
    additionalProperties: false,
  },
  allowNetwork: { type: 'boolean', description: 'Allow worker network access only when the task genuinely requires it.' },
  extraWritable: { type: 'array', maxItems: 128, items: { type: 'string', minLength: 1, maxLength: 1_024 } },
  repoPath: {
    type: 'string',
    minLength: 1,
    maxLength: 4096,
    description: 'Absolute repository root; provide it when the client workspace is ambiguous.',
  },
};
const repoHint = {
  repoPath: {
    type: 'string',
    minLength: 1,
    maxLength: 4096,
    description: 'Optional absolute repository root; use it after a server restart or when the client cwd is ambiguous.',
  },
};
// Must mirror the persisted/lease job identifier boundary.  Keeping this in
// the advertised schema makes malformed IDs fail before core state routing.
const jobId = { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$' };
const toolAnnotations = {
  offload_start: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  offload_wait: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  offload_job: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  offload_repair: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  offload_revert: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  // Cancelling preserves artifacts and is safe to repeat, but still changes job state.
  offload_cancel: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};
// Claude Code understands this documented vendor metadata and asks a human on
// every state-changing call even if the session normally auto-approves MCP
// tools. Other hosts ignore unknown tool metadata and still receive the
// portable annotations above. Reading job state remains approval-free.
const requiresUserInteraction = new Set(['offload_start', 'offload_repair', 'offload_revert', 'offload_cancel']);
const TOOLS = [
  [
    'offload_start',
    'Start a bounded worker implementation, test, or debugging job; it may edit files and spend provider budget.',
    startProps,
    ['task', 'ownedPaths'],
  ],
  [
    'offload_wait',
    'Read local progress or the verified report for a delegated job.',
    { jobId, timeoutSec: { type: 'number', minimum: 0, maximum: 55 }, ...repoHint },
    ['jobId'],
  ],
  [
    'offload_job',
    'Read local job status, report, diff, files, or event log for review.',
    { jobId, include: { enum: ['summary', 'diff', 'files', 'log'] }, ...repoHint },
    [],
  ],
  [
    'offload_repair',
    'Start another bounded worker pass for precise defects; it may edit files and spend provider budget.',
    {
      jobId,
      defects: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'string', minLength: 1, maxLength: 4_000 } },
      ...repoHint,
    },
    ['jobId', 'defects'],
  ],
  [
    'offload_revert',
    'Dry-run or apply a reverse patch after review; apply=true changes the working tree.',
    { jobId, apply: { type: 'boolean' }, ...repoHint },
    ['jobId'],
  ],
  [
    'offload_cancel',
    'Write an idempotent durable cancellation request; a separately owned worker may finish stopping and cleanup asynchronously while partial changes and reports are preserved.',
    { jobId, ...repoHint },
    ['jobId'],
  ],
].map(([name, description, properties, required]) => ({
  name,
  description,
  inputSchema: { type: 'object', properties, required, additionalProperties: false },
  annotations: toolAnnotations[name],
  ...(requiresUserInteraction.has(name) ? { _meta: { 'anthropic/requiresUserInteraction': true } } : {}),
}));
const TOOL_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));
const protocol = '2025-06-18';
const modernProtocol = '2026-07-28';
const serverInfo = { name: 'offload', version: '0.1.0' };
function skillFailure(message) {
  const error = new Error(`offload skill artifact unavailable: ${message}`);
  error.code = 'E_SKILL_ARTIFACT';
  return error;
}
export function parseSkillFrontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw skillFailure('SKILL.md must begin with JSON-compatible YAML frontmatter');
  let frontmatter;
  try {
    frontmatter = JSON.parse(match[1]);
  } catch {
    throw skillFailure('SKILL.md frontmatter must be a JSON object');
  }
  if (frontmatter === null || Array.isArray(frontmatter) || Object.getPrototypeOf(frontmatter) !== Object.prototype)
    throw skillFailure('SKILL.md frontmatter must be a JSON object');
  if (frontmatter.name !== SKILL_NAME || typeof frontmatter.description !== 'string' || !frontmatter.description)
    throw skillFailure('SKILL.md must define the canonical name and description');
  return frontmatter;
}
async function assertSkillDirectories(directories) {
  try {
    for (const directory of directories || []) {
      const current = await lstat(directory.path, { bigint: true });
      if (!current.isDirectory() || current.isSymbolicLink() || !sameDirectory(directory.identity, current)) throw new Error('changed');
    }
  } catch {
    throw skillFailure('skill directory changed while reading');
  }
}
export async function readSkillRegularUtf8(path, maximum, label, directories) {
  await assertSkillDirectories(directories);
  let bytes;
  try {
    bytes = await readRegularFile(path, maximum);
  } catch {
    throw skillFailure(`${label} is missing or unreadable`);
  }
  await assertSkillDirectories(directories);
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw skillFailure(`${label} must be UTF-8 text`);
  }
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw skillFailure(`${label} must be canonical UTF-8 text`);
  return { text, rawBytes: bytes, size: bytes.length };
}
const sameDirectory = (before, after) =>
  before.dev === after.dev && before.ino === after.ino && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs;
async function readSkillDirectory(path, label) {
  let before, entries, after;
  try {
    before = await lstat(path, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink()) throw new Error('not a directory');
    entries = await readdir(path, { withFileTypes: true });
    after = await lstat(path, { bigint: true });
  } catch {
    throw skillFailure(`${label} is unreadable`);
  }
  if (!after.isDirectory() || after.isSymbolicLink() || !sameDirectory(before, after)) throw skillFailure(`${label} changed while reading`);
  return { entries, identity: after };
}
async function loadSkillCatalog() {
  const files = [];
  const walk = async (directory, parts = [], ancestors = []) => {
    const listed = await readSkillDirectory(directory, 'skill directory');
    const directories = [...ancestors, { path: directory, identity: listed.identity }];
    const entries = listed.entries;
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.name || entry.name === '.' || entry.name === '..') throw skillFailure('skill resource path is unsafe');
      const next = [...parts, entry.name],
        relative = next.join('/'),
        path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path, next, directories);
      else if (entry.isFile()) files.push({ path, relative, directories });
      else throw skillFailure(`skill resource ${relative} must be a regular file`);
    }
  };
  await walk(SKILL_ROOT);
  if (!files.length || files.length > MAX_SKILL_FILES) throw skillFailure('skill resource count is invalid');
  const canonical = files.find((file) => file.relative === 'SKILL.md');
  if (!canonical) throw skillFailure('SKILL.md is missing');
  const loaded = [];
  let total = 0;
  for (const file of files) {
    const content = await readSkillRegularUtf8(
      file.path,
      file === canonical ? MAX_SKILL_MD_BYTES : MAX_SKILL_FILE_BYTES,
      file.relative,
      file.directories,
    );
    total += content.size;
    if (total > MAX_SKILL_TOTAL_BYTES) throw skillFailure('skill resources exceed their total size limit');
    const uri = file === canonical ? SKILL_URI : `skill://offload/offload/${file.relative.split('/').map(encodeURIComponent).join('/')}`;
    loaded.push({
      ...file,
      uri,
      text: content.text,
      size: content.size,
      digest: `sha256:${createHash('sha256').update(content.rawBytes).digest('hex')}`,
    });
  }
  const canonicalResource = loaded.find((file) => file.uri === SKILL_URI);
  const entry = {
    uri: SKILL_URI,
    frontmatter: parseSkillFrontmatter(canonicalResource.text),
    resources: loaded.map((file) => ({ uri: file.uri, digest: file.digest, size: file.size })),
  };
  return { entry, resources: new Map(loaded.map((file) => [file.uri, file])) };
}
export function createMcpServer(
  core,
  { input = process.stdin, output = process.stdout, maxFrameBytes = 1_000_000, maxPendingRequests = 64 } = {},
) {
  if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1024 || maxFrameBytes > 16_000_000)
    throw new TypeError('maxFrameBytes must be an integer between 1024 and 16000000');
  if (!Number.isSafeInteger(maxPendingRequests) || maxPendingRequests < 1 || maxPendingRequests > 1_024)
    throw new TypeError('maxPendingRequests must be an integer between 1 and 1024');
  const cancelled = new Set(),
    pending = new Map(),
    settlements = new Set();
  let stopped = false,
    outputBroken = false,
    outputPaused = false,
    queuedOutputBytes = 0,
    transportDetached = false;
  const queuedOutput = [];
  // A client that stops reading stdout must not let completed asynchronous
  // requests accumulate an unbounded in-memory response queue.
  const maxQueuedOutputBytes = Math.min(8 * 1024 * 1024, Math.max(1_000_000, maxFrameBytes * 2));
  // Keep ownership of stdio with the process, but a caller-supplied blocked
  // stream is part of this server's transport and must not retain a failed
  // server forever. Listener detachment is idempotent because close(), EOF,
  // output errors, and queue overflow can all race.
  const detachTransport = ({ destroy = false } = {}) => {
    if (transportDetached) return;
    transportDetached = true;
    input.pause?.();
    input.removeListener?.('data', onData);
    input.removeListener?.('end', onEnd);
    input.removeListener?.('error', onEnd);
    input.removeListener?.('close', onEnd);
    output.removeListener?.('drain', flushOutput);
    output.removeListener?.('error', onOutputError);
    if (destroy) {
      // Do not destroy process stdio: pausing stdin and removing listeners is
      // sufficient for a standalone process to exit, while destroying its
      // stdout can itself cause an unhandled EPIPE during teardown.
      if (input !== process.stdin)
        try {
          input.destroy?.();
        } catch {}
      if (output !== process.stdout && output !== process.stderr)
        try {
          output.destroy?.();
        } catch {}
    }
  };
  const failOutput = () => {
    if (outputBroken) return;
    outputBroken = true;
    outputPaused = false;
    queuedOutput.length = 0;
    queuedOutputBytes = 0;
    detachTransport({ destroy: true });
    void shutdown();
  };
  const writeOutput = (text) => {
    try {
      if (output.destroyed) {
        failOutput();
        return;
      }
      if (output.write(text) === false) {
        outputPaused = true;
        input.pause?.();
      }
    } catch {
      failOutput();
    }
  };
  const flushOutput = () => {
    if (outputBroken || stopped) return;
    outputPaused = false;
    while (queuedOutput.length && !outputPaused) {
      const next = queuedOutput.shift();
      queuedOutputBytes -= Buffer.byteLength(next);
      writeOutput(next);
    }
    if (!outputPaused) input.resume?.();
  };
  const send = (value) => {
    if (stopped || outputBroken) return;
    let text;
    try {
      text = `${JSON.stringify(value)}\n`;
    } catch {
      failOutput();
      return;
    }
    const bytes = Buffer.byteLength(text);
    // The direct-write path is still an output-stream queue. A single frame
    // must not bypass our cap just because no earlier write has backpressured.
    if (bytes > maxQueuedOutputBytes) {
      failOutput();
      return;
    }
    if (outputPaused) {
      if (queuedOutputBytes + bytes > maxQueuedOutputBytes) {
        failOutput();
        return;
      }
      queuedOutput.push(text);
      queuedOutputBytes += bytes;
      return;
    }
    writeOutput(text);
  };
  const response = (id, result) => {
    if (id !== undefined) send({ jsonrpc: '2.0', id, result });
  };
  const error = (id, code, message, data) => {
    if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } });
  };
  const onOutputError = () => failOutput();
  output.on?.('drain', flushOutput);
  output.on?.('error', onOutputError);
  const plainObject = (value) =>
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
  const safeText = (value) =>
    redactText(String(value))
      .replace(/\x1B\][\s\S]*?(?:\x07|\x1B\\)/g, '')
      .replace(/\x1B\[[0-?]*[ -\/]*[@-~]/g, '')
      .replace(/[\x00-\x1F\x7F]/g, '');
  let skillCatalog;
  const skills = () => (skillCatalog ||= loadSkillCatalog());
  const exactParams = (value, required, optional = []) =>
    plainObject(value) &&
    Object.keys(value).every((key) => [...required, ...optional].includes(key)) &&
    required.every((key) => Object.hasOwn(value, key)) &&
    (!Object.hasOwn(value, '_meta') || plainObject(value._meta));
  // 2026-07-28 is stateless: its protocol version and client capabilities
  // belong to every request, not to a connection-level handshake.  Retaining
  // a modern flag after `server/discover` would incorrectly accept later
  // metadata-free requests as modern (or emit a modern envelope to a legacy
  // request on the same stdio stream).  Legacy initialize remains available
  // for 2025-era clients only.
  const modernMeta = (request) => request.params?._meta;
  const modernVersion = (request) => modernMeta(request)?.['io.modelcontextprotocol/protocolVersion'];
  const hasModernMeta = (request) =>
    plainObject(modernMeta(request)) && Object.keys(modernMeta(request)).some((key) => key.startsWith('io.modelcontextprotocol/'));
  const isModern = (request) => modernVersion(request) === modernProtocol;
  const cacheable = (request) => (isModern(request) ? { ttlMs: 0, cacheScope: 'private' } : {});
  const currentMetaError = (request) => {
    const meta = modernMeta(request);
    if (!plainObject(meta) || typeof meta['io.modelcontextprotocol/protocolVersion'] !== 'string')
      return { code: -32602, message: 'modern MCP requests require _meta.io.modelcontextprotocol/protocolVersion' };
    const requested = meta['io.modelcontextprotocol/protocolVersion'];
    if (requested !== modernProtocol)
      return { code: -32022, message: 'UnsupportedProtocolVersionError', data: { supported: [modernProtocol], requested } };
    if (!plainObject(meta['io.modelcontextprotocol/clientCapabilities']))
      return { code: -32602, message: 'modern MCP requests require _meta.io.modelcontextprotocol/clientCapabilities' };
    return undefined;
  };
  const modernServerMeta = { _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo } };
  let legacyInitialized = false;
  const skillProtocolError = (id, cause) =>
    error(id, -32603, safeText(cause?.code === 'E_SKILL_ARTIFACT' ? cause.message : 'offload skill artifact unavailable'));
  const validateSchema = (value, schema, label = 'arguments') => {
    if (schema.enum && !schema.enum.includes(value)) throw new Error(`${label} must be one of the advertised values`);
    if (schema.type === 'object') {
      if (!plainObject(value)) throw new Error(`${label} must be an object`);
      const properties = schema.properties || {};
      if (schema.additionalProperties === false && Object.keys(value).some((key) => !Object.hasOwn(properties, key)))
        throw new Error(`${label} contains an unknown property`);
      for (const key of schema.required || []) if (!Object.hasOwn(value, key)) throw new Error(`${label}.${key} is required`);
      for (const [key, item] of Object.entries(value)) validateSchema(item, properties[key], `${label}.${key}`);
      return;
    }
    if (schema.type === 'array') {
      if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
      if (schema.minItems !== undefined && value.length < schema.minItems) throw new Error(`${label} has too few items`);
      if (schema.maxItems !== undefined && value.length > schema.maxItems) throw new Error(`${label} has too many items`);
      for (let index = 0; index < value.length; index++) validateSchema(value[index], schema.items || {}, `${label}[${index}]`);
      return;
    }
    if (schema.type === 'string' && typeof value !== 'string') throw new Error(`${label} must be a string`);
    if (schema.type === 'boolean' && typeof value !== 'boolean') throw new Error(`${label} must be a boolean`);
    if (schema.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value)))
      throw new Error(`${label} must be a finite number`);
    if (schema.type === 'integer' && !Number.isSafeInteger(value)) throw new Error(`${label} must be an integer`);
    if ((schema.type === 'number' || schema.type === 'integer') && schema.minimum !== undefined && value < schema.minimum)
      throw new Error(`${label} is below its minimum`);
    if ((schema.type === 'number' || schema.type === 'integer') && schema.maximum !== undefined && value > schema.maximum)
      throw new Error(`${label} exceeds its maximum`);
    if (schema.minLength !== undefined && value.length < schema.minLength) throw new Error(`${label} is too short`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) throw new Error(`${label} is too long`);
    if (schema.pattern !== undefined && (typeof schema.pattern !== 'string' || !new RegExp(schema.pattern).test(value)))
      throw new Error(`${label} has invalid format`);
  };
  const toolArguments = (name, args) => {
    const tool = TOOL_BY_NAME.get(name);
    if (!tool) throw new Error(`unknown tool: ${name}`);
    validateSchema(args, tool.inputSchema);
    return args;
  };
  const invoke = (name, args, signal) => {
    args = toolArguments(name, args);
    const handlers = {
      offload_start: () =>
        core.start({
          task: args.task,
          acceptanceCriteria: args.acceptanceCriteria,
          ownedPaths: args.ownedPaths,
          relevantPaths: args.relevantPaths,
          testCommand: args.testCommand,
          unsafePolicyOnlyVerifier: args.unsafePolicyOnlyVerifier,
          profile: args.profile,
          effort: args.effort,
          maxRepairRounds: args.maxRepairRounds,
          budget: args.budget,
          allowNetwork: args.allowNetwork,
          extraWritable: args.extraWritable,
          repoPath: args.repoPath,
        }),
      offload_wait: () => core.wait(args.jobId, { repoPath: args.repoPath, timeoutSec: args.timeoutSec, signal }),
      offload_job: () => core.job(args.jobId, { repoPath: args.repoPath, include: args.include }),
      offload_repair: () => core.repair(args.jobId, args.defects, { repoPath: args.repoPath }),
      // `apply` is optional and defaults to a dry run. Passing an explicit
      // undefined property defeats JobManager's destructuring default, so
      // normalize it at the protocol boundary.
      offload_revert: () => core.revert(args.jobId, { repoPath: args.repoPath, apply: args.apply ?? false }),
      offload_cancel: () => core.cancel(args.jobId, { repoPath: args.repoPath }),
    };
    return handlers[name]();
  };
  async function handle(request) {
    // A notification omits `id`; an explicit JSON-RPC null id is still a
    // request and therefore receives a null-id response. Invalid request
    // objects have no trustworthy id, so JSON-RPC requires an id:null error.
    if (!plainObject(request) || request.jsonrpc !== '2.0' || typeof request.method !== 'string')
      return send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } });
    if (
      request.id !== undefined &&
      request.id !== null &&
      !(typeof request.id === 'string' || (typeof request.id === 'number' && Number.isFinite(request.id)))
    )
      return send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request id' } });
    if (request.method === '$/cancelRequest' || request.method === 'notifications/cancelled') {
      const id = request.params?.requestId ?? request.params?.id;
      if (pending.has(id)) {
        cancelled.add(id);
        pending.get(id)?.abort?.();
      }
      return;
    }
    if (request.method === 'notifications/initialized' || request.method === 'notifications/progress') return;
    if (request.method === 'server/discover') {
      if (!exactParams(request.params, [], ['_meta'])) return error(request.id, -32602, 'invalid server/discover params');
      const modernError = currentMetaError(request);
      if (modernError) return error(request.id, modernError.code, modernError.message, modernError.data);
      if (request.id === undefined) return;
      return response(request.id, {
        resultType: 'complete',
        supportedVersions: [modernProtocol],
        capabilities: { tools: {}, resources: {}, extensions: SKILLS_EXTENSION },
        instructions: SERVER_INSTRUCTIONS,
        ttlMs: 0,
        cacheScope: 'private',
        ...modernServerMeta,
      });
    }
    // A request carrying current-era metadata is never allowed to fall through
    // to legacy semantics, even when the metadata is malformed or names an
    // unsupported revision.  The structured version error lets a client retry
    // with the version advertised by server/discover.
    if (hasModernMeta(request)) {
      const modernError = currentMetaError(request);
      if (modernError) return error(request.id, modernError.code, modernError.message, modernError.data);
    }
    if (isModern(request) && request.method === 'initialize') return error(request.id, -32601, 'method not found: initialize');
    if (request.method === 'initialize') {
      const rootPath = request.params?.rootPath;
      const rootUri = request.params?.rootUri;
      // URI roots are only trustworthy local file URIs.  In particular, do
      // not accidentally turn an https:// workspace hint into a local path.
      let rootHint = typeof rootPath === 'string' ? rootPath : undefined;
      if (!rootHint && typeof rootUri === 'string' && rootUri.startsWith('file:')) {
        try {
          rootHint = fileURLToPath(rootUri);
        } catch {
          /* ignore malformed URI */
        }
      }
      if (typeof rootHint === 'string' && core.setDefaultRepo) {
        try {
          core.setDefaultRepo(rootHint);
        } catch {
          /* an invalid client hint must not break discovery */
        }
      }
      legacyInitialized = true;
      if (request.id === undefined) return;
      return response(request.id, {
        protocolVersion: protocol,
        capabilities: { tools: {}, resources: {}, extensions: SKILLS_EXTENSION },
        instructions: SERVER_INSTRUCTIONS,
        serverInfo,
      });
    }
    // A bare request is necessarily legacy.  Legacy MCP requires the
    // initialize/initialized lifecycle; refusing it before initialization also
    // prevents a modern client that accidentally omits required metadata from
    // being processed under an unintended, weaker dialect.
    if (!isModern(request) && !legacyInitialized) return error(request.id, -32602, 'legacy MCP requests require initialize');
    if (request.method === 'ping')
      return request.id === undefined
        ? undefined
        : isModern(request)
          ? error(request.id, -32601, 'method not found: ping')
          : response(request.id, {});
    if (request.method === 'skills/list') {
      if (request.id === undefined) return;
      // `params` is optional for list methods.  Treat only its absence as an
      // empty object; null and non-object values remain invalid JSON-RPC
      // params, rather than being silently coerced into a valid request.
      const params = request.params === undefined ? {} : request.params;
      if (!exactParams(params, [], ['cursor', '_meta']) || Object.hasOwn(params, 'cursor'))
        return error(request.id, -32602, 'invalid skills/list params');
      try {
        return response(request.id, {
          resultType: 'complete',
          skills: [(await skills()).entry],
          ...cacheable(request),
          ...(isModern(request) ? modernServerMeta : {}),
        });
      } catch (cause) {
        return skillProtocolError(request.id, cause);
      }
    }
    if (request.method === 'resources/list') {
      if (request.id === undefined) return;
      const params = request.params === undefined ? {} : request.params;
      if (!exactParams(params, [], ['cursor', '_meta']) || Object.hasOwn(params, 'cursor'))
        return error(request.id, -32602, 'invalid resources/list params');
      try {
        const catalog = await skills();
        const resources = [...catalog.resources.values()].map((resource) => ({
          uri: resource.uri,
          name: resource.relative,
          mimeType: resource.uri.endsWith('.md') ? 'text/markdown' : 'text/plain',
        }));
        return response(request.id, {
          resultType: 'complete',
          resources,
          ...cacheable(request),
          ...(isModern(request) ? modernServerMeta : {}),
        });
      } catch (cause) {
        return skillProtocolError(request.id, cause);
      }
    }
    if (request.method === 'skills/get' || request.method === 'resources/read') {
      if (request.id === undefined) return;
      if (!exactParams(request.params, ['uri'], ['_meta']) || typeof request.params.uri !== 'string')
        return error(request.id, -32602, `invalid ${request.method} params`);
      let catalog;
      try {
        catalog = await skills();
      } catch (cause) {
        return skillProtocolError(request.id, cause);
      }
      if (request.method === 'skills/get') {
        if (request.params.uri !== SKILL_URI) return error(request.id, -32602, 'skill not found');
        return response(request.id, {
          resultType: 'complete',
          skill: catalog.entry,
          ...cacheable(request),
          ...(isModern(request) ? modernServerMeta : {}),
        });
      }
      const resource = catalog.resources.get(request.params.uri);
      if (!resource) return error(request.id, -32602, 'resource not found');
      return response(request.id, {
        resultType: 'complete',
        contents: [{ uri: resource.uri, mimeType: resource.uri.endsWith('.md') ? 'text/markdown' : 'text/plain', text: resource.text }],
        ...cacheable(request),
        ...(isModern(request) ? modernServerMeta : {}),
      });
    }
    const modern = isModern(request);
    if (request.method === 'tools/list') {
      if (request.id === undefined) return;
      const params = request.params === undefined ? {} : request.params;
      if (!exactParams(params, [], ['cursor', '_meta']) || Object.hasOwn(params, 'cursor'))
        return error(request.id, -32602, 'invalid tools/list params');
      return response(
        request.id,
        modern ? { resultType: 'complete', ttlMs: 0, cacheScope: 'private', tools: TOOLS, ...modernServerMeta } : { tools: TOOLS },
      );
    }
    if (request.method !== 'tools/call') return error(request.id, -32601, `method not found: ${request.method}`);
    if (request.id === undefined) return;
    if (
      !exactParams(request.params, ['name'], ['arguments', '_meta']) ||
      typeof request.params.name !== 'string' ||
      (request.params.arguments != null && !plainObject(request.params.arguments))
    )
      return error(request.id, -32602, 'invalid params');
    try {
      const rawValue = await invoke(request.params.name, request.params.arguments || {}, pending.get(request.id)?.signal);
      // `structuredContent` is optional.  Omit it for undefined handler
      // results instead of serializing undefined away in only some envelopes
      // or emitting null, which is not accepted by legacy object-only clients.
      const value = rawValue === undefined ? null : rawValue;
      // The 2025-06-18 CallToolResult schema accepts structuredContent only
      // as a non-null object.  SEP-2106 widened current MCP to every JSON
      // value, so preserve arrays/scalars/null only in a current envelope.
      const structured = modern
        ? rawValue === undefined
          ? {}
          : { structuredContent: rawValue }
        : plainObject(rawValue)
          ? { structuredContent: rawValue }
          : {};
      if (!cancelled.has(request.id))
        response(
          request.id,
          modern
            ? {
                resultType: 'complete',
                content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
                ...structured,
                isError: false,
                ...modernServerMeta,
              }
            : {
                content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
                ...structured,
                isError: false,
              },
        );
    } catch (cause) {
      if (!cancelled.has(request.id))
        response(
          request.id,
          modern
            ? {
                resultType: 'complete',
                content: [{ type: 'text', text: safeText(cause.message || cause) }],
                isError: true,
                ...modernServerMeta,
              }
            : { content: [{ type: 'text', text: safeText(cause.message || cause) }], isError: true },
        );
    } finally {
      pending.delete(request.id);
      cancelled.delete(request.id);
    }
  }
  let shutdownPromise;
  const shutdown = () => {
    if (shutdownPromise) return shutdownPromise;
    stopped = true;
    queuedOutput.length = 0;
    queuedOutputBytes = 0;
    detachTransport();
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.removeListener(signal, onSignal);
    for (const [id, controller] of pending) {
      cancelled.add(id);
      controller?.abort(new Error('MCP server closed'));
    }
    // A core that honours its AbortSignal settles promptly.  Keep EOF/signal
    // shutdown bounded even if an embedding core ignores cancellation.
    const settled = Promise.allSettled([...settlements]);
    let timeoutId;
    const timeout = new Promise((resolve) => {
      timeoutId = setTimeout(resolve, 5_000);
      timeoutId.unref?.();
    });
    // An embedding can ignore both request aborts and its shutdown promise.
    // Bound that collaborator too; otherwise a closed stdio transport can
    // retain a never-settling server promise despite the advertised deadline.
    shutdownPromise = Promise.allSettled([
      Promise.race([Promise.resolve(core.shutdown?.({ timeoutMs: 5_000 })), timeout]),
      Promise.race([settled, timeout]),
    ])
      .then(() => {})
      .finally(() => {
        if (timeoutId !== undefined) clearTimeout(timeoutId);
      });
    return shutdownPromise;
  };
  // Account while framing rather than concatenating an arbitrary unterminated
  // stdin chunk first. A hostile client can still make Node allocate its input
  // chunk, but it cannot make this server retain/copy an unbounded frame.
  let buffer = '',
    bufferBytes = 0,
    discardingFrame = false;
  const dispatchLine = (line) => {
    if (!line.trim()) return;
    try {
      const request = JSON.parse(line);
      // Every request with an id can produce a response. Bound all of them,
      // not only tools/call: catalog/resource reads can await shared I/O and
      // otherwise permit an unbounded promise/response flood.
      const tracked = request !== null && typeof request === 'object' && !Array.isArray(request) && Object.hasOwn(request, 'id');
      if (tracked && pending.has(request.id)) {
        error(request.id, -32600, 'duplicate request id');
        return;
      }
      if (tracked && pending.size >= maxPendingRequests) {
        error(request.id, -32000, 'too many concurrent requests');
        return;
      }
      if (tracked) pending.set(request.id, request.method === 'tools/call' ? new AbortController() : undefined);
      const work = handle(request)
        .catch(() => {})
        .finally(() => {
          if (tracked) {
            pending.delete(request.id);
            cancelled.delete(request.id);
          }
        });
      if (tracked) {
        settlements.add(work);
        void work.finally(() => settlements.delete(work));
      }
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
    }
  };
  const rejectLargeFrame = () => send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'frame too large' } });
  const onText = (part) => {
    if (stopped) return;
    let cursor = 0;
    while (cursor <= part.length) {
      const index = part.indexOf('\n', cursor);
      const end = index < 0 ? part.length : index;
      const segment = part.slice(cursor, end);
      if (discardingFrame) {
        if (index < 0) return;
        discardingFrame = false;
        cursor = index + 1;
        continue;
      }
      const segmentBytes = Buffer.byteLength(segment);
      if (bufferBytes + segmentBytes > maxFrameBytes) {
        buffer = '';
        bufferBytes = 0;
        rejectLargeFrame();
        if (index < 0) {
          discardingFrame = true;
          return;
        }
        cursor = index + 1;
        continue;
      }
      buffer += segment;
      bufferBytes += segmentBytes;
      if (index < 0) return;
      const line = buffer;
      buffer = '';
      bufferBytes = 0;
      dispatchLine(line);
      cursor = index + 1;
    }
  };
  // Stdio EOF and process termination own only this server's in-process
  // managers. A detached CLI worker lives in another PID and is untouched.
  let ended = false;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const malformedInput = () => {
    if (ended) return;
    ended = true;
    buffer = '';
    bufferBytes = 0;
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
    void shutdown();
  };
  const onData = (part) => {
    if (ended || stopped) return;
    try {
      onText(decoder.decode(Buffer.isBuffer(part) ? part : Buffer.from(part), { stream: true }));
    } catch {
      malformedInput();
    }
  };
  const onEnd = () => {
    if (ended) return;
    try {
      onText(decoder.decode());
    } catch {
      malformedInput();
      return;
    }
    ended = true;
    if (buffer.trim()) send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
    buffer = '';
    bufferBytes = 0;
    void shutdown();
  };
  const onSignal = () => {
    void shutdown().finally(() => process.exit(0));
  };
  input.on('data', onData);
  input.on('end', onEnd);
  input.on('error', onEnd);
  input.on('close', onEnd);
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.once(signal, onSignal);
  return {
    tools: TOOLS,
    handle,
    notifyProgress: (params) => send({ jsonrpc: '2.0', method: 'notifications/progress', params }),
    close: () => {
      const closing = shutdown();
      detachTransport();
      for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.removeListener(signal, onSignal);
      return closing;
    },
  };
}
