import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough, Writable } from 'node:stream';
import { spawn } from 'node:child_process';
import { createMcpServer, parseSkillFrontmatter, readSkillRegularUtf8 } from '../../src/mcp.mjs';
import { runCli } from '../../src/cli.mjs';
import { IDENTITY_SCHEMA_REVISION, RUNTIME_CAPABILITIES, runtimeIdentity } from '../../src/identity.mjs';
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
  assert.equal(initialized.schemaRevision, 2);
  assert.deepEqual(initialized.capabilities, {
    reportMode: true,
    inputFiles: true,
    continueJob: true,
    lateApply: true,
    failedApply: true,
    compactReports: true,
    verifierDeps: true,
    baselineVerifier: true,
    applyThenVerify: true,
    budgetSizing: true,
    failureDiagnostics: true,
    timingBreakdown: true,
    verifierInterpreter: true,
    retrospective: true,
  });
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
  const calls = { start: [], wait: [], job: [], repair: [], revert: [], cancel: [], continue: [], apply: [] };
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
      continue: async (...value) => {
        calls.continue.push(value);
        return {};
      },
      apply: async (...value) => {
        calls.apply.push(value);
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
  call(29, 'offload_continue', { jobId: 'j', extraTurns: 30, extraUsd: 0.5, note: 'finish the tests', repoPath: '/repo' });
  call(30, 'offload_continue', { jobId: 'j' });
  call(31, 'offload_continue', { jobId: 'j', extraTurns: 0 });
  call(32, 'offload_continue', { jobId: 'j', extraUsd: 0 });
  call(33, 'offload_continue', { jobId: 'j', extraTurns: 501 });
  call(34, 'offload_continue', { jobId: 'j', launch: false });
  call(35, 'offload_apply', { jobId: 'j' });
  call(36, 'offload_apply', { jobId: 'j', apply: true, verifiedBy: 'ran npm test in the primary: all green', repoPath: '/repo' });
  call(37, 'offload_apply', { jobId: 'j', apply: 'true', verifiedBy: 'ran npm test in the primary' });
  call(38, 'offload_apply', { jobId: 'j', apply: true, verifiedBy: 'short' });
  call(39, 'offload_wait', { jobId: 'j', detail: 'full' });
  call(40, 'offload_job', { jobId: 'j', include: 'diff', detail: 'compact' });
  call(41, 'offload_wait', { jobId: 'j', detail: 'verbose' });
  call(42, 'offload_wait', { jobId: 'j', timeoutSec: 600 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const responses = wire.trim().split('\n').map(JSON.parse);
  for (const id of [1, 2, 3, 4, 5, 12, 13, 14, 16, 17, 18, 19, 20, 21, 22, 23, 25, 27, 28, 31, 32, 33, 34, 37, 38, 41, 42])
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
  assert.deepEqual(calls.continue, [
    ['j', { repoPath: '/repo', extraTurns: 30, extraUsd: 0.5, note: 'finish the tests' }],
    ['j', { repoPath: undefined }],
  ]);
  assert.deepEqual(calls.apply, [
    ['j', { repoPath: undefined, apply: false }],
    ['j', { repoPath: '/repo', apply: true, verifiedBy: 'ran npm test in the primary: all green' }],
  ]);
  assert.equal(calls.wait[1][1].detail, 'full');
  assert.equal(calls.wait.length, 2, 'an invalid detail or oversized timeout must never reach core.wait');
  assert.match(JSON.stringify(responses.find((value) => value.id === 42)), /timeoutSec exceeds its maximum of 55/);
  assert.deepEqual(calls.job[1], ['j', { repoPath: undefined, include: 'diff', detail: 'compact' }]);
  await server.close();
});
test('MCP exposes the baseline-diff verifier options, forwards only supplied values, and rejects misuse before dispatch', async () => {
  const input = new PassThrough(),
    output = new PassThrough();
  let wire = '';
  output.on('data', (value) => {
    wire += value;
  });
  const started = [];
  const server = createMcpServer(
    {
      start: async (value) => {
        started.push(value);
        return {};
      },
    },
    { input, output },
  );
  const call = (id, arguments_) =>
    input.write(
      `${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'offload_start', arguments: arguments_ } })}\n`,
    );
  input.write('{"jsonrpc":"2.0","id":0,"method":"initialize","params":{}}\n');
  input.write('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n');
  const write = { task: 'implement', ownedPaths: ['src/**'], testCommand: 'node --test test/*.test.mjs' };
  call(2, { ...write, verifierMode: 'baseline-diff', verifierTimeoutSec: 120 });
  call(3, write);
  call(4, { ...write, verifierMode: 'strict' });
  call(5, { ...write, verifierTimeoutSec: 4 });
  call(6, { ...write, verifierTimeoutSec: 1801 });
  call(7, { ...write, verifierTimeoutSec: 60.5 });
  call(8, { mode: 'report', task: 'analyze', verifierMode: 'baseline-diff' });
  call(9, { mode: 'report', task: 'analyze', verifierTimeoutSec: 60 });
  call(10, { ...write, verifierMode: 'baseline-diff', unsafePolicyOnlyVerifier: true });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const values = responseValues(wire);
  const properties = values.find((value) => value.id === 1).result.tools.find((tool) => tool.name === 'offload_start')
    .inputSchema.properties;
  assert.deepEqual(properties.verifierMode.enum, ['standard', 'baseline-diff']);
  assert.equal(properties.verifierTimeoutSec.type, 'integer');
  assert.equal(properties.verifierTimeoutSec.minimum, 5);
  assert.equal(properties.verifierTimeoutSec.maximum, 1800);
  assert.equal(started.length, 2, 'only the two valid calls reach core.start');
  assert.equal(started[0].verifierMode, 'baseline-diff');
  assert.equal(started[0].verifierTimeoutSec, 120);
  assert.equal(Object.hasOwn(started[1], 'verifierMode'), false, 'an omitted option is absent, not undefined');
  assert.equal(Object.hasOwn(started[1], 'verifierTimeoutSec'), false);
  for (const id of [4, 5, 6, 7, 8, 9, 10]) assert.equal(values.find((value) => value.id === id).result.isError, true, `call ${id}`);
  assert.match(JSON.stringify(values.find((value) => value.id === 8)), /report jobs do not run verifiers/);
  assert.match(JSON.stringify(values.find((value) => value.id === 10)), /cannot use unsafePolicyOnlyVerifier/);
  await server.close();
});
test('MCP exposes the turn policy and line-range hint, keeps the 1000-turn schema ceiling, and rejects a bad policy before dispatch', async () => {
  const input = new PassThrough(),
    output = new PassThrough();
  let wire = '';
  output.on('data', (value) => {
    wire += value;
  });
  const started = [];
  const server = createMcpServer(
    {
      start: async (value) => {
        started.push(value);
        return {};
      },
    },
    { input, output },
  );
  const call = (id, arguments_) =>
    input.write(
      `${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'offload_start', arguments: arguments_ } })}\n`,
    );
  input.write('{"jsonrpc":"2.0","id":0,"method":"initialize","params":{}}\n');
  input.write('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n');
  const write = { task: 'implement', ownedPaths: ['src/**'] };
  call(2, { ...write, budget: { maxUsd: 2, turnPolicy: 'auto' }, relevantPaths: ['src/a.mjs:10-20'] });
  call(3, { ...write, budget: { turnPolicy: 'x' } });
  call(4, { ...write, budget: { maxTurns: 1001 } });
  call(5, { ...write, relevantPaths: ['src/a.mjs:20-10'] });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const values = responseValues(wire);
  const tool = values.find((value) => value.id === 1).result.tools.find((candidate) => candidate.name === 'offload_start');
  const { budget, relevantPaths } = tool.inputSchema.properties;
  assert.deepEqual(budget.properties.turnPolicy.enum, ['auto', 'fixed']);
  assert.equal(budget.properties.maxTurns.maximum, 1000);
  assert.match(relevantPaths.description, /path:START-END/);
  assert.match(tool.description, /budgetSizing/);
  assert.equal(started.length, 1, 'only the valid call reaches core.start');
  assert.deepEqual(started[0].budget, { maxUsd: 2, turnPolicy: 'auto' });
  assert.deepEqual(started[0].relevantPaths, ['src/a.mjs:10-20']);
  for (const id of [3, 4, 5]) assert.equal(values.find((value) => value.id === id).result.isError, true, `call ${id}`);
  assert.match(JSON.stringify(values.find((value) => value.id === 5)), /START-END/);
  await server.close();
});
test('MCP exposes applyThenVerify, forwards it with the request signal only when supplied, and rejects misuse before dispatch', async () => {
  const input = new PassThrough(),
    output = new PassThrough();
  let wire = '';
  output.on('data', (value) => {
    wire += value;
  });
  const applied = [];
  const server = createMcpServer(
    {
      apply: async (...value) => {
        applied.push(value);
        return {};
      },
    },
    { input, output },
  );
  const call = (id, arguments_) =>
    input.write(
      `${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'offload_apply', arguments: arguments_ } })}\n`,
    );
  input.write('{"jsonrpc":"2.0","id":0,"method":"initialize","params":{}}\n');
  input.write('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n');
  call(2, { jobId: 'j', apply: true, applyThenVerify: 'npm test' });
  call(3, {
    jobId: 'j',
    apply: true,
    applyThenVerify: 'npm test',
    applyThenVerifyTimeoutSec: 30,
    unsafePolicyOnlyVerifier: true,
    repoPath: '/repo',
  });
  call(4, { jobId: 'j', apply: true, verifiedBy: 'ran npm test in the primary', applyThenVerify: 'npm test' });
  call(5, { jobId: 'j', apply: true, verifiedBy: 'ran npm test in the primary' });
  for (const [id, extra] of [
    [6, { applyThenVerify: '' }],
    [7, { applyThenVerify: 'x'.repeat(8193) }],
    [8, { applyThenVerify: 'npm test', applyThenVerifyTimeoutSec: 4 }],
    [9, { applyThenVerify: 'npm test', applyThenVerifyTimeoutSec: 901 }],
    [10, { applyThenVerify: 'npm test', applyThenVerifyTimeoutSec: '30' }],
    [11, { applyThenVerify: 'npm test', applyThenVerifyTimeoutSec: 1.5 }],
    [12, { applyThenVerify: 'npm test', unsafePolicyOnlyVerifier: 'yes' }],
    [13, { applyThenVerifyTimeoutSec: 30 }],
    [14, { unsafePolicyOnlyVerifier: true }],
    [15, { applyThenVerify: 42 }],
  ])
    call(id, { jobId: 'j', apply: true, ...extra });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const values = responseValues(wire);
  const tool = values.find((value) => value.id === 1).result.tools.find((candidate) => candidate.name === 'offload_apply');
  const { properties } = tool.inputSchema;
  assert.equal(properties.applyThenVerify.type, 'string');
  assert.equal(properties.applyThenVerify.minLength, 1);
  assert.equal(properties.applyThenVerify.maxLength, 8192);
  assert.equal(properties.applyThenVerifyTimeoutSec.type, 'integer');
  assert.equal(properties.applyThenVerifyTimeoutSec.minimum, 5);
  assert.equal(properties.applyThenVerifyTimeoutSec.maximum, 900);
  assert.equal(properties.unsafePolicyOnlyVerifier.type, 'boolean');
  assert.deepEqual(tool.inputSchema.required, ['jobId']);
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.match(tool.description, /applyThenVerify/);
  assert.match(tool.description, /`applied` field/);
  assert.equal(applied.length, 4, 'every misuse is rejected before core.apply');
  assert.deepEqual(Object.keys(applied[0][1]).sort(), ['apply', 'applyThenVerify', 'repoPath', 'signal']);
  assert.equal(applied[0][1].applyThenVerify, 'npm test');
  assert.ok(applied[0][1].signal instanceof AbortSignal, 'the request signal reaches the command so a cancel reverts');
  assert.deepEqual(Object.keys(applied[1][1]).sort(), [
    'apply',
    'applyThenVerify',
    'applyThenVerifyTimeoutSec',
    'repoPath',
    'signal',
    'unsafePolicyOnlyVerifier',
  ]);
  assert.equal(applied[1][1].applyThenVerifyTimeoutSec, 30);
  assert.equal(applied[1][1].unsafePolicyOnlyVerifier, true);
  assert.equal(applied[2][1].verifiedBy, 'ran npm test in the primary');
  assert.equal(applied[2][1].applyThenVerify, 'npm test');
  assert.deepEqual(
    applied[3],
    ['j', { repoPath: undefined, apply: true, verifiedBy: 'ran npm test in the primary' }],
    'a plain apply keeps its exact option shape',
  );
  for (let id = 6; id <= 15; id += 1) assert.equal(values.find((value) => value.id === id).result.isError, true, `call ${id}`);
  for (const id of [13, 14]) assert.match(JSON.stringify(values.find((value) => value.id === id)), /require applyThenVerify/);
  await server.close();
});
test('MCP exposes the bounded log window on offload_job, forwards it only when supplied, and names FAILED continuation', async () => {
  const input = new PassThrough(),
    output = new PassThrough();
  let wire = '';
  output.on('data', (value) => {
    wire += value;
  });
  const jobs = [];
  const server = createMcpServer(
    {
      job: async (...value) => {
        jobs.push(value);
        return {};
      },
    },
    { input, output },
  );
  const call = (id, arguments_) =>
    input.write(
      `${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'offload_job', arguments: arguments_ } })}\n`,
    );
  input.write('{"jsonrpc":"2.0","id":0,"method":"initialize","params":{}}\n');
  input.write('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n');
  call(2, { jobId: 'j', include: 'log', tail: 5, limit: 3000 });
  call(3, { jobId: 'j', include: 'log' });
  call(4, { jobId: 'j', include: 'log', tail: 0, limit: 2000 });
  for (const [id, extra] of [
    [5, { tail: -1 }],
    [6, { tail: 1001 }],
    [7, { tail: '5' }],
    [8, { tail: 1.5 }],
    [9, { limit: 100 }],
    [10, { limit: 60001 }],
    [11, { limit: '3000' }],
    [12, { lines: 5 }],
  ])
    call(id, { jobId: 'j', include: 'log', ...extra });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const values = responseValues(wire);
  const tools = values.find((value) => value.id === 1).result.tools;
  const { properties, additionalProperties } = tools.find((candidate) => candidate.name === 'offload_job').inputSchema;
  assert.deepEqual([properties.tail.type, properties.tail.minimum, properties.tail.maximum], ['integer', 0, 1000]);
  assert.deepEqual([properties.limit.type, properties.limit.minimum, properties.limit.maximum], ['integer', 2000, 60000]);
  assert.equal(additionalProperties, false);
  assert.equal(jobs.length, 3, 'every misuse is rejected before core.job');
  assert.deepEqual(jobs[0], ['j', { repoPath: undefined, include: 'log', tail: 5, limit: 3000 }]);
  assert.deepEqual(jobs[1], ['j', { repoPath: undefined, include: 'log' }], 'an omitted window is not passed as undefined');
  assert.deepEqual(jobs[2], ['j', { repoPath: undefined, include: 'log', tail: 0, limit: 2000 }], 'zero is a real request');
  for (let id = 5; id <= 12; id += 1) assert.equal(values.find((value) => value.id === id).result.isError, true, `call ${id}`);
  const description = tools.find((candidate) => candidate.name === 'offload_continue').description;
  assert.match(
    description,
    /FAILED in a worker-side way \(a repeated failing tool call, ending without finish, exhausting output-cap recovery, or putting finish in a turn with other tool calls twice\)/,
  );
  assert.match(description, /Refused for provider or protocol failures, scope violations/);
  assert.match(tools.find((candidate) => candidate.name === 'offload_job').description, /`toolFailure`/);
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
    assert.match(discovery.instructions, /profile "flash"/);
    assert.match(discovery.instructions, /policy-only/);
    assert.match(discovery.instructions, /Do not invent a “latest Flash” model/);
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
    /provider-maintained DeepSeek V4\.1 Flash route/,
  );
  assert.match(
    list.tools.find((tool) => tool.name === 'offload_start').inputSchema.properties.profile.description,
    /explicitly selected configured profile overrides/,
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
    /A mention, quotation, negation, or discussion of `\/offload`, offload, delegation, \*\*DeepSeek\*\* \/ \*\*DeepSeek-V4\.1-Flash\*\*, a provider, or a model does not select Offload/,
  );
  assert.match(expectedText, /A standalone instruction not to use native subagents does not trigger Offload/);
  assert.match(expectedText, /For a `\/offload` command invocation, end every final answer/);
  assert.match(expectedText, /explicitly set `profile: "flash"`/);
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
test('MCP explicit unattended mode omits Claude forced-approval metadata', async () => {
  const child = spawn(process.execPath, ['bin/offload.mjs', 'mcp'], {
    cwd: process.cwd(),
    env: { ...process.env, OFFLOAD_MCP_APPROVAL_MODE: 'approve' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
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
  child.stdin.write('{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}\n');
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`MCP tool list timed out: ${stderr}`)), 3_000);
    const watch = () => {
      if (stdout.includes('"id":2')) {
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
  const tools = responseValues(stdout).find((value) => value.id === 2).result.tools;
  for (const name of ['offload_start', 'offload_repair', 'offload_continue', 'offload_apply', 'offload_revert', 'offload_cancel'])
    assert.equal(
      Object.hasOwn(
        tools.find((tool) => tool.name === name),
        '_meta',
      ),
      false,
      `${name} must not force a Claude approval`,
    );
});

test('MCP records every tool call, including failures, in the diagnostic log', async () => {
  const input = new PassThrough(),
    output = new PassThrough();
  output.resume();
  const records = [];
  createMcpServer(
    {
      start: async () => ({ jobId: 'oj-1' }),
      wait: async () => {
        throw Object.assign(new Error('wait exploded'), { code: 'E_TEST' });
      },
    },
    { input, output, log: { record: (entry) => records.push(entry) } },
  );
  const call = (id, name, args) =>
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })}\n`);
  input.write('{"jsonrpc":"2.0","id":0,"method":"initialize","params":{}}\n');
  call(1, 'offload_start', { task: 'secret task text', mode: 'report' });
  call(2, 'offload_wait', { jobId: 'oj-1' });
  await new Promise((r) => setTimeout(r, 50));
  const ok = records.find((r) => r.tool === 'offload_start');
  assert.equal(ok.ok, true);
  assert.equal(ok.jobId, 'oj-1');
  assert.ok(ok.argKeys.includes('task'));
  assert.doesNotMatch(JSON.stringify(records), /secret task text/);
  const failed = records.find((r) => r.tool === 'offload_wait');
  assert.equal(failed.ok, false);
  assert.equal(failed.error.message, 'wait exploded');
  assert.equal(failed.error.code, 'E_TEST');
  assert.match(failed.runtime, /node v/);
  input.end();
});
test('MCP exposes the job list options, forwards only supplied values, and keeps them away from a single-job read', async () => {
  const input = new PassThrough(),
    output = new PassThrough();
  let wire = '';
  output.on('data', (value) => {
    wire += value;
  });
  const jobs = [];
  const server = createMcpServer(
    {
      job: async (...value) => {
        jobs.push(value);
        return {};
      },
    },
    { input, output },
  );
  const call = (id, arguments_) =>
    input.write(
      `${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'offload_job', arguments: arguments_ } })}\n`,
    );
  input.write('{"jsonrpc":"2.0","id":0,"method":"initialize","params":{}}\n');
  input.write('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n');
  call(60, { all: true, maxJobs: 5 });
  call(61, {});
  call(62, { all: false });
  call(63, { all: 'true' });
  call(64, { maxJobs: 0 });
  call(65, { maxJobs: 101 });
  call(66, { maxJobs: 1.5 });
  call(67, { jobId: 'j', all: true });
  call(68, { jobId: 'j', maxJobs: 5 });
  call(69, { jobId: 'j', all: false });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const values = responseValues(wire);
  const tool = values.find((value) => value.id === 1).result.tools.find((candidate) => candidate.name === 'offload_job');
  assert.deepEqual(tool.inputSchema.properties.all, { type: 'boolean' });
  assert.deepEqual(tool.inputSchema.properties.maxJobs, { type: 'integer', minimum: 1, maximum: 100 });
  assert.equal(tool.inputSchema.required?.includes('all') ?? false, false);
  assert.match(tool.description, /workingTree/);
  assert.match(tool.description, /all:true/);
  assert.match(tool.description, /totalCostUsd/);
  assert.deepEqual(jobs, [
    [undefined, { repoPath: undefined, include: undefined, all: true, maxJobs: 5 }],
    [undefined, { repoPath: undefined, include: undefined }],
    [undefined, { repoPath: undefined, include: undefined, all: false }],
  ]);
  for (const id of [63, 64, 65, 66, 67, 68, 69]) assert.equal(values.find((value) => value.id === id).result.isError, true, `call ${id}`);
  assert.match(JSON.stringify(values.find((value) => value.id === 67)), /apply only when jobId is omitted/);
  assert.match(JSON.stringify(values.find((value) => value.id === 69)), /apply only when jobId is omitted/);
  await server.close();
});
test('MCP routes include "retrospective" to the digest, forwards only the jobs asked for, and refuses what has no meaning for it', async () => {
  const input = new PassThrough(),
    output = new PassThrough();
  let wire = '';
  output.on('data', (value) => {
    wire += value;
  });
  const seen = [];
  const server = createMcpServer(
    {
      retrospective: async (options) => (seen.push(['retrospective', options]), { maintainerPromptWarranted: false }),
      job: async (...value) => (seen.push(['job', ...value]), {}),
    },
    { input, output },
  );
  const call = (id, arguments_) =>
    input.write(
      `${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'offload_job', arguments: arguments_ } })}\n`,
    );
  input.write('{"jsonrpc":"2.0","id":0,"method":"initialize","params":{}}\n');
  input.write('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n');
  call(70, { include: 'retrospective' });
  call(71, { include: 'retrospective', jobIds: ['oj-1', 'oj-2'], repoPath: '/repo' });
  call(72, { include: 'summary' });
  const refused = [
    { include: 'retrospective', jobId: 'oj-1' },
    { include: 'retrospective', all: true },
    { include: 'retrospective', maxJobs: 5 },
    { include: 'retrospective', tail: 5 },
    { include: 'retrospective', limit: 2000 },
    { include: 'retrospective', verifierInterpreter: ['/opt/venv'] },
    { jobIds: ['oj-1'] },
    { jobId: 'oj-1', include: 'diff', jobIds: ['oj-1'] },
    { include: 'retrospective', jobIds: [] },
    { include: 'retrospective', jobIds: Array.from({ length: 17 }, (_, index) => `oj-${index}`) },
    { include: 'retrospective', jobIds: ['bad id'] },
    { include: 'retrospective', jobIds: 'oj-1' },
    { include: 'retro' },
  ];
  refused.forEach((arguments_, index) => call(80 + index, arguments_));
  await new Promise((resolve) => setTimeout(resolve, 60));
  const values = responseValues(wire);
  const tool = values.find((value) => value.id === 1).result.tools.find((candidate) => candidate.name === 'offload_job');
  assert.deepEqual(tool.inputSchema.properties.include.enum, ['summary', 'diff', 'files', 'log', 'retrospective']);
  assert.equal(tool.inputSchema.properties.jobIds.maxItems, 16);
  assert.equal(tool.inputSchema.properties.jobIds.items.pattern, '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$');
  assert.equal(tool.annotations.readOnlyHint, true, 'a digest changes no job, so it needs no approval');
  assert.match(tool.description, /include "retrospective"/);
  assert.match(tool.description, /maintainerPromptSkeleton/);
  assert.deepEqual(seen, [
    ['retrospective', { repoPath: undefined }],
    ['retrospective', { repoPath: '/repo', jobIds: ['oj-1', 'oj-2'] }],
    ['job', undefined, { repoPath: undefined, include: 'summary' }],
  ]);
  assert.equal(values.find((value) => value.id === 70).result.isError, false);
  refused.forEach((arguments_, index) =>
    assert.equal(values.find((value) => value.id === 80 + index).result.isError, true, JSON.stringify(arguments_)),
  );
  assert.match(JSON.stringify(values.find((value) => value.id === 80)), /jobId does not apply to include \\"retrospective\\"/);
  assert.match(JSON.stringify(values.find((value) => value.id === 86)), /jobIds apply only to include \\"retrospective\\"/);
  await server.close();
});
test('the skill tells the primary to load deferred tools, what the snapshot includes, and how health and the list behave', async () => {
  const text = await readFile(new URL('../../plugins/offload/skills/offload/SKILL.md', import.meta.url), 'utf8');
  const section = (from, to) => {
    const start = text.indexOf(from);
    const end = text.indexOf(to, start + from.length);
    assert.ok(start >= 0 && end > start, `${from} .. ${to}`);
    return text.slice(start, end);
  };
  const preflight = section('## 0. Preflight', '## 1. Understand');
  const tools = ['job', 'start', 'wait', 'continue', 'apply', 'repair', 'revert', 'cancel'].map((name) => `mcp__offload__offload_${name}`);
  // One ToolSearch select naming every tool, in the first paragraph of the preflight.
  assert.ok(preflight.includes(`select:${tools.join(',')}`), 'the select query must name all eight tools');
  assert.ok(
    preflight.indexOf('ToolSearch') < preflight.indexOf('Call `offload_job` with no arguments'),
    'loading comes before the first call',
  );
  assert.match(preflight, /A tool that is merely not loaded is not unavailable/);
  assert.match(preflight, /^- `workingTree`: `clean`, counts \(`changed`, `staged`, `modified`, `untracked`, `conflicted`/m);
  assert.match(preflight, /^- `verifierTmp` \(`status`, `reason`, `systemTmp`, `gitInit`\)/m);
  assert.match(preflight, /`offload_job` with `all: true`/);
  assert.match(preflight, /`listing\.totalCostUsd`/);
  const intro = section('# Offload protocol', '## Routing contract');
  assert.match(intro, /staged and unstaged tracked changes, deletions, and untracked files that are not gitignored/);
  assert.match(intro, /Gitignored files are not copied/);
  assert.match(intro, /never contains your own uncommitted edits/);
  assert.match(section('## 4. Review', '## 5. Fix loop'), /a `spend across N jobs touched this session:` line/);
});
test('the skill names exactly the capabilities, tools, parameters and CLI flags the server provides', async () => {
  const text = await readFile(new URL('../../plugins/offload/skills/offload/SKILL.md', import.meta.url), 'utf8');
  const input = new PassThrough(),
    output = new PassThrough();
  let wire = '';
  output.on('data', (value) => {
    wire += value;
  });
  const server = createMcpServer({}, { input, output });
  input.write('{"jsonrpc":"2.0","id":0,"method":"initialize","params":{}}\n');
  input.write('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n');
  await new Promise((resolve) => setTimeout(resolve, 30));
  const tools = new Map(
    responseValues(wire)
      .find((value) => value.id === 1)
      .result.tools.map((tool) => [tool.name, tool.inputSchema.properties]),
  );
  await server.close();

  // Capabilities: the stale-server list is the five the preflight requires, every capability the skill
  // mentions is one the server reports, and every reported one is documented.
  const required = text.slice(text.indexOf('Health must expose'), text.indexOf('If any is missing'));
  assert.deepEqual([...required.matchAll(/server\.capabilities\.(\w+): true/g)].map((match) => match[1]).sort(), [
    'compactReports',
    'continueJob',
    'inputFiles',
    'lateApply',
    'reportMode',
  ]);
  const gated = [...text.matchAll(/server\.capabilities\.(\w+)/g)].map((match) => match[1]);
  for (const [name, value] of Object.entries(RUNTIME_CAPABILITIES)) {
    assert.equal(value, true, name);
    assert.ok(text.includes(`\`${name}\``) || text.includes(`server.capabilities.${name}`), `the skill never mentions capability ${name}`);
  }
  for (const name of gated) assert.equal(RUNTIME_CAPABILITIES[name], true, `the skill gates on ${name}, which the server does not report`);
  assert.ok(text.includes(`\`server.schemaRevision: ${IDENTITY_SCHEMA_REVISION}\``), 'the skill pins the revision the server reports');

  // Tools: the ToolSearch query names every tool the server lists, no more.
  const query = /`select:([^`]+)`/.exec(text)[1].split(',');
  assert.deepEqual(query.map((name) => name.replace('mcp__offload__', '')).sort(), [...tools.keys()].sort());

  // Parameters the skill tells the primary to pass are in the advertised schemas.
  const params = {
    offload_start: ['verifierMode', 'verifierTimeoutSec', 'verifierInterpreter', 'relevantPaths', 'budget'],
    offload_wait: ['timeoutSec', 'detail'],
    offload_job: ['include', 'jobIds', 'tail', 'limit', 'all', 'maxJobs', 'detail', 'verifierInterpreter'],
    offload_continue: ['extraTurns', 'extraUsd', 'note'],
    offload_apply: ['apply', 'verifiedBy', 'applyThenVerify', 'applyThenVerifyTimeoutSec', 'unsafePolicyOnlyVerifier'],
  };
  for (const [tool, names] of Object.entries(params))
    for (const name of names) {
      assert.ok(name in tools.get(tool), `${tool} does not accept ${name}`);
      assert.ok(text.includes(`\`${name}`), `the skill never mentions ${name}`);
    }
  for (const name of ['maxUsd', 'maxTurns', 'turnPolicy', 'timeoutMinutes']) assert.ok(text.includes(`budget.${name}`), `budget.${name}`);
  const budget = tools.get('offload_start').budget.properties;
  for (const name of ['maxUsd', 'maxTurns', 'turnPolicy', 'timeoutMinutes']) assert.ok(name in budget, `budget.${name}`);

  // CLI flags the skill documents are accepted, and an invented one is not.
  const run = async (argv) => {
    let stderr = '';
    const code = await runCli(argv, {
      core: {
        job: async () => ({}),
        start: async () => ({}),
        wait: async () => ({}),
        retrospective: async () => ({ maintainerPromptSkeleton: 'Improve Offload' }),
        retrospectiveHistory: async () => ({
          path: 'retrospectives.jsonl',
          records: [],
          aggregate: { retrospectives: 0, warranted: 0, signals: [] },
        }),
      },
      stdout: { write() {} },
      stderr: { write: (chunk) => (stderr += chunk) },
    });
    return { code, stderr };
  };
  for (const flag of ['--verifierMode', '--verifierTimeoutSec', '--verifierInterpreter'])
    assert.ok(text.includes(`\`${flag}\``), `the skill documents ${flag}`);
  assert.equal(
    (await run(['start', '--task', 'x', '--ownedPaths', '["a/**"]', '--verifierMode', 'baseline-diff', '--verifierTimeoutSec', '60'])).code,
    0,
  );
  assert.equal((await run(['start', '--task', 'x', '--ownedPaths', '["a/**"]', '--verifierInterpreter', '/opt/py/venv'])).code, 0);
  assert.equal(
    (await run(['start', '--task', 'x', '--ownedPaths', '["a/**"]', '--verifierInterpreter', '["/opt/py/a","/opt/py/b"]'])).code,
    0,
  );
  assert.equal((await run(['start', '--task', 'x', '--ownedPaths', '["a/**"]', '--verifierInterpreter', 'relative/venv'])).code, 2);
  assert.equal((await run(['job', '--verifierInterpreter', '/opt/py/venv'])).code, 0);
  assert.equal((await run(['job', 'oj-1', '--verifierInterpreter', '/opt/py/venv'])).code, 2, 'a job id and a health probe are exclusive');
  assert.ok(text.includes('--tail N --limit N'));
  assert.equal((await run(['job', 'oj-1', '--include', 'log', '--tail', '5', '--limit', '2000'])).code, 0);
  assert.equal((await run(['job', 'oj-1', '--include', 'log', '--tail', '5', '--bogus', '1'])).code, 2);
  // The retrospective: an include value of offload_job, a CLI command, and a step of the Completion gate.
  assert.ok(tools.get('offload_job').include.enum.includes('retrospective'));
  const gate = text.slice(text.indexOf('## 6. Completion gate'), text.indexOf('## Rules that do not bend'));
  assert.ok(
    gate.includes('`include: "retrospective"`') && gate.includes('`jobIds`'),
    'the gate fetches the digest for the jobs it started',
  );
  assert.ok(gate.includes('Maintainer prompt (paste into the Claude Code session that maintains Offload)'));
  assert.ok(gate.includes('`Offload retrospective: nothing to improve`'));
  assert.match(gate, /never edit the Offload repo, config or skill because of it/);
  assert.ok(gate.indexOf('Offload retrospective') < gate.indexOf('`Offload: N jobs`'), 'the routing line stays last');
  assert.ok(text.includes('cancel|retrospective` exist as shell subcommands'));
  assert.equal((await run(['retrospective'])).code, 0);
  assert.equal((await run(['retrospective', '--jobs', 'oj-1,oj-2'])).code, 0);
  assert.equal((await run(['retrospective', 'list'])).code, 0);
  assert.equal((await run(['retrospective', 'export', '--last', '5'])).code, 0);
  assert.equal((await run(['retrospective', '--bogus', '1'])).code, 2);
  assert.ok(text.includes('--detail compact'));
  assert.equal((await run(['wait', 'oj-1', '--detail', 'compact'])).code, 0);
});
