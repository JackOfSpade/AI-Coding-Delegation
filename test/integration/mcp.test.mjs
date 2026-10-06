import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough, Writable } from 'node:stream';
import { spawn } from 'node:child_process';
import { createMcpServer, parseSkillFrontmatter, readSkillRegularUtf8 } from '../../src/mcp.mjs';
import { runtimeIdentity } from '../../src/identity.mjs';
const skillUri = 'skill://offload/offload/SKILL.md';
const serverMeta = { _meta: { 'io.modelcontextprotocol/serverInfo': runtimeIdentity() } };
const currentMeta = {
  _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} },
};
const responseValues = (wire) => wire.trim().split('\n').filter(Boolean).map(JSON.parse);
function jsonFrontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  assert.ok(match, 'template has YAML frontmatter');
  return JSON.parse(match[1]);
}
test('MCP lists exact tools, initializes, pings and dispatches', async () => {
  const input = new PassThrough(),
    output = new PassThrough();
  let wire = '';
  output.on('data', (x) => (wire += x));
  const server = createMcpServer(
    {
      start: async (a) => ({ jobId: 'j', ...a }),
      wait: async () => ({}),
      job: async () => ({}),
      repair: async () => ({}),
      revert: async () => ({}),
      cancel: async () => ({}),
    },
    { input, output },
  );
  input.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n');
  input.write('{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n');
  input.write('{"jsonrpc":"2.0","id":3,"method":"ping"}\n');
  input.write('{"jsonrpc":"2.0","id":null,"method":"tools/list"}\n');
  input.write('{"jsonrpc":"1.0","method":"ping"}\n');
  await new Promise((r) => setTimeout(r, 10));
  const values = responseValues(wire);
  assert.match(wire, /offload_start/);
  assert.match(wire, /"id":1/);
  assert.match(wire, /"id":3/);
  const initialized = values.find((value) => value.id === 1).result.serverInfo;
  assert.deepEqual(initialized, runtimeIdentity());
  assert.equal(initialized.schemaRevision, 1);
  assert.deepEqual(initialized.capabilities, { reportMode: true, inputFiles: true });
  assert.ok(
    values.some((value) => value.id === null && value.result?.tools),
    'an explicit null id is a request, not a notification',
  );
  assert.ok(
    values.some((value) => value.id === null && value.error?.code === -32600),
    'an invalid request without an id must return a null-id error',
  );
  const startTool = values.find((value) => value.id === 2).result.tools.find((tool) => tool.name === 'offload_start');
  assert.match(startTool.inputSchema.properties.testCommand.description, /run exactly once/);
  assert.match(startTool.inputSchema.properties.testCommand.description, /quoted globs/);
  assert.match(startTool.inputSchema.properties.testCommand.description, /bare directories/);
  server.close();
});
test('MCP enforces advertised input schemas and maps only public operation options', async () => {
  const input = new PassThrough(),
    output = new PassThrough();
  let wire = '';
  output.on('data', (value) => {
    wire += value;
  });
  const calls = { start: [], wait: [], job: [], repair: [], revert: [], cancel: [] };
  const server = createMcpServer(
    {
      start: async (value) => {
        calls.start.push(value);
        return {};
      },
      wait: async (...value) => {
        calls.wait.push(value);
        return {};
      },
      job: async (...value) => {
        calls.job.push(value);
        return {};
      },
      repair: async (...value) => {
        calls.repair.push(value);
        return {};
      },
      revert: async (...value) => {
        calls.revert.push(value);
        return {};
      },
      cancel: async (...value) => {
        calls.cancel.push(value);
        return {};
      },
    },
    { input, output },
  );
  const call = (id, name, arguments_) =>
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: arguments_ } })}\n`);
  input.write('{"jsonrpc":"2.0","id":0,"method":"initialize","params":{}}\n');
  // Schema declarations are metadata to many MCP clients. The server itself
  // must reject a truthy non-boolean destructive flag, hidden launch control,
  // unknown keys, and typed values that do not meet the advertised contract.
  call(1, 'offload_revert', { jobId: 'j', apply: 'false' });
  call(2, 'offload_revert', { jobId: 'j', apply: 1 });
  call(3, 'offload_repair', { jobId: 'j', defects: ['fix'], launch: false });
  call(4, 'offload_wait', { jobId: 'j', timeoutSec: '5' });
  call(5, 'offload_cancel', { jobId: 'j', unexpected: true });
  // Valid public calls preserve the established dispatch API.
  call(6, 'offload_start', { task: 'implement', ownedPaths: ['src/**'], budget: { maxTurns: 1 }, unsafePolicyOnlyVerifier: true });
  call(7, 'offload_wait', { jobId: 'j', timeoutSec: 5, repoPath: '/repo' });
  call(8, 'offload_job', { jobId: 'j', include: 'files', repoPath: '/repo' });
  call(9, 'offload_repair', { jobId: 'j', defects: ['fix'], repoPath: '/repo' });
  call(10, 'offload_revert', { jobId: 'j', apply: true, repoPath: '/repo' });
  call(11, 'offload_cancel', { jobId: 'j', repoPath: '/repo' });
  call(12, 'offload_wait', { jobId: '' });
  call(13, 'offload_cancel', { jobId: 'x'.repeat(129) });
  call(18, 'offload_wait', { jobId: '_private' });
  call(19, 'offload_wait', { jobId: '-private' });
  call(14, 'offload_job', { repoPath: '' });
  call(15, 'offload_revert', { jobId: 'dry-run' });
  call(16, 'offload_start', { task: 'implement', ownedPaths: ['src/**'], repoPath: '' });
  call(17, 'offload_start', { task: 'implement', ownedPaths: ['src/**'], repoPath: '/'.concat('x'.repeat(4096)) });
  call(20, 'offload_start', { task: '', ownedPaths: ['src/**'] });
  call(21, 'offload_start', { task: 'implement', ownedPaths: [] });
  call(22, 'offload_start', { task: 'implement', ownedPaths: ['src/**'], budget: { maxTurns: 1001 } });
  call(23, 'offload_repair', { jobId: 'j', defects: [] });
  call(24, 'offload_start', { mode: 'report', task: 'analyze', inputFiles: ['/tmp/connector.json'] });
  call(25, 'offload_start', { task: 'implement', ownedPaths: ['src/**'], inputFiles: ['/tmp/connector.json'] });
  call(26, 'offload_start', { mode: 'report', task: 'analyze with explicit empty writable list', extraWritable: [] });
  call(27, 'offload_start', { mode: 'report', task: 'analyze with write authority', extraWritable: ['tmp/**'] });
  call(28, 'offload_start', {
    mode: 'report',
    task: 'review /tmp/customer-秘密-export.json',
    inputFiles: ['/tmp/customer-秘密-export.json'],
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const responses = wire.trim().split('\n').map(JSON.parse);
  for (const id of [1, 2, 3, 4, 5, 12, 13, 14, 16, 17, 18, 19, 20, 21, 22, 23, 25, 27, 28])
    assert.equal(responses.find((value) => value.id === id).result.isError, true);
  assert.equal(calls.revert.length, 2, 'invalid apply values must never reach a potentially applying reverter');
  assert.equal(calls.repair.length, 1, 'hidden launch:false must never reach core.repair');
  assert.deepEqual(calls.start[0].ownedPaths, ['src/**']);
  assert.equal(calls.start[0].unsafePolicyOnlyVerifier, true);
  assert.equal(calls.start[1].mode, 'report');
  assert.deepEqual(calls.start[1].inputFiles, ['/tmp/connector.json']);
  assert.equal(calls.start[2].mode, 'report');
  assert.deepEqual(calls.start[2].extraWritable, []);
  assert.equal(calls.wait[0][0], 'j');
  assert.equal(calls.wait[0][1].repoPath, '/repo');
  assert.equal(calls.wait[0][1].timeoutSec, 5);
  assert.ok(calls.wait[0][1].signal instanceof AbortSignal);
  assert.deepEqual(calls.job[0], ['j', { repoPath: '/repo', include: 'files' }]);
  assert.deepEqual(calls.repair[0], ['j', ['fix'], { repoPath: '/repo' }]);
  assert.deepEqual(calls.revert[0], ['j', { repoPath: '/repo', apply: true }]);
  assert.deepEqual(calls.revert[1], ['dry-run', { repoPath: undefined, apply: false }], 'omitted apply must be an explicit dry run');
  assert.deepEqual(calls.cancel[0], ['j', { repoPath: '/repo' }]);
  await server.close();
});
test('MCP revert defaults an omitted apply flag to a dry run in legacy and current envelopes', async () => {
  const input = new PassThrough(),
    output = new PassThrough();
  let wire = '';
  output.on('data', (value) => {
    wire += value;
  });
  const calls = [];
  // Match JobManager.revert's real defaulting boundary.  MCP deliberately
  // forwards only public options, so an absent `apply` arrives as undefined;
  // destructuring must retain the conservative dry-run default.
  const server = createMcpServer(
    {
      revert: async (jobId, { apply = false } = {}) => {
        calls.push({ jobId, apply });
        return { dryRun: !apply, applied: apply };
      },
    },
    { input, output },
  );
  const legacyCall = (id, arguments_) =>
    input.write(
      `${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'offload_revert', arguments: arguments_ } })}\n`,
    );
  const currentCall = (id, arguments_) =>
    input.write(
      `${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'offload_revert', arguments: arguments_, ...currentMeta } })}\n`,
    );
  input.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n');
  legacyCall(2, { jobId: 'legacy-dry-run' });
  legacyCall(3, { jobId: 'legacy-apply', apply: true });
  currentCall(4, { jobId: 'current-dry-run' });
  currentCall(5, { jobId: 'current-apply', apply: true });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(calls, [
    { jobId: 'legacy-dry-run', apply: false },
    { jobId: 'legacy-apply', apply: true },
    { jobId: 'current-dry-run', apply: false },
    { jobId: 'current-apply', apply: true },
  ]);
  const values = responseValues(wire);
  for (const [id, expected] of [
    [2, { dryRun: true, applied: false }],
    [3, { dryRun: false, applied: true }],
    [4, { dryRun: true, applied: false }],
    [5, { dryRun: false, applied: true }],
  ]) {
    const result = values.find((value) => value.id === id).result;
    assert.deepEqual(JSON.parse(result.content[0].text), expected);
    assert.deepEqual(result.structuredContent, expected);
  }
  assert.equal(values.find((value) => value.id === 2).result.resultType, undefined);
  assert.equal(values.find((value) => value.id === 4).result.resultType, 'complete');
  await server.close();
});
test('MCP handles split current discovery and ignores initialized notification', async () => {
  const input = new PassThrough(),
    output = new PassThrough();
  let wire = '';
  output.on('data', (x) => (wire += x));
  const server = createMcpServer({}, { input, output });
  input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n{"jsonrpc":"2.0","id":7,"method":"server/');
  input.write(`discover","params":${JSON.stringify(currentMeta)}}\n`);
  await new Promise((r) => setTimeout(r, 10));
  assert.match(wire, /"id":7/);
  assert.match(wire, /2026-07-28/);
  server.close();
});
test('MCP keeps current requests stateless and legacy initialize envelopes separate', async () => {
  const input = new PassThrough(),
    output = new PassThrough();
  let wire = '';
  output.on('data', (chunk) => {
    wire += chunk;
  });
  const server = createMcpServer({ job: async () => ({ ok: true }) }, { input, output });
  input.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n');
  input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'server/discover', params: currentMeta })}\n`);
  input.write('{"jsonrpc":"2.0","id":3,"method":"tools/list","params":{}}\n');
  input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: currentMeta })}\n`);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const values = responseValues(wire);
  const legacy = values.find((value) => value.id === 1).result,
    modern = values.find((value) => value.id === 2).result,
    legacyList = values.find((value) => value.id === 3).result,
    list = values.find((value) => value.id === 4).result;
  assert.equal(legacy.protocolVersion, '2025-06-18');
  assert.equal(modern.resultType, 'complete');
  assert.deepEqual(modern.supportedVersions, ['2026-07-28']);
  assert.equal(modern.ttlMs, 0);
  assert.equal(modern._meta['io.modelcontextprotocol/serverInfo'].name, 'offload');
  assert.equal(Object.hasOwn(legacyList, 'resultType'), false, 'a previous discover response must not upgrade a later legacy request');
  assert.equal(list.resultType, 'complete');
  assert.ok(Array.isArray(list.tools));
  for (const discovery of [legacy, modern]) {
    assert.equal(discovery.capabilities.extensions['io.modelcontextprotocol/skills'] instanceof Object, true);
    assert.deepEqual(discovery.capabilities.resources, {});
    assert.match(discovery.instructions, /Offload skill/);
    assert.match(
      discovery.instructions,
      /conversational client may call offload_start only for an actual `\/offload <task>` slash command/,
    );
    assert.match(discovery.instructions, /Prose, mentions, quotes, or negations/);
    assert.match(discovery.instructions, /DeepSeek, providers, or models never authorize it/);
    assert.doesNotMatch(discovery.instructions, /Direct CLI\/MCP operators may explicitly call it/);
    assert.match(discovery.instructions, /skill:\/\/offload\/offload\/SKILL\.md/);
    assert.match(discovery.instructions, /repoPath/);
    assert.match(discovery.instructions, /native Claude subagents/);
    assert.match(discovery.instructions, /profile "pro"/);
    assert.match(discovery.instructions, /policy-only/);
    assert.match(discovery.instructions, /Do not invent a “latest Pro” model/);
    assert.match(discovery.instructions, /policy-only hosts workers edit permitted private-worktree files, no shell/);
    assert.ok(discovery.instructions.length < 512);
  }
  const annotations = Object.fromEntries(list.tools.map((tool) => [tool.name, tool.annotations]));
  assert.deepEqual(annotations.offload_wait, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  assert.deepEqual(annotations.offload_job, annotations.offload_wait);
  for (const name of ['offload_start', 'offload_repair'])
    assert.deepEqual(annotations[name], { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
  assert.deepEqual(annotations.offload_revert, { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false });
  assert.deepEqual(annotations.offload_cancel, { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  for (const name of ['offload_start', 'offload_repair', 'offload_revert', 'offload_cancel'])
    assert.deepEqual(
      list.tools.find((tool) => tool.name === name)._meta,
      { 'anthropic/requiresUserInteraction': true },
      `${name} must require an explicit Claude Code approval`,
    );
  for (const name of ['offload_wait', 'offload_job'])
    assert.equal(
      Object.hasOwn(
        list.tools.find((tool) => tool.name === name),
        '_meta',
      ),
      false,
      `${name} is a read-only operation`,
    );
  assert.match(list.tools.find((tool) => tool.name === 'offload_start').inputSchema.properties.ownedPaths.description, /exclusively owns/);
  const startDescription = list.tools.find((tool) => tool.name === 'offload_start').description;
  assert.match(startDescription, /conversational client may use this tool only to fulfill an actual `\/offload <task>` slash command/);
  assert.doesNotMatch(startDescription, /explicit direct CLI\/MCP operator request/);
  assert.match(startDescription, /do not infer authorization from ordinary prose/);
  assert.match(startDescription, /mentions, quotes, or negations of Offload, delegation, DeepSeek, providers, or models/);
  assert.match(
    list.tools.find((tool) => tool.name === 'offload_start').inputSchema.properties.inputFiles.description,
    /macOS also accepts \/private\/tmp/,
  );
  assert.match(
    list.tools.find((tool) => tool.name === 'offload_start').inputSchema.properties.inputFiles.description,
    /canonical allowed roots before any job is created/,
  );
  assert.match(list.tools.find((tool) => tool.name === 'offload_start').inputSchema.properties.allowNetwork.description, /only/);
  assert.match(
    list.tools.find((tool) => tool.name === 'offload_start').inputSchema.properties.profile.description,
    /provider-maintained DeepSeek Pro\/high/,
  );
  assert.match(
    list.tools.find((tool) => tool.name === 'offload_start').inputSchema.properties.profile.description,
    /explicitly selected supported profile overrides/,
  );
  assert.match(
    list.tools.find((tool) => tool.name === 'offload_start').inputSchema.properties.effort.description,
    /Omit it to retain the selected profile/,
  );
  await server.close();
});
test('MCP applies current envelopes per request, rejects malformed current metadata, and retains legacy compatibility', async () => {
  const modernInput = new PassThrough(),
    modernOutput = new PassThrough();
  let modernWire = '';
  modernOutput.on('data', (chunk) => {
    modernWire += chunk;
  });
  const modern = createMcpServer({}, { input: modernInput, output: modernOutput });
  modernInput.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: currentMeta })}\n`);
  modernInput.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: currentMeta })}\n`);
  modernInput.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'skills/list', params: currentMeta })}\n`);
  modernInput.write(`${JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'resources/list', params: currentMeta })}\n`);
  modernInput.write(`${JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'skills/get', params: { uri: skillUri, ...currentMeta } })}\n`);
  modernInput.write(`${JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'resources/read', params: { uri: skillUri, ...currentMeta } })}\n`);
  modernInput.write(
    `${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2099-01-01', 'io.modelcontextprotocol/clientCapabilities': {} } } })}\n`,
  );
  modernInput.write(
    `${JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/clientCapabilities': {} } } })}\n`,
  );
  modernInput.write(`${JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'ping', params: currentMeta })}\n`);
  modernInput.write(
    `${JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'initialize', params: { protocolVersion: '2026-07-28', ...currentMeta } })}\n`,
  );
  modernInput.write(`${JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'tools/list', params: { extra: true, ...currentMeta } })}\n`);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const modernValues = responseValues(modernWire);
  assert.equal(modernValues.find((value) => value.id === 1).result.resultType, 'complete');
  for (const id of [2, 3, 4, 5, 6])
    assert.deepEqual(
      Object.fromEntries(
        ['resultType', 'ttlMs', 'cacheScope'].map((key) => [key, modernValues.find((value) => value.id === id).result[key]]),
      ),
      { resultType: 'complete', ttlMs: 0, cacheScope: 'private' },
    );
  assert.deepEqual(modernValues.find((value) => value.id === 4).result.resources, [
    { uri: skillUri, name: 'SKILL.md', mimeType: 'text/markdown' },
  ]);
  assert.deepEqual(modernValues.find((value) => value.id === 7).error, {
    code: -32022,
    message: 'UnsupportedProtocolVersionError',
    data: { supported: ['2026-07-28'], requested: '2099-01-01' },
  });
  assert.equal(modernValues.find((value) => value.id === 8).error.code, -32602);
  assert.equal(modernValues.find((value) => value.id === 9).error.code, -32601);
  assert.equal(modernValues.find((value) => value.id === 10).error.code, -32601);
  assert.equal(modernValues.find((value) => value.id === 11).error.code, -32602);
  await modern.close();

  const discoverInput = new PassThrough(),
    discoverOutput = new PassThrough();
  let discoverWire = '';
  discoverOutput.on('data', (chunk) => {
    discoverWire += chunk;
  });
  const discovered = createMcpServer({}, { input: discoverInput, output: discoverOutput });
  discoverInput.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: currentMeta })}\n`);
  discoverInput.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: currentMeta })}\n`);
  discoverInput.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'skills/list', params: currentMeta })}\n`);
  discoverInput.write(`${JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'skills/get', params: { uri: skillUri, ...currentMeta } })}\n`);
  discoverInput.write(
    `${JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'resources/read', params: { uri: skillUri, ...currentMeta } })}\n`,
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  const discoveredValues = responseValues(discoverWire);
  for (const id of [2, 3, 4, 5])
    assert.deepEqual(
      Object.fromEntries(
        ['resultType', 'ttlMs', 'cacheScope'].map((key) => [key, discoveredValues.find((value) => value.id === id).result[key]]),
      ),
      { resultType: 'complete', ttlMs: 0, cacheScope: 'private' },
    );
  await discovered.close();

  const legacyInput = new PassThrough(),
    legacyOutput = new PassThrough();
  let legacyWire = '';
  legacyOutput.on('data', (chunk) => {
    legacyWire += chunk;
  });
  const legacy = createMcpServer({}, { input: legacyInput, output: legacyOutput });
  legacyInput.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n');
  // Older clients sometimes used an unnamespaced marker. It is not current
  // per-request metadata and must not accidentally select current envelopes.
  const modernHint = { _meta: { protocolVersion: '2026-07-28' } };
  legacyInput.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: modernHint }) + '\n');
  legacyInput.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'skills/list', params: modernHint }) + '\n');
  legacyInput.write(JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'skills/get', params: { uri: skillUri, ...modernHint } }) + '\n');
  legacyInput.write(JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'resources/read', params: { uri: skillUri, ...modernHint } }) + '\n');
  await new Promise((resolve) => setTimeout(resolve, 30));
  const legacyValues = responseValues(legacyWire);
  assert.equal(legacyValues.find((value) => value.id === 1).result.protocolVersion, '2025-06-18');
  for (const id of [2, 3, 4, 5]) {
    const result = legacyValues.find((value) => value.id === id).result;
    assert.equal(Object.hasOwn(result, 'ttlMs'), false);
    assert.equal(Object.hasOwn(result, 'cacheScope'), false);
  }
  await legacy.close();
});
test('MCP exposes the canonical static skill with exact resources and safe request handling', async () => {
  const expectedText = await readFile(new URL('../../plugins/offload/skills/offload/SKILL.md', import.meta.url), 'utf8');
  const expectedFrontmatter = jsonFrontmatter(expectedText);
  assert.match(expectedFrontmatter.description, /\/offload/);
  assert.match(expectedFrontmatter.description, /explicitly enters \/offload as a slash command/);
  assert.equal(expectedFrontmatter['argument-hint'], '<task or verification request>');
  assert.equal(Object.hasOwn(expectedFrontmatter.metadata || {}, 'argument-hint'), false);
  assert.match(expectedText, /Do \*\*not\*\* satisfy that `\/offload` command invocation with Claude Code's native subagents/);
  assert.match(
    expectedText,
    /nor do bounded, multi-file, implementation, testing, debugging, Workflow, ultracode, or native-subagent requests/,
  );
  assert.match(expectedText, /including Sonnet ultracode\/native-agent workflows/);
  assert.match(
    expectedText,
    /A mention, quotation, negation, or discussion of `\/offload`, offload, delegation, \*\*DeepSeek\*\* \/ \*\*DeepSeek-V4-Pro\*\*, a provider, or a model does not select Offload/,
  );
  assert.match(expectedText, /A standalone instruction not to use native subagents does not trigger Offload/);
  assert.match(expectedText, /For a `\/offload` command invocation, end every final answer/);
  assert.match(expectedText, /explicitly set `profile: "pro"`/);
  assert.match(expectedText, /omit `effort`/);
  assert.match(expectedText, /explicitly selects a supported profile name within a `\/offload` command invocation/);
  assert.match(expectedText, /provider or model name never triggers Offload or permits inferring, overriding, or inventing a profile/);
  assert.match(expectedText, /do \*\*not\*\* add `unsafePolicyOnlyVerifier` merely to get a worker test/);
  assert.match(expectedText, /does not preflight or retry the command/);
  assert.match(expectedText, /quoted globs, not bare directories/);
  const digest = `sha256:${createHash('sha256').update(Buffer.from(expectedText, 'utf8')).digest('hex')}`;
  const size = Buffer.byteLength(expectedText, 'utf8');
  const input = new PassThrough(),
    output = new PassThrough();
  let wire = '';
  output.on('data', (chunk) => {
    wire += chunk;
  });
  const server = createMcpServer({}, { input, output });
  input.write('{"jsonrpc":"2.0","id":0,"method":"initialize","params":{}}\n');
  const request = (id, method, params) => input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  const meta = currentMeta;
  request(1, 'skills/list', meta);
  request(2, 'skills/get', { uri: skillUri, ...meta });
  request(3, 'resources/read', { uri: skillUri, ...meta });
  request(4, 'skills/list', { cursor: 'not-issued' });
  request(5, 'skills/get', { uri: 'skill://offload/offload/../SKILL.md' });
  request(6, 'resources/read', { uri: 'skill://offload/offload/missing.md' });
  request(7, 'skills/get', { uri: skillUri, extra: true });
  request(8, 'skills/nope', {});
  request(9, 'skills/list');
  await new Promise((resolve) => setTimeout(resolve, 30));
  const values = responseValues(wire);
  const listed = values.find((value) => value.id === 1).result,
    gotten = values.find((value) => value.id === 2).result,
    resource = values.find((value) => value.id === 3).result,
    legacyList = values.find((value) => value.id === 9).result;
  assert.deepEqual(listed, {
    resultType: 'complete',
    skills: [gotten.skill],
    ttlMs: 0,
    cacheScope: 'private',
    ...serverMeta,
  });
  assert.equal(listed.skills.length, 1);
  assert.equal(Object.hasOwn(listed, 'nextCursor'), false, 'terminal page has no cursor');
  const skill = listed.skills[0];
  assert.equal(skill.uri, skillUri);
  assert.deepEqual(skill.frontmatter, expectedFrontmatter);
  assert.deepEqual(skill.resources, [{ uri: skillUri, digest, size }]);
  assert.match(skill.resources[0].digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(gotten.resultType, 'complete');
  assert.deepEqual(resource, {
    resultType: 'complete',
    contents: [{ uri: skillUri, mimeType: 'text/markdown', text: expectedText }],
    ttlMs: 0,
    cacheScope: 'private',
    ...serverMeta,
  });
  assert.deepEqual(legacyList, { resultType: 'complete', skills: [gotten.skill] }, 'skills/list accepts omitted optional params');
  assert.equal(values.find((value) => value.id === 4).error.code, -32602);
  assert.equal(values.find((value) => value.id === 5).error.code, -32602);
  assert.equal(values.find((value) => value.id === 6).error.code, -32602);
  assert.equal(values.find((value) => value.id === 7).error.code, -32602);
  assert.equal(values.find((value) => value.id === 8).error.code, -32601);
  await server.close();
});
test('MCP preserves JSON frontmatter nested metadata, arrays, and special strings exactly', () => {
  const frontmatter = {
    name: 'offload',
    description: 'Quoted "text" with \\slashes and\nnewlines.',
    metadata: { nested: { enabled: true, count: 2 }, labels: ['one', 'two'] },
    'x-extra': [null, false, 3],
  };
  const text = `---\n${JSON.stringify(frontmatter)}\n---\n\nBody\n`;
  assert.deepEqual(parseSkillFrontmatter(text), frontmatter);
});
test('MCP skill reads reject swapped-link targets and non-UTF-8 artifacts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'offload-mcp-skill-'));
  const target = join(dir, 'target.md'),
    link = join(dir, 'linked.md'),
    invalid = join(dir, 'invalid.md');
  await writeFile(target, 'outside');
  await symlink(target, link);
  await writeFile(invalid, Buffer.from([0xff]));
  await assert.rejects(() => readSkillRegularUtf8(link, 1024, 'linked.md'), /artifact unavailable: linked\.md is missing or unreadable/);
  await assert.rejects(() => readSkillRegularUtf8(invalid, 1024, 'invalid.md'), /artifact unavailable: invalid\.md must be UTF-8 text/);
});
test('MCP EOF requests bounded shutdown only from its local core', async () => {
  const input = new PassThrough(),
    output = new PassThrough();
  let calls = 0;
  const server = createMcpServer(
    {
      shutdown: async ({ timeoutMs }) => {
        calls += 1;
        assert.equal(timeoutMs, 5_000);
      },
    },
    { input, output },
  );
  input.end();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(calls, 1);
  server.close();
});
test('MCP rejects duplicate ids and non-plain tool arguments without replying to notifications', async () => {
  const input = new PassThrough(),
    output = new PassThrough();
  let wire = '';
  output.on('data', (value) => (wire += value));
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const server = createMcpServer({ wait: async () => pending }, { input, output });
  input.write('{"jsonrpc":"2.0","id":0,"method":"initialize","params":{}}\n');
  input.write('{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"offload_wait","arguments":{"jobId":"x"}}}\n');
  input.write('{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"offload_wait","arguments":{"jobId":"x"}}}\n');
  input.write('{"jsonrpc":"2.0","method":"tools/call","params":{"name":"offload_wait","arguments":[]}}\n');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.match(wire, /duplicate request id/);
  assert.doesNotMatch(wire, /invalid params/);
  release({});
  server.close();
});
test('MCP bounds concurrent stateful calls before dispatching more work', async () => {
  const input = new PassThrough(),
    output = new PassThrough();
  let wire = '',
    calls = 0,
    release;
  output.on('data', (value) => {
    wire += value;
  });
  const waiting = new Promise((resolve) => {
    release = resolve;
  });
  const server = createMcpServer(
    {
      wait: async () => {
        calls++;
        return waiting;
      },
    },
    { input, output, maxPendingRequests: 1 },
  );
  input.write('{"jsonrpc":"2.0","id":0,"method":"initialize","params":{}}\n');
  await new Promise((resolve) => setTimeout(resolve, 5));
  input.write('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"offload_wait","arguments":{"jobId":"first"}}}\n');
  input.write('{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"offload_wait","arguments":{"jobId":"second"}}}\n');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(calls, 1);
  assert.match(wire, /too many concurrent requests/);
  release({ ok: true });
  await server.close();
});
test('MCP safely handles partial, oversized, malformed, and tools/call notification frames', async () => {
  const input = new PassThrough(),
    output = new PassThrough();
  let wire = '',
    calls = 0;
  output.on('data', (value) => {
    wire += value;
  });
  const server = createMcpServer(
    {
      job: async () => {
        calls++;
        return { ok: true };
      },
    },
    { input, output, maxFrameBytes: 1024 },
  );
  input.write('{"jsonrpc":"2.0","id":99,"method":"initialize","params":{}}\n');
  input.write('{"jsonrpc":"2.0","id":0,"method":"tools/');
  input.write('list"}\n');
  input.write('{"jsonrpc":"2.0","method":"tools/call","params":{"name":"offload_job","arguments":{}}}\n');
  input.write('{bad}\n');
  input.write(`${'x'.repeat(1025)}\n`);
  await new Promise((resolve) => setTimeout(resolve, 15));
  const values = wire.trim().split('\n').map(JSON.parse);
  assert.ok(values.some((value) => value.id === 0 && value.result?.tools));
  assert.equal(calls, 0);
  assert.equal(values.filter((value) => value.error?.code === -32700).length, 2);
  await server.close();
});
test('MCP incrementally decodes split UTF-8 and closes on malformed bytes', async () => {
  const input = new PassThrough(),
    output = new PassThrough();
  let wire = '',
    shutdowns = 0;
  output.on('data', (value) => {
    wire += value;
  });
  const server = createMcpServer(
    {
      shutdown: async () => {
        shutdowns++;
      },
    },
    { input, output },
  );
  const request = Buffer.from('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"rootPath":"caf\u00e9"}}\n');
  const split = request.indexOf(Buffer.from([0xc3]));
  input.write(request.subarray(0, split + 1));
  input.write(request.subarray(split + 1));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(responseValues(wire).some((value) => value.id === 1 && value.result));
  input.write(Buffer.from([0x7b, 0xff, 0x7d, 0x0a]));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(responseValues(wire).filter((value) => value.error?.code === -32700).length, 1);
  assert.equal(shutdowns, 1);
  await server.close();
});
test('MCP pauses input and queues a bounded response sequence until stdout drains', async () => {
  const input = new PassThrough(),
    writes = [],
    callbacks = [];
  const output = new Writable({
    highWaterMark: 1,
    write(chunk, _encoding, callback) {
      writes.push(String(chunk));
      callbacks.push(callback);
    },
  });
  const server = createMcpServer({}, { input, output });
  input.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n');
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(input.isPaused(), true, 'stdout backpressure pauses additional request intake');
  server.notifyProgress({ progress: 1 });
  assert.equal(writes.length, 1, 'the notification waits behind the blocked response');
  callbacks.shift()();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(writes.length, 2);
  assert.match(writes[1], /notifications\/progress/);
  callbacks.shift()();
  await server.close();
});
test('MCP output-queue overflow detaches a blocked custom transport and shuts down once', async () => {
  const input = new PassThrough(),
    callbacks = [];
  let shutdowns = 0;
  const output = new Writable({
    highWaterMark: 1,
    write(_chunk, _encoding, callback) {
      callbacks.push(callback);
    },
  });
  const server = createMcpServer(
    {
      shutdown: async () => {
        shutdowns++;
      },
    },
    { input, output, maxFrameBytes: 1024 },
  );
  input.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n');
  await new Promise((resolve) => setTimeout(resolve, 5));
  // The first response intentionally remains blocked. Large notifications
  // then exceed the 1 MiB minimum queue cap without requiring an unbounded
  // test allocation.
  for (let index = 0; index < 20; index++) server.notifyProgress({ index, text: 'x'.repeat(64 * 1024) });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(shutdowns, 1);
  assert.equal(input.listenerCount('data'), 0, 'failed output must stop request intake');
  assert.equal(output.listenerCount('drain'), 0, 'failed output must not retain a drain listener');
  assert.equal(output.listenerCount('error'), 0, 'failed output must not retain an error listener');
  assert.equal(input.isPaused(), true);
  // The server owns neither process stdio nor a normal drainable sequence,
  // but it does close its custom fatal transport deterministically.
  assert.equal(output.destroyed, true);
  callbacks.shift()?.();
  await server.close();
});
test('MCP rejects an oversized first output frame before a custom stream can buffer it', async () => {
  const input = new PassThrough();
  let writes = 0,
    shutdowns = 0;
  const output = new Writable({
    highWaterMark: 1,
    write(_chunk, _encoding, callback) {
      writes += 1;
      callback();
    },
  });
  const server = createMcpServer(
    {
      shutdown: async () => {
        shutdowns += 1;
      },
    },
    { input, output, maxFrameBytes: 16_000_000 },
  );
  // The maximum-frame configuration has an 8 MiB output cap. The first
  // response must fail closed before output.write receives its oversized data.
  server.notifyProgress({ text: 'x'.repeat(8 * 1024 * 1024) });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(writes, 0);
  assert.equal(shutdowns, 1);
  assert.equal(input.listenerCount('data'), 0);
  assert.equal(output.destroyed, true);
  await server.close();
});
test('MCP uniformly bounds deferred catalog requests and rejects duplicate non-tool IDs', async () => {
  const input = new PassThrough(),
    output = new PassThrough();
  let wire = '';
  output.on('data', (chunk) => {
    wire += chunk;
  });
  const server = createMcpServer({}, { input, output, maxPendingRequests: 2 });
  input.write('{"jsonrpc":"2.0","id":0,"method":"initialize","params":{}}\n');
  await new Promise((resolve) => setTimeout(resolve, 5));
  // The first catalog read is asynchronous. All frames are dispatched in the
  // same input turn, so only two can enter the pending map before it settles.
  for (let id = 1; id <= 5; id++) input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'skills/list' })}\n`);
  await new Promise((resolve) => setTimeout(resolve, 40));
  input.write('{"jsonrpc":"2.0","id":9,"method":"tools/list"}\n');
  input.write('{"jsonrpc":"2.0","id":9,"method":"tools/list"}\n');
  await new Promise((resolve) => setTimeout(resolve, 10));
  const values = responseValues(wire);
  assert.equal(values.filter((value) => value.error?.message === 'too many concurrent requests').length, 3);
  assert.ok(values.some((value) => value.id === 9 && value.error?.message === 'duplicate request id'));
  assert.ok(values.some((value) => value.id === 9 && value.result?.tools));
  await server.close();
});
test('MCP discards an oversized unterminated frame before accepting the next frame', async () => {
  const input = new PassThrough(),
    output = new PassThrough();
  let wire = '';
  output.on('data', (value) => {
    wire += value;
  });
  const server = createMcpServer({}, { input, output, maxFrameBytes: 1024 });
  input.write('{"jsonrpc":"2.0","id":99,"method":"initialize","params":{}}\n');
  input.write('x'.repeat(1025));
  input.write('\n{"jsonrpc":"2.0","id":4,"method":"ping"}\n');
  await new Promise((resolve) => setTimeout(resolve, 15));
  const values = wire.trim().split('\n').map(JSON.parse);
  assert.ok(values.some((value) => value.error?.message === 'frame too large'));
  assert.ok(values.some((value) => value.id === 4 && value.result));
  await server.close();
});
test('MCP close aborts an active wait and shares one shutdown promise', async () => {
  const input = new PassThrough(),
    output = new PassThrough();
  let shutdowns = 0,
    aborted = false;
  const server = createMcpServer(
    {
      wait: async (_id, { signal }) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener(
            'abort',
            () => {
              aborted = true;
              reject(signal.reason);
            },
            { once: true },
          ),
        ),
      shutdown: async () => {
        shutdowns++;
      },
    },
    { input, output },
  );
  input.write('{"jsonrpc":"2.0","id":99,"method":"initialize","params":{}}\n');
  input.write('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"offload_wait","arguments":{"jobId":"j"}}}\n');
  await new Promise((resolve) => setTimeout(resolve, 5));
  const first = server.close(),
    second = server.close();
  assert.strictEqual(first, second);
  await first;
  assert.equal(aborted, true);
  assert.equal(shutdowns, 1);
});
test('MCP shutdown waits for an aborting handler, writes nothing afterward, and permits an undefined synchronous result', async () => {
  const input = new PassThrough(),
    output = new PassThrough();
  let wire = '',
    settled = false;
  output.on('data', (value) => {
    wire += value;
  });
  const server = createMcpServer(
    {
      wait: async (_id, { signal }) =>
        new Promise((resolve) =>
          signal.addEventListener(
            'abort',
            () =>
              setTimeout(() => {
                settled = true;
                resolve({ late: true });
              }, 15),
            { once: true },
          ),
        ),
      job: () => undefined,
      shutdown: async () => {},
    },
    { input, output },
  );
  input.write('{"jsonrpc":"2.0","id":99,"method":"initialize","params":{}}\n');
  input.write('{"jsonrpc":"2.0","id":0,"method":"tools/call","params":{"name":"offload_wait","arguments":{"jobId":"j"}}}\n');
  await new Promise((resolve) => setTimeout(resolve, 5));
  wire = '';
  await server.close();
  assert.equal(settled, true);
  assert.equal(wire, '');
  const secondInput = new PassThrough(),
    secondOutput = new PassThrough();
  let secondWire = '';
  secondOutput.on('data', (value) => {
    secondWire += value;
  });
  const second = createMcpServer({ job: () => undefined }, { input: secondInput, output: secondOutput });
  secondInput.write('{"jsonrpc":"2.0","id":99,"method":"initialize","params":{}}\n');
  secondInput.write('{"jsonrpc":"2.0","id":"","method":"tools/call","params":{"name":"offload_job","arguments":{}}}\n');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.doesNotMatch(secondWire, /unknown tool/);
  assert.match(secondWire, /"id":""/);
  const secondValues = responseValues(secondWire);
  const legacyUndefined = secondValues.find((value) => value.id === '').result;
  assert.deepEqual(legacyUndefined, { content: [{ type: 'text', text: 'null' }], isError: false });
  assert.equal(
    Object.hasOwn(legacyUndefined, 'structuredContent'),
    false,
    'legacy CallToolResult omits structuredContent unless it has a value',
  );
  await second.close();
  const currentInput = new PassThrough(),
    currentOutput = new PassThrough();
  let currentWire = '';
  currentOutput.on('data', (value) => {
    currentWire += value;
  });
  const current = createMcpServer({ job: () => undefined }, { input: currentInput, output: currentOutput });
  currentInput.write(
    `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'offload_job', arguments: {}, ...currentMeta } })}\n`,
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  const currentUndefined = responseValues(currentWire).find((value) => value.id === 1).result;
  assert.deepEqual(currentUndefined.content, [{ type: 'text', text: 'null' }]);
  assert.equal(Object.hasOwn(currentUndefined, 'structuredContent'), false, 'current CallToolResult also omits absent structured data');
  assert.equal(currentUndefined.resultType, 'complete');
  await current.close();
  const legacyArrayInput = new PassThrough(),
    legacyArrayOutput = new PassThrough();
  let legacyArrayWire = '';
  legacyArrayOutput.on('data', (value) => {
    legacyArrayWire += value;
  });
  const legacyArray = createMcpServer({ job: () => ['x'] }, { input: legacyArrayInput, output: legacyArrayOutput });
  legacyArrayInput.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n');
  legacyArrayInput.write('{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"offload_job","arguments":{}}}\n');
  await new Promise((resolve) => setTimeout(resolve, 10));
  const legacyArrayResult = responseValues(legacyArrayWire).find((value) => value.id === 2).result;
  assert.deepEqual(legacyArrayResult.content, [{ type: 'text', text: '[\n  "x"\n]' }]);
  assert.equal(Object.hasOwn(legacyArrayResult, 'structuredContent'), false, 'legacy structuredContent is object-only');
  await legacyArray.close();
  const currentArrayInput = new PassThrough(),
    currentArrayOutput = new PassThrough();
  let currentArrayWire = '';
  currentArrayOutput.on('data', (value) => {
    currentArrayWire += value;
  });
  const currentArray = createMcpServer({ job: () => ['x'] }, { input: currentArrayInput, output: currentArrayOutput });
  currentArrayInput.write(
    `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'offload_job', arguments: {}, ...currentMeta } })}\n`,
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  const currentArrayResult = responseValues(currentArrayWire).find((value) => value.id === 1).result;
  assert.deepEqual(currentArrayResult.structuredContent, ['x'], 'current MCP permits every JSON structuredContent value');
  await currentArray.close();
});
test('MCP subprocess completes a handshake and shuts down on EOF', async () => {
  const child = spawn(process.execPath, ['bin/offload.mjs', 'mcp'], { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '',
    stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (value) => {
    stdout += value;
  });
  child.stderr.on('data', (value) => {
    stderr += value;
  });
  child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n');
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`MCP handshake timed out: ${stderr}`)), 3_000);
    const watch = () => {
      if (stdout.includes('"id":1')) {
        clearTimeout(timer);
        child.stdout.removeListener('data', watch);
        resolve();
      }
    };
    child.stdout.on('data', watch);
  });
  child.stdin.end();
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('MCP did not exit after EOF'));
    }, 3_000);
    child.once('exit', (value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
  assert.equal(code, 0);
  assert.match(stdout, /offload/);
});
