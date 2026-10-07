import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sandboxAvailable } from '../../src/sandbox.mjs';
import { createMockOpenAIServer } from '../mock-openai-server.mjs';

// Every scenario here drives the real server entry point (`offload mcp`, a
// stdio JSON-RPC peer) against the mock provider, a real private worktree and,
// where noted, the real macOS verifier sandbox. Nothing below calls Core or
// JobManager directly, so a parameter that the MCP schema does not forward, or
// a health field the server does not report, fails here.
const MACOS_SANDBOX_SKIP_REASON = 'requires an available macOS sandbox';
// Windows has no verifier sandbox and keeps its integrity root in the Credential Locker; its CLI, MCP and
// installer behavior is covered through injected platform adapters elsewhere, so this POSIX suite skips there.
const WINDOWS_SKIP_REASON = 'the POSIX stdio end-to-end suite does not run on Windows';
const windowsSkip = process.platform === 'win32' && WINDOWS_SKIP_REASON;
const HOMEBREW_NODE = process.platform === 'darwin' && process.execPath.startsWith('/opt/homebrew/');
const sandboxSkip = () => (!HOMEBREW_NODE ? 'requires a Homebrew Node on macOS' : !sandboxAvailable() ? MACOS_SANDBOX_SKIP_REASON : false);

const modelChunk = (delta) => ({ model: 'mock-model', choices: [{ delta }] });
const usage = (prompt = 100_000, completion = 10_000) => ({
  model: 'mock-model',
  choices: [{ delta: {} }],
  usage: { prompt_tokens: prompt, completion_tokens: completion },
});
// One scripted provider response: a single tool call, then usage.
const turn = (name, args, id = `${name}-${Math.random().toString(36).slice(2, 8)}`) => ({
  chunks: [modelChunk({ tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }), usage()],
});
const finish = (summary = 'done') => turn('finish', { summary, concerns: [], testsRun: [] }, `finish-${summary}`);
const writeFileTurn = (path, content) => turn('write_file', { path, content });
// One provider response with several tool calls: [name, args, id] each.
const calls = (...entries) => ({
  chunks: [
    modelChunk({
      tool_calls: entries.map(([name, args, id], index) => ({
        index,
        id,
        type: 'function',
        function: { name, arguments: JSON.stringify(args) },
      })),
    }),
    usage(),
  ],
});
const FINISH_ALONE =
  'TOOL_ERROR: finish must be the only tool call in its turn; nothing in this turn was executed; call finish alone (re-issue other calls in a separate turn first if still needed)';

async function makeRepo(files = {}) {
  const path = await mkdtemp(join(tmpdir(), 'offload-mcp-e2e-repo-'));
  execFileSync('git', ['init', '-q', path]);
  execFileSync('git', ['-C', path, 'config', 'user.email', 'offload@example.test']);
  execFileSync('git', ['-C', path, 'config', 'user.name', 'Offload Test']);
  for (const [name, content] of Object.entries({ 'README.md': 'base\n', ...files })) {
    await mkdir(dirname(join(path, name)), { recursive: true });
    await writeFile(join(path, name), content);
  }
  execFileSync('git', ['-C', path, 'add', '-A']);
  execFileSync('git', ['-C', path, 'commit', '-qm', 'base']);
  return path;
}

/** A private HOME whose config points the default profile at the mock provider and prices every token. */
async function makeHome(server, limits = { maxTurns: 80, timeoutMinutes: 30, maxUsd: 2 }) {
  const home = await mkdtemp(join(tmpdir(), 'offload-mcp-e2e-home-'));
  const configDir = join(home, 'config', 'offload');
  await mkdir(configDir, { recursive: true });
  const price = { off_peak: 1, peak: 1 };
  await writeFile(
    join(configDir, 'pricing.json'),
    JSON.stringify({
      fetched_at: '2026-10-01',
      models: {
        'mock-model': {
          usd_per_1m: { input_cache_hit: { off_peak: 0, peak: 0 }, input_cache_miss: price, output: { off_peak: 2, peak: 2 } },
        },
      },
    }),
  );
  await writeFile(
    join(configDir, 'config.json'),
    JSON.stringify({
      providers: {
        mock: {
          type: 'openai-chat',
          baseUrl: server.baseUrl,
          keyRef: 'env:OFFLOAD_E2E_KEY',
          pricingFile: 'pricing.json',
          attemptTimeoutMs: 30_000,
        },
      },
      profiles: { mock: { provider: 'mock', model: 'mock-model' } },
      default: 'mock',
      limits,
    }),
  );
  return home;
}

/** A minimal MCP client over the real stdio server. */
function mcpClient(home) {
  const child = spawn(process.execPath, ['bin/offload.mjs', 'mcp'], {
    cwd: process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: join(home, 'config'),
      XDG_STATE_HOME: join(home, 'state'),
      OFFLOAD_E2E_KEY: 'e2e-key',
    },
  });
  let stderr = '',
    buffer = '',
    nextId = 1;
  const waiting = new Map();
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => (stderr += chunk));
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      waiting.get(message.id)?.(message);
      waiting.delete(message.id);
    }
  });
  const rpc = (method, params = {}, timeoutMs = 90_000) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => reject(new Error(`${method} timed out; stderr: ${stderr}`)), timeoutMs);
      waiting.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  const client = {
    async init() {
      const reply = await rpc('initialize');
      assert.ok(reply.result, JSON.stringify(reply));
      return client;
    },
    tools: async () => (await rpc('tools/list')).result.tools,
    /** The tool's structured result, or `{ isError: true, text }` when the server refused the call. */
    async call(name, args = {}) {
      const reply = await rpc('tools/call', { name, arguments: args });
      assert.ok(reply.result, JSON.stringify(reply));
      const text = reply.result.content?.[0]?.text ?? '';
      if (reply.result.isError) return { isError: true, text };
      return reply.result.structuredContent ?? text;
    },
    async close() {
      child.stdin.end();
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, 5_000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
  return client;
}

/** Runs `body` with a mock provider, a private home and a connected MCP server; skips where loopback is blocked. */
async function withServer(t, { repo, limits, scripts = [] }, body) {
  let server;
  try {
    server = await createMockOpenAIServer(scripts);
  } catch (error) {
    if (error.code === 'EPERM') {
      t.skip('loopback networking is unavailable in this sandbox');
      return;
    }
    throw error;
  }
  const home = await makeHome(server, limits);
  const path = repo ?? (await makeRepo());
  const clients = [];
  const open = async () => {
    const client = await mcpClient(home).init();
    clients.push(client);
    return client;
  };
  try {
    await body({ server, home, repo: path, open });
  } finally {
    for (const client of clients) await client.close();
    await server.close();
    await rm(home, { recursive: true, force: true });
    await rm(path, { recursive: true, force: true });
  }
}
const lines = (text) => String(text).split('\n');
// A source file edited under the running server (a maintainer working in this checkout) makes the server stale, which
// is its own health-level signal. These scenarios pin the job-level ones, and the verdict only when nothing drifted.
const jobSignals = (retro) => retro.signals.filter((signal) => signal.job);
const drifted = (retro) => Boolean(retro.health.serverStale || retro.health.skillStale);
const settled = async (mcp, jobId, repoPath, options = {}) => {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const result = await mcp.call('offload_wait', { jobId, repoPath, timeoutSec: 20, ...options });
    assert.ok(!result.isError, result.text);
    if (result.done) return result;
  }
  assert.fail(`job ${jobId} did not finish`);
};

test(
  'MCP e2e: preflight health reports the capabilities, verifier temp probe, dirty working tree and an empty session list',
  { skip: windowsSkip },
  async (t) => {
    await withServer(t, { scripts: [] }, async ({ repo, open }) => {
      const mcp = await open();
      const tools = (await mcp.tools()).map((tool) => tool.name).sort();
      assert.deepEqual(tools, [
        'offload_apply',
        'offload_cancel',
        'offload_continue',
        'offload_job',
        'offload_repair',
        'offload_revert',
        'offload_start',
        'offload_wait',
      ]);
      const clean = await mcp.call('offload_job', { repoPath: repo });
      assert.equal(clean.health.server.schemaRevision, 2);
      // Everything the skill's preflight and its conditional sections key off.
      for (const name of [
        'reportMode',
        'inputFiles',
        'continueJob',
        'lateApply',
        'failedApply',
        'compactReports',
        'baselineVerifier',
        'applyThenVerify',
        'budgetSizing',
        'failureDiagnostics',
        'timingBreakdown',
        'verifierInterpreter',
        'retrospective',
      ])
        assert.equal(clean.health.server.capabilities[name], true, name);
      assert.equal(typeof clean.health.sandboxReason, 'string');
      assert.equal(clean.health.server.stale, false);
      assert.equal(clean.health.worker, true);
      assert.deepEqual(clean.health.workingTree, {
        clean: true,
        changed: 0,
        staged: 0,
        modified: 0,
        untracked: 0,
        conflicted: 0,
        sample: [],
      });
      assert.ok(
        ['writable', 'unwritable', 'unknown', 'not-probed'].includes(clean.health.verifierTmp.status),
        JSON.stringify(clean.health.verifierTmp),
      );
      if (sandboxAvailable()) {
        assert.equal(clean.health.verifierTmp.status, 'writable');
        assert.equal(clean.health.verifierTmp.systemTmp, 'denied', 'the sandbox never widens /tmp');
      }
      assert.deepEqual(clean.jobs, []);
      assert.equal(clean.listing.scope, 'session');
      assert.equal(clean.listing.omitted, 0);

      // Dirty state is named in counts; a secret-shaped file is counted but never named.
      await writeFile(join(repo, 'README.md'), 'edited\n');
      await writeFile(join(repo, 'notes.txt'), 'uncommitted note\n');
      await writeFile(join(repo, '.env'), 'TOKEN=x\n');
      const dirty = (await mcp.call('offload_job', { repoPath: repo })).health.workingTree;
      assert.equal(dirty.clean, false);
      assert.equal(dirty.modified, 1);
      assert.equal(dirty.untracked, 2);
      assert.equal(dirty.changed, 3);
      // Porcelain-style entries (status code, then path).
      assert.deepEqual([...dirty.sample].sort(), ['?? notes.txt', ' M README.md'].sort());
      assert.ok(!JSON.stringify(dirty).includes('.env'), 'a secret-shaped name is never reported');
    });
  },
);

test(
  'MCP e2e: a new server session lists only its own jobs, all:true reaches the old ones, and spend is cumulative',
  { skip: windowsSkip },
  async (t) => {
    await withServer(t, { scripts: [finish('first'), finish('second')] }, async ({ repo, open }) => {
      const first = await open();
      const a = await first.call('offload_start', { task: 'one', ownedPaths: ['a/**'], repoPath: repo });
      const doneA = await settled(first, a.jobId, repo);
      assert.equal(doneA.status, 'DONE_UNVERIFIED');
      assert.ok(!doneA.report.includes('spend across'), 'one job in the session needs no total');
      const b = await first.call('offload_start', { task: 'two', ownedPaths: ['b/**'], repoPath: repo });
      const doneB = await settled(first, b.jobId, repo);
      // 100,000 input tokens at $1/M plus 10,000 output at $2/M, per job.
      assert.match(lines(doneB.report)[1], / · 1 turns · \$0\.12$/);
      const spend = lines(doneB.report).find((line) => line.startsWith('spend across '));
      assert.equal(spend, "spend across 2 jobs touched this session: $0.240 (each job's cumulative cost)");
      await first.close();

      const second = await open();
      const scoped = await second.call('offload_job', { repoPath: repo });
      assert.deepEqual(scoped.jobs, [], 'jobs of an earlier session are not preflight noise');
      assert.equal(scoped.listing.omittedByScope, 2);
      assert.equal(scoped.listing.omitted, 2);
      assert.equal(scoped.listing.totalCostUsd, 0);
      assert.equal(scoped.listing.storeCostUsd.toFixed(3), '0.240');
      const all = await second.call('offload_job', { repoPath: repo, all: true });
      assert.deepEqual(all.jobs.map((job) => job.jobId).sort(), [a.jobId, b.jobId].sort());
      assert.equal(all.listing.scope, 'all');
      assert.equal(all.listing.totalCostUsd.toFixed(3), '0.240');
      assert.deepEqual(
        all.jobs.map((job) => job.costUsd.toFixed(3)),
        ['0.120', '0.120'],
      );
      // Reading an old job does not make it part of this session's spend.
      const reread = await second.call('offload_wait', { jobId: a.jobId, repoPath: repo, timeoutSec: 0 });
      assert.ok(!reread.report.includes('spend across'));
      // The list options are enforced by the real schema, not just by the CLI.
      assert.equal((await second.call('offload_job', { repoPath: repo, jobId: a.jobId, all: true })).isError, true);
      assert.equal((await second.call('offload_job', { repoPath: repo, maxJobs: 0 })).isError, true);
    });
  },
);

test(
  'MCP e2e: the turn cap is sized from file size, a line range reaches the worker as an offset, and the worker sees the dirty snapshot',
  { skip: windowsSkip },
  async (t) => {
    const big = ('a'.repeat(79) + '\n').repeat(9_173).slice(0, 733_780);
    const repo = await makeRepo({ 'src/big.js': big });
    await writeFile(join(repo, 'README.md'), 'edited in primary\n');
    await writeFile(join(repo, 'notes.txt'), 'uncommitted note\n');
    const scripts = [
      turn('read_file', { path: 'notes.txt' }),
      turn('read_file', { path: 'README.md' }),
      finish('looked'),
      finish('ranged'),
    ];
    await withServer(t, { repo, limits: { maxTurns: 20, timeoutMinutes: 30, maxUsd: 2 }, scripts }, async ({ server, open }) => {
      const mcp = await open();
      const sized = await mcp.call('offload_start', {
        task: 'read the big file',
        ownedPaths: ['src/big.js'],
        relevantPaths: ['src/big.js'],
        repoPath: repo,
      });
      assert.equal(sized.budgetSizing.turnsSource, 'scaled');
      assert.equal(sized.budgetSizing.maxTurns, 54);
      assert.equal(sized.budgetSizing.recommendedTurns, 54);
      assert.deepEqual(sized.budgetSizing.files, [{ path: 'src/big.js', bytes: 733_780, readTurns: 31, ranged: false }]);
      const done = await settled(mcp, sized.jobId, repo, { detail: 'full' });
      assert.equal(done.status, 'DONE_UNVERIFIED');
      // The snapshot is the primary as it is now, dirty state included ...
      const toolReplies = server.requests[2].body.messages.filter((message) => message.role === 'tool').map((message) => message.content);
      assert.ok(
        toolReplies.some((content) => content.includes('uncommitted note')),
        'an untracked file is in the snapshot',
      );
      assert.ok(
        toolReplies.some((content) => content.includes('edited in primary')),
        'an uncommitted edit is in the snapshot',
      );
      // ... and the job diff is relative to it, so it never contains the primary's own edits.
      assert.equal((await mcp.call('offload_job', { jobId: sized.jobId, repoPath: repo, include: 'diff' })).diff, '');
      // Every worker brief carries the falsifiable-assertions rule.
      const system = server.requests[0].body.messages[0].content;
      assert.ok(system.split('\n').includes('Assertions must be falsifiable; no substring checks that match unrelated text.'));

      const ranged = await mcp.call('offload_start', {
        task: 'read a region',
        ownedPaths: ['src/big.js'],
        relevantPaths: ['src/big.js:100-160'],
        repoPath: repo,
      });
      assert.equal(ranged.budgetSizing.maxTurns, 20, 'a range shrinks the recommendation to the configured default');
      assert.equal(ranged.budgetSizing.turnsSource, 'default');
      assert.equal(ranged.budgetSizing.recommendedTurns, 18);
      assert.equal(ranged.budgetSizing.files[0].ranged, true);
      await settled(mcp, ranged.jobId, repo);
      const brief = server.requests[3].body.messages[0].content;
      // Line 100 starts after 99 lines of 80 bytes: the worker is told where to begin reading.
      assert.ok(
        brief.split('\n').includes('- src/big.js:100-160 (read_file offset 7920, about 1 read; read outside the range only if needed)'),
        brief,
      );
      assert.ok(brief.includes('Entries suffixed :START-END are caller-selected line ranges'));
      // A malformed range is refused at the protocol boundary, before any job exists.
      const bad = await mcp.call('offload_start', { task: 'x', ownedPaths: ['src/**'], relevantPaths: ['src/big.js:9-1'], repoPath: repo });
      assert.equal(bad.isError, true);
      assert.match(bad.text, /relevantPaths/);
      // An explicit cap is honored exactly and warned about, never silently raised.
      const capped = await mcp.call('offload_start', {
        task: 'capped',
        ownedPaths: ['src/big.js'],
        relevantPaths: ['src/big.js'],
        budget: { maxTurns: 30 },
        repoPath: repo,
      });
      assert.equal(capped.budgetSizing.maxTurns, 30);
      assert.equal(capped.budgetSizing.turnsSource, 'caller');
      assert.match(capped.budgetSizing.warnings.join('\n'), /maxTurns 30 is below the recommended 54/);
      await mcp.call('offload_cancel', { jobId: capped.jobId, repoPath: repo });
      await settled(mcp, capped.jobId, repo);
    });
  },
);

test(
  'MCP e2e: a looping worker FAILS with its last failing call, the log is bounded by tail and limit, and offload_continue resumes it',
  { skip: windowsSkip },
  async (t) => {
    const missing = (n) => turn('read_file', { path: 'src/missing.js' }, `read-missing-${n}`);
    const scripts = [writeFileTurn('src/new.js', 'export const n = 1;\n'), missing(1), missing(2), missing(3), finish('resumed')];
    await withServer(t, { scripts }, async ({ server, repo, open }) => {
      const mcp = await open();
      const started = await mcp.call('offload_start', { task: 'loop on a missing file', ownedPaths: ['src/**'], repoPath: repo });
      const failed = await settled(mcp, started.jobId, repo);
      assert.equal(failed.status, 'FAILED');
      assert.equal(failed.failureKind, 'tool-loop');
      assert.equal(failed.toolFailure.tool, 'read_file');
      assert.equal(failed.toolFailure.repeats, 3);
      const failing = lines(failed.report).find((line) => line.startsWith('last failing tool call: '));
      assert.ok(failing.startsWith('last failing tool call: read_file {"path":"src/missing.js"} (turn 4, failed 3x) -- ENOENT'), failing);
      assert.ok(failing.includes('<worktree>/src/missing.js'), 'the path is shown without the machine directory');
      assert.ok(!failing.includes(repo), 'the primary path never reaches the report');
      assert.match(failed.report, /next: .*\bcontinue\b/);

      // The whole log, as a maintainer debugging this job would ask for it: the failing call is named
      // in the digest (so nothing is left to diagnose) and in the failure event itself, and the three
      // identical failing turns are one line instead of twelve.
      const whole = await mcp.call('offload_job', { jobId: started.jobId, repoPath: repo, include: 'log', tail: 1_000, limit: 60_000 });
      const digestText = whole.log.slice(whole.log.indexOf('DIGEST ') + 7, whole.log.indexOf('\n---\nEVENTS'));
      const digest = JSON.parse(digestText);
      assert.equal(digest.needsDiagnosis, undefined, 'the failing call is known');
      assert.deepEqual(
        [digest.lastFailingCall.tool, digest.lastFailingCall.args, digest.lastFailingCall.turn, digest.lastFailingCall.repeats],
        ['read_file', '{"path":"src/missing.js"}', 4, 3],
      );
      assert.equal(digest.lastFailingCall.error, "ENOENT: no such file or directory, lstat '<worktree>/src/missing.js'");
      const section = whole.log.slice(whole.log.indexOf('\nEVENTS (raw') + 1).split('\n');
      assert.match(section[0], /^EVENTS \(raw, oldest first; 12 repeated progress events folded into 1 repeat line\)$/);
      const entries = section
        .slice(1)
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      const repeat = entries.find((entry) => entry.type === 'progress-repeat');
      assert.match(repeat.repeat, /^\[provider_request_pending > provider_usage > tool > read_file\] x3 \(\S+\.\.\S+\)$/);
      assert.deepEqual([repeat.events, repeat.turns], [12, '2..4']);
      assert.equal(whole.logInfo.rawLines, digest.eventCount);
      assert.equal(whole.logInfo.lines, entries.length);
      assert.equal(entries.length, digest.eventCount - 12 + 1);
      assert.equal(entries.filter((entry) => entry.type === 'progress').length, 4 + 1, 'the write turn and the last bare event stay raw');
      // The failure event itself is the last line and carries the call, redacted and bounded.
      const finished = entries.at(-1);
      assert.equal(finished.type, 'finished');
      assert.equal(finished.failureKind, 'tool-loop');
      assert.deepEqual(
        [finished.toolFailure.tool, finished.toolFailure.args, finished.toolFailure.error],
        ['read_file', '{"path":"src/missing.js"}', "ENOENT: no such file or directory, lstat '<worktree>/src/missing.js'"],
      );
      assert.ok(!whole.log.includes(repo), 'no directory of this machine is in the log');
      // The compact summary a primary reads first names it too.
      const summary = await mcp.call('offload_job', { jobId: started.jobId, repoPath: repo });
      assert.ok(summary.report.includes('last failing tool call: read_file {"path":"src/missing.js"} (turn 4, failed 3x)'), summary.report);

      // The log is bounded by default and by explicit tail/limit, behind a digest repeating the call.
      const bounded = await mcp.call('offload_job', { jobId: started.jobId, repoPath: repo, include: 'log' });
      assert.deepEqual([bounded.logInfo.tail, bounded.logInfo.limit], [60, 16_000], 'the documented defaults');
      assert.ok(bounded.log.length <= 16_000);
      assert.ok(bounded.log.includes('"lastFailingCall"'), 'the digest names the failing call');
      const narrow = await mcp.call('offload_job', { jobId: started.jobId, repoPath: repo, include: 'log', tail: 2, limit: 2_000 });
      assert.deepEqual([narrow.logInfo.tail, narrow.logInfo.limit], [2, 2_000]);
      assert.ok(narrow.log.length <= 2_000, `the window is a hard bound (${narrow.log.length})`);
      assert.ok(narrow.logInfo.shown <= 2 && narrow.logInfo.shown < bounded.logInfo.shown);
      assert.equal(narrow.logInfo.truncated, true);
      assert.ok(narrow.log.includes('"lastFailingCall"'), 'the smallest window still names the failing call');
      assert.equal(
        (await mcp.call('offload_job', { jobId: started.jobId, repoPath: repo, tail: 5 })).isError,
        true,
        'tail needs include log',
      );
      assert.equal((await mcp.call('offload_job', { jobId: started.jobId, repoPath: repo, include: 'log', limit: 10 })).isError, true);
      assert.equal((await mcp.call('offload_job', { jobId: started.jobId, repoPath: repo, include: 'log', tail: 1001 })).isError, true);

      const resumed = await mcp.call('offload_continue', { jobId: started.jobId, repoPath: repo, note: 'read src/new.js instead' });
      assert.ok(!resumed.isError, resumed.text);
      const done = await settled(mcp, started.jobId, repo);
      assert.equal(done.status, 'DONE_UNVERIFIED');
      const prompt = server.requests.at(-1).body.messages.at(-1).content;
      assert.ok(prompt.includes('Do NOT repeat that call'));
      assert.ok(prompt.includes('read src/new.js instead'));
      assert.ok(!prompt.includes('ENOENT'), 'the recorded error stays with the primary');
      assert.equal(
        (await mcp.call('offload_job', { jobId: started.jobId, repoPath: repo, include: 'diff' })).diff.includes('src/new.js'),
        true,
      );
    });
  },
);

test(
  'MCP e2e: finish in a turn with other calls runs none of them, is corrected once, and the job still succeeds',
  { skip: windowsSkip },
  async (t) => {
    const done = { summary: 'done', concerns: [], testsRun: [] };
    const scripts = [
      writeFileTurn('src/a.js', 'export const a = 1;\n'),
      calls(['write_file', { path: 'src/b.js', content: 'export const b = 2;\n' }, 'write-b'], ['finish', done, 'finish-mixed']),
      finish('clean'),
    ];
    await withServer(t, { scripts }, async ({ server, repo, open }) => {
      const mcp = await open();
      const started = await mcp.call('offload_start', { task: 'finish too early', ownedPaths: ['src/**'], repoPath: repo });
      const result = await settled(mcp, started.jobId, repo, { detail: 'full' });
      assert.equal(result.status, 'DONE_UNVERIFIED', JSON.stringify(result));
      assert.equal(result.failureKind, undefined);
      assert.equal(server.requests.length, 3, 'one provider call for the correction, none beyond it');
      // The retry request answered both calls of the rejected turn, in order, with the fixed text.
      const messages = server.requests[2].body.messages;
      const rejected = messages.at(-3);
      assert.deepEqual(
        rejected.tool_calls.map((entry) => entry.id),
        ['write-b', 'finish-mixed'],
      );
      assert.deepEqual(
        messages.slice(-2).map((message) => [message.role, message.tool_call_id, message.content]),
        [
          ['tool', 'write-b', FINISH_ALONE],
          ['tool', 'finish-mixed', FINISH_ALONE],
        ],
      );
      const diff = (await mcp.call('offload_job', { jobId: started.jobId, repoPath: repo, include: 'diff' })).diff;
      assert.ok(diff.includes('src/a.js'), 'the earlier turn landed');
      assert.ok(!diff.includes('src/b.js'), 'the write beside the finish never ran');
      assert.match(lines(result.report)[1], / · 3 turns · /, 'the correction turn counted against the turn budget');
    });
  },
);

test(
  'MCP e2e: a repeated finish-protocol violation FAILS with its own kind, keeps the work, and offload_continue tells the worker to call finish alone',
  { skip: windowsSkip },
  async (t) => {
    const done = { summary: 'done', concerns: [], testsRun: [] };
    const scripts = [
      writeFileTurn('src/a.js', 'export const a = 1;\n'),
      calls(['write_file', { path: 'src/b.js', content: 'export const b = 2;\n' }, 'write-b'], ['finish', done, 'finish-1']),
      calls(['finish', done, 'finish-2'], ['read_file', { path: 'src/a.js' }, 'read-a']),
      finish('resumed'),
    ];
    await withServer(t, { scripts }, async ({ server, repo, open }) => {
      const mcp = await open();
      const started = await mcp.call('offload_start', { task: 'finish too early', ownedPaths: ['src/**'], repoPath: repo });
      const failed = await settled(mcp, started.jobId, repo);
      assert.equal(failed.status, 'FAILED');
      assert.equal(failed.failureKind, 'finish-protocol');
      assert.ok(lines(failed.report).includes('error: finish must be the sole valid tool call in a turn'), failed.report);
      assert.equal(failed.toolFailure, undefined, 'no tool call failed: none ran');
      assert.equal(server.requests.length, 3, 'bounded: the second violation is final, not retried');
      assert.match(failed.report, /next: .*\bcontinue\b/);
      const diff = (await mcp.call('offload_job', { jobId: started.jobId, repoPath: repo, include: 'diff' })).diff;
      assert.ok(diff.includes('src/a.js') && !diff.includes('src/b.js'), 'the finished work is kept, the refused write is not there');
      const log = (await mcp.call('offload_job', { jobId: started.jobId, repoPath: repo, include: 'log' })).log;
      assert.match(log, /"failureKind": "finish-protocol"/);

      const resumed = await mcp.call('offload_continue', { jobId: started.jobId, repoPath: repo, note: 'nothing else is left' });
      assert.ok(!resumed.isError, resumed.text);
      const finished = await settled(mcp, started.jobId, repo);
      assert.equal(finished.status, 'DONE_UNVERIFIED', JSON.stringify(finished));
      const request = server.requests.at(-1).body.messages;
      const prompt = request.at(-1);
      assert.equal(prompt.role, 'user');
      assert.ok(prompt.content.includes('call finish ALONE: finish must be the only tool call in its turn'));
      assert.ok(prompt.content.includes('nothing else is left'));
      // The corrected turn is in the conversation with its answers; the fatal one was never stored.
      const turnIds = request
        .filter((message) => message.role === 'assistant' && message.tool_calls)
        .map((message) => message.tool_calls.map((entry) => entry.id));
      assert.equal(turnIds.length, 2);
      assert.match(turnIds[0][0], /^write_file-/);
      assert.deepEqual(turnIds[1], ['write-b', 'finish-1']);
      assert.ok(!JSON.stringify(request).includes('finish-2'));
    });
  },
);

test(
  'MCP e2e: a job that FAILED the finish protocol after correct work is applied through offload_apply (dry run first) and reverted by offload_revert',
  { skip: windowsSkip },
  async (t) => {
    const done = { summary: 'done', concerns: [], testsRun: [] };
    const scripts = [
      writeFileTurn('src/a.js', 'export const a = 1;\n'),
      calls(['write_file', { path: 'src/b.js', content: 'export const b = 2;\n' }, 'write-b'], ['finish', done, 'finish-1']),
      calls(['finish', done, 'finish-2'], ['read_file', { path: 'src/a.js' }, 'read-a']),
    ];
    await withServer(t, { scripts }, async ({ repo, open }) => {
      const mcp = await open();
      const started = await mcp.call('offload_start', { task: 'finish too early', ownedPaths: ['src/**'], repoPath: repo });
      const failed = await settled(mcp, started.jobId, repo);
      assert.equal(failed.status, 'FAILED');
      assert.equal(failed.failureKind, 'finish-protocol');
      assert.match(failed.report, /next: .*apply \(after your own check\)/, 'the report lists apply for the failed job');
      assert.equal(existsSync(join(repo, 'src', 'a.js')), false, 'a FAILED job is not integrated automatically');

      const dry = await mcp.call('offload_apply', { jobId: started.jobId, repoPath: repo });
      assert.deepEqual(dry, {
        dryRun: true,
        applied: false,
        files: ['src/a.js'],
        fromStatus: 'FAILED',
        failure: { kind: 'finish-protocol', reason: 'finish must be the sole valid tool call in a turn' },
      });
      assert.equal(existsSync(join(repo, 'src', 'a.js')), false, 'a dry run never writes');
      const unvouched = await mcp.call('offload_apply', { jobId: started.jobId, repoPath: repo, apply: true });
      assert.equal(unvouched.isError, true);
      assert.match(unvouched.text, /verifiedBy must state the check you ran/);

      const applied = await mcp.call('offload_apply', {
        jobId: started.jobId,
        repoPath: repo,
        apply: true,
        verifiedBy: 'read src/a.js and ran node --check src/a.js in the primary: exit 0',
      });
      assert.equal(applied.isError, undefined, applied.text);
      assert.equal(applied.applied, true);
      assert.equal(applied.previousStatus, 'FAILED');
      assert.equal(applied.status, 'DONE_UNVERIFIED');
      assert.equal(await readFile(join(repo, 'src', 'a.js'), 'utf8'), 'export const a = 1;\n');
      assert.equal(existsSync(join(repo, 'src', 'b.js')), false, 'only the work that landed is applied');
      const summary = await mcp.call('offload_job', { jobId: started.jobId, repoPath: repo, detail: 'full' });
      assert.equal(summary.status, 'DONE_UNVERIFIED');
      assert.match(
        summary.report,
        /applied WITHOUT server verification \(was FAILED; original failure: finish-protocol: finish must be the sole valid tool call in a turn\); primary's own check: read src\/a\.js and ran node --check/,
      );
      // The refusal for a second apply is explicit, and revert works on the applied job.
      const again = await mcp.call('offload_apply', { jobId: started.jobId, repoPath: repo, apply: true, verifiedBy: 'again, by hand' });
      assert.equal(again.isError, true);
      assert.match(again.text, /already applied/);
      assert.equal((await mcp.call('offload_revert', { jobId: started.jobId, repoPath: repo })).dryRun, true);
      const reverted = await mcp.call('offload_revert', { jobId: started.jobId, repoPath: repo, apply: true });
      assert.equal(reverted.applied, true);
      assert.equal(existsSync(join(repo, 'src', 'a.js')), false, 'the reverse patch removed the applied file');
    });
  },
);

test(
  'MCP e2e: a stalled provider request raises one advisory, polls collapse to unchanged, and the terminal report splits the wall clock',
  { skip: windowsSkip },
  async (t) => {
    const scripts = [
      writeFileTurn('src/a.js', 'export const a = 1;\n'),
      // The second request is held open (no response at all) well past the provider's warning threshold, half of
      // the 30 s attempt limit. Only stallMs: with stallAfterChunks too the mock would arm a second timer that
      // nothing clears after the cancel, and keep the test process alive for its whole length.
      { chunks: [], stallMs: 120_000 },
    ];
    await withServer(t, { scripts }, async ({ repo, open }) => {
      const mcp = await open();
      const started = await mcp.call('offload_start', { task: 'stall', ownedPaths: ['src/**'], repoPath: repo });
      // Poll until the advisory appears (about 15 s into the held request); an unchanged poll collapses to a marker.
      let waiting;
      for (let attempt = 0; attempt < 12 && !waiting?.progress?.stall; attempt += 1)
        waiting = await mcp.call('offload_wait', { jobId: started.jobId, repoPath: repo, timeoutSec: 5 });
      assert.equal(waiting.done, false);
      // Level 1 from half the 30 s attempt limit, level 2 from 90% of it; a very slow host may poll late.
      assert.ok([1, 2].includes(waiting.progress.stall.level), JSON.stringify(waiting.progress.stall));
      assert.equal(waiting.progress.stall.kind, 'provider');
      assert.ok(waiting.progress.stall.sinceSec >= 15, JSON.stringify(waiting.progress.stall));
      assert.ok(waiting.progress.stall.longestProviderSec >= 15);
      assert.equal(waiting.progress.phase.kind, 'provider');
      const again = await mcp.call('offload_wait', { jobId: started.jobId, repoPath: repo, timeoutSec: 0 });
      assert.equal(again.unchanged, true, 'the same stall is not repeated in full');
      assert.ok(again.progress.stalledSec >= 15);
      const summary = await mcp.call('offload_job', { jobId: started.jobId, repoPath: repo });
      assert.equal(summary.stall.kind, 'provider');
      assert.ok(lines(summary.report).some((line) => line.startsWith('stall: ')));
      // The list row of a running job: what it is for, when its round began, how long it has run so far.
      const running = (await mcp.call('offload_job', { repoPath: repo })).jobs.find((job) => job.jobId === started.jobId);
      assert.equal(running.task, 'stall');
      assert.equal(running.running, true);
      assert.ok(running.durationSec >= 15, `${running.durationSec}s so far`);
      assert.ok(Number.isFinite(Date.parse(running.startedAt)));
      assert.equal('finishedAt' in running, false, 'an active job has not finished');
      assert.equal(running.costUsd, 0.12, 'the spend so far, from the one answered request');
      // The same stall reaches the retrospective as a signal while the round is still open.
      const live = await mcp.call('offload_job', { repoPath: repo, include: 'retrospective' });
      const stall = live.signals.find((signal) => signal.code === 'stall-warning');
      assert.equal(stall.job, started.jobId);
      assert.match(stall.evidence, /RUNNING: provider stall level [12] for \d+s/);

      await mcp.call('offload_cancel', { jobId: started.jobId, repoPath: repo });
      const done = await settled(mcp, started.jobId, repo, { detail: 'full' });
      assert.equal(done.status, 'CANCELLED');
      // Cancelling is the primary's own call: the retrospective keeps it as context, never as a reason for a prompt.
      const cancelled = await mcp.call('offload_job', { repoPath: repo, include: 'retrospective' });
      assert.ok(cancelled.signals.some((signal) => signal.code === 'cancelled-by-user' && signal.attributable === false));
      const finished = (await mcp.call('offload_job', { repoPath: repo })).jobs.find((job) => job.jobId === started.jobId);
      assert.ok(
        Number.isFinite(Date.parse(finished.finishedAt)) && finished.durationSec >= running.durationSec && !('running' in finished),
      );
      const time = lines(done.report).find((line) => line.startsWith('time: '));
      assert.match(time, /provider \d/, time);
      const [round] = done.timing.rounds;
      assert.ok(round.providerMs >= 15_000, `the stalled request is booked as provider time (${round.providerMs}ms)`);
      assert.equal(round.activeMs, round.startupMs + round.providerMs + round.toolMs + round.verifyMs + round.finalizeMs + round.otherMs);
    });
  },
);

test(
  'MCP e2e: a suite with a hard-coded /tmp test ends VERIFY_ENV_FAILED, and baseline-diff verifies it against the real per-run TMPDIR',
  { skip: sandboxSkip() },
  async (t) => {
    const repo = await makeRepo({
      'package.json': JSON.stringify({ private: true, type: 'module' }),
      'test/portable.test.mjs': [
        "import test from 'node:test';",
        "import assert from 'node:assert/strict';",
        "import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';",
        "import { tmpdir } from 'node:os';",
        "import { join } from 'node:path';",
        "test('portable temp dir works', () => {",
        "  const dir = mkdtempSync(join(tmpdir(), 'portable-'));",
        "  writeFileSync(join(dir, 'x'), 'ok');",
        "  assert.equal(readFileSync(join(dir, 'x'), 'utf8'), 'ok');",
        '});',
        '',
      ].join('\n'),
      'test/hardcoded.test.mjs': [
        "import test from 'node:test';",
        "import { mkdtempSync } from 'node:fs';",
        "test('hard-coded system temp', () => { mkdtempSync('/tmp/offload-hardcoded-'); });",
        '',
      ].join('\n'),
    });
    const command = 'node --test test/portable.test.mjs test/hardcoded.test.mjs';
    const scripts = [
      writeFileTurn('src/one.js', 'export const one = 1;\n'),
      finish('one'),
      writeFileTurn('src/two.js', 'export const two = 2;\n'),
      finish('two'),
    ];
    await withServer(t, { repo, scripts }, async ({ open }) => {
      const mcp = await open();
      const standard = await mcp.call('offload_start', {
        task: 'standard',
        ownedPaths: ['src/one.js'],
        testCommand: command,
        repoPath: repo,
      });
      const failed = await settled(mcp, standard.jobId, repo, { detail: 'full' });
      assert.equal(failed.status, 'VERIFY_ENV_FAILED', failed.report);
      assert.equal(failed.verifyEnvironment.kind, 'temp-dir-denied');
      assert.match(failed.report, /start with verifierMode "baseline-diff"/);
      // The temp-dir test that honors TMPDIR passed inside the same run: only the hard-coded one failed.
      assert.match(failed.report, /^ {2}\| ✔ portable temp dir works \(/m);
      assert.match(failed.report, /^ {2}\| ✖ hard-coded system temp \(/m);
      assert.equal(existsSync('/tmp/offload-hardcoded-'), false);

      const baseline = await mcp.call('offload_start', {
        task: 'baseline',
        ownedPaths: ['src/two.js'],
        testCommand: command,
        verifierMode: 'baseline-diff',
        verifierTimeoutSec: 120,
        repoPath: repo,
      });
      assert.equal(baseline.verifierMode, 'baseline-diff');
      const done = await settled(mcp, baseline.jobId, repo);
      assert.equal(done.status, 'DONE_VERIFIED', done.report);
      assert.match(done.report, /via baseline-diff: 1 pre-existing failure\(s\) tolerated, 0 new/);
      assert.match(done.report, /\(exit 1\)/, 'the real non-zero exit status stays visible');
      assert.equal(done.verifierMode, 'baseline-diff');
      // Integrated into the primary by the server.
      assert.equal(await readFile(join(repo, 'src', 'two.js'), 'utf8'), 'export const two = 2;\n');

      // The retrospective reads both outcomes off the real records: the environment failure is a finding, the
      // baseline-verified job (the real DONE_VERIFIED path) adds none, and a digest of it alone warrants no prompt.
      const retro = await mcp.call('offload_job', { repoPath: repo, include: 'retrospective' });
      const env = retro.signals.find((signal) => signal.code === 'verify-env-failed:temp-dir-denied');
      assert.deepEqual([env.job, env.attributable], [standard.jobId, true]);
      assert.match(env.evidence, /VERIFY_ENV_FAILED \(temp-dir-denied\) after 2 turns, \$0\.24, /);
      assert.equal(retro.maintainerPromptWarranted, true);
      assert.deepEqual(
        retro.reasons.filter((reason) => !/stale/.test(reason)),
        ['verify-env-failed:temp-dir-denied'],
      );
      assert.equal(retro.health.verifierTmp, 'writable');
      const clean = await mcp.call('offload_job', { repoPath: repo, include: 'retrospective', jobIds: [baseline.jobId] });
      assert.deepEqual(jobSignals(clean), []);
      assert.equal(clean.maintainerPromptWarranted, drifted(clean));
      assert.deepEqual([clean.jobs[0].status, clean.jobs[0].verdict, clean.scope], ['DONE_VERIFIED', 'PASS', 'jobs']);
    });
  },
);

test(
  'MCP e2e: offload_apply with applyThenVerify reverts on a failing check and keeps the diff on a passing one',
  { skip: sandboxSkip() },
  async (t) => {
    const scripts = [writeFileTurn('src/a.js', 'export const a = 1;\n'), finish('a')];
    await withServer(t, { scripts }, async ({ repo, open }) => {
      const mcp = await open();
      // A failing job check with no repair rounds leaves the diff reviewable but unapplied.
      const started = await mcp.call('offload_start', {
        task: 'write a',
        ownedPaths: ['src/**'],
        testCommand: 'test -f does-not-exist',
        maxRepairRounds: 0,
        repoPath: repo,
      });
      const failed = await settled(mcp, started.jobId, repo);
      assert.equal(failed.status, 'VERIFY_FAILED');
      assert.equal(existsSync(join(repo, 'src', 'a.js')), false);

      const dry = await mcp.call('offload_apply', { jobId: started.jobId, repoPath: repo });
      assert.ok(!dry.isError, dry.text);
      assert.equal(existsSync(join(repo, 'src', 'a.js')), false, 'a dry run changes nothing');
      assert.equal((await mcp.call('offload_apply', { jobId: started.jobId, repoPath: repo, apply: true })).isError, true, 'needs a check');
      assert.equal(
        (
          await mcp.call('offload_apply', {
            jobId: started.jobId,
            repoPath: repo,
            apply: true,
            verifiedBy: 'ran it',
            applyThenVerifyTimeoutSec: 30,
          })
        ).isError,
        true,
        'a timeout without a command is refused',
      );

      const rejected = await mcp.call('offload_apply', {
        jobId: started.jobId,
        repoPath: repo,
        apply: true,
        applyThenVerify: 'test -f src/not-there.js',
        applyThenVerifyTimeoutSec: 30,
      });
      assert.ok(!rejected.isError, rejected.text);
      assert.equal(rejected.applied, false);
      assert.equal(rejected.reverted, true);
      assert.equal(existsSync(join(repo, 'src', 'a.js')), false, 'the failing check left nothing behind');
      assert.equal(execFileSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' }), '');

      const accepted = await mcp.call('offload_apply', {
        jobId: started.jobId,
        repoPath: repo,
        apply: true,
        // The command sees the applied diff in the primary, read-only.
        applyThenVerify: 'test -f src/a.js',
        applyThenVerifyTimeoutSec: 30,
      });
      assert.ok(!accepted.isError, accepted.text);
      assert.equal(accepted.applied, true);
      assert.equal(accepted.status, 'DONE_UNVERIFIED', "never DONE_VERIFIED: the check is the primary's");
      assert.equal(await readFile(join(repo, 'src', 'a.js'), 'utf8'), 'export const a = 1;\n');
      const report = (await mcp.call('offload_job', { jobId: started.jobId, repoPath: repo, detail: 'full' })).report;
      assert.match(report, /test -f src\/a\.js/);
      assert.match(report, /not server-verified/i);
      // The revert path is the documented way back.
      const reverted = await mcp.call('offload_revert', { jobId: started.jobId, repoPath: repo, apply: true });
      assert.ok(!reverted.isError, reverted.text);
      assert.equal(existsSync(join(repo, 'src', 'a.js')), false);
    });
  },
);

test(
  'MCP e2e: a turn-cap BUDGET stop names the cap, keeps the work, and offload_continue raises only that cap',
  { skip: windowsSkip },
  async (t) => {
    const scripts = [
      writeFileTurn('src/a.js', 'export const a = 1;\n'),
      writeFileTurn('src/b.js', 'export const b = 2;\n'),
      finish('both'),
    ];
    await withServer(t, { scripts }, async ({ repo, open }) => {
      const mcp = await open();
      const started = await mcp.call('offload_start', {
        task: 'two files',
        ownedPaths: ['src/**'],
        budget: { maxTurns: 1, maxUsd: 1 },
        repoPath: repo,
      });
      assert.equal(started.budgetSizing.turnsSource, 'caller');
      const stopped = await settled(mcp, started.jobId, repo);
      assert.equal(stopped.status, 'BUDGET');
      assert.equal(stopped.budgetStop.cap, 'turns');
      const stop = lines(stopped.report).find((line) => line.startsWith('budget stop: '));
      assert.match(
        stop,
        /^budget stop: TURN cap reached \(1\/1 turns; \$0\.12 of \$1\.00 spent, \$0\.88 left\)\. Turns, not USD, stopped it: offload_continue with extraTurns only\.$/,
      );
      // The work is kept and a spent cap is not an invitation to repair: the next actions say so, and the server agrees.
      const next = lines(stopped.report).find((line) => line.startsWith('next: '));
      assert.match(next, /continue/);
      assert.doesNotMatch(next, /\brepair\b/);
      const repair = await mcp.call('offload_repair', { jobId: started.jobId, defects: ['keep going'], repoPath: repo });
      assert.equal(repair.isError, true);
      assert.match(repair.text, /cumulative job budget exhausted/);
      assert.match((await mcp.call('offload_job', { jobId: started.jobId, repoPath: repo, include: 'diff' })).diff, /src\/a\.js/);
      // Raising only the turn cap is enough; a bare continue (no increase for a BUDGET stop) is refused.
      const bare = await mcp.call('offload_continue', { jobId: started.jobId, repoPath: repo });
      assert.equal(bare.isError, true);
      assert.match(bare.text, /needs extraTurns and\/or extraUsd/);
      const resumed = await mcp.call('offload_continue', { jobId: started.jobId, repoPath: repo, extraTurns: 5, note: 'write src/b.js' });
      assert.ok(!resumed.isError, resumed.text);
      const done = await settled(mcp, started.jobId, repo);
      assert.equal(done.status, 'DONE_UNVERIFIED');
      const diff = (await mcp.call('offload_job', { jobId: started.jobId, repoPath: repo, include: 'diff' })).diff;
      assert.ok(diff.includes('src/a.js') && diff.includes('src/b.js'), 'both rounds are in the diff');
      assert.match(lines(done.report)[1], /^1 rounds · .* · 3 turns · \$0\.36$/, 'turns and cost stay cumulative across the continuation');
    });
  },
);

test(
  "MCP e2e: a worker's own run_command gets the per-run TMPDIR, so its test runs match the verifier, and still never /tmp",
  { skip: sandboxSkip() },
  async (t) => {
    const scripts = [
      turn('run_command', {
        command: `node -e "const fs=require('fs'),os=require('os'),p=require('path');fs.mkdtempSync(p.join(os.tmpdir(),'w-'));console.log('TMPDIR='+process.env.TMPDIR)"`,
      }),
      turn('run_command', { command: `node -e "require('fs').mkdtempSync('/tmp/w-')"` }),
      finish('probed'),
    ];
    await withServer(t, { scripts }, async ({ server, repo, open }) => {
      const mcp = await open();
      const started = await mcp.call('offload_start', { task: 'probe temp', ownedPaths: ['src/**'], repoPath: repo });
      assert.equal((await settled(mcp, started.jobId, repo)).status, 'DONE_UNVERIFIED');
      const [portable, hardcoded] = server.requests
        .at(-1)
        .body.messages.filter((message) => message.role === 'tool')
        .map((message) => JSON.parse(message.content));
      assert.equal(portable.code, 0, portable.stderr);
      assert.equal(portable.sandbox, 'macos');
      const temp = /^TMPDIR=(.+)$/m.exec(portable.stdout)[1];
      assert.ok(
        temp.startsWith(await realpath(tmpdir())) && temp.includes('offload-sandbox-'),
        `a disposable directory under the host temp (${temp})`,
      );
      assert.equal(hardcoded.code, 1);
      assert.match(hardcoded.stderr, /EPERM: operation not permitted, mkdtemp '\/tmp\/w-XXXXXX'/);
    });
  },
);

const OFFLOAD_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

test(
  'MCP e2e: the retrospective names a failed finish protocol and the hand apply, leaves a clean job alone, stays redacted and bounded, and feeds the local history',
  { skip: windowsSkip },
  async (t) => {
    const done = { summary: 'done', concerns: [], testsRun: [] };
    const scripts = [
      writeFileTurn('src/a.js', 'export const a = 1;\n'),
      calls(['write_file', { path: 'src/b.js', content: 'export const b = 2;\n' }, 'write-b'], ['finish', done, 'finish-1']),
      calls(['finish', done, 'finish-2'], ['read_file', { path: 'src/a.js' }, 'read-a']),
      writeFileTurn('lib/c.js', 'export const c = 3;\n'),
      finish('clean'),
    ];
    await withServer(t, { scripts }, async ({ home, repo, open }) => {
      const mcp = await open();
      const retrospective = (args = {}) => mcp.call('offload_job', { repoPath: repo, include: 'retrospective', ...args });
      // Not a job at all: nothing ran, so there is nothing to find, and the digest says so.
      const empty = await retrospective();
      assert.deepEqual([empty.totals.jobs, empty.signals, empty.maintainerPromptWarranted, empty.scope], [0, [], false, 'session']);

      const secret = 'sk-live0123456789abcdefghij';
      const bad = await mcp.call('offload_start', {
        profile: 'mock',
        task: `Fix the handling of ${secret} and API_KEY=hunter2hunter2 under ${repo}/src\nthen stop`,
        ownedPaths: ['src/**'],
        repoPath: repo,
      });
      const failed = await settled(mcp, bad.jobId, repo);
      assert.equal(failed.failureKind, 'finish-protocol');
      const first = await retrospective({ jobIds: [bad.jobId] });
      assert.deepEqual(
        jobSignals(first).map((signal) => [signal.code, signal.job, signal.attributable]),
        [['protocol-failure-finish', bad.jobId, true]],
      );
      assert.match(first.signals[0].evidence, /FAILED \(finish-protocol\) after 3 turns, \$0\.36, /);
      assert.equal(first.maintainerPromptWarranted, true);
      assert.deepEqual([first.scope, first.project], ['jobs', { repo: basename(repo), profile: 'mock' }]);
      assert.deepEqual(first.jobs[0].files, 1, 'the retained diff is counted, so the spend is not called wasted');

      const applied = await mcp.call('offload_apply', {
        jobId: bad.jobId,
        repoPath: repo,
        apply: true,
        verifiedBy: 'read src/a.js and ran node --check src/a.js in the primary: exit 0',
      });
      assert.equal(applied.status, 'DONE_UNVERIFIED', JSON.stringify(applied));
      const second = await retrospective({ jobIds: [bad.jobId] });
      assert.deepEqual(
        jobSignals(second)
          .map((signal) => signal.code)
          .sort(),
        ['apply-without-server-verification', 'protocol-failure-finish'],
      );
      assert.deepEqual(second.jobs[0].apply, { via: 'verifiedBy', from: 'FAILED' });
      assert.match(
        second.signals.find((signal) => signal.code === 'protocol-failure-finish').evidence,
        /job \S+ FAILED \(finish-protocol\)/,
      );

      const good = await mcp.call('offload_start', { task: 'add the c module', ownedPaths: ['lib/**'], profile: 'mock', repoPath: repo });
      assert.equal((await settled(mcp, good.jobId, repo)).status, 'DONE_UNVERIFIED');
      const clean = await retrospective({ jobIds: [good.jobId] });
      assert.deepEqual(jobSignals(clean), []);
      assert.equal(clean.maintainerPromptWarranted, drifted(clean));
      if (!drifted(clean)) {
        assert.deepEqual(clean.reasons, ['no Offload-attributable signal derived from this session']);
        assert.match(clean.maintainerPromptSkeleton, /\(the server derived no Offload-attributable signal; add what you observed\)/);
      }

      // The whole session: both jobs, the same spend the job list reports, a prompt skeleton in the user's shape.
      const session = await retrospective();
      const list = await mcp.call('offload_job', { repoPath: repo });
      assert.equal(session.scope, 'session');
      assert.deepEqual([session.totals.jobs, session.totals.costUsd], [2, list.listing.totalCostUsd]);
      for (const row of list.jobs) assert.equal(session.jobs.find((job) => job.id === row.jobId).costUsd, row.costUsd, row.jobId);
      assert.equal(session.maintainerPromptWarranted, true);
      const { maintainerPromptSkeleton: skeleton, ...digest } = session;
      const prompt = skeleton.split('\n');
      assert.deepEqual(prompt.slice(0, 3), [
        `Improve Offload based on one real session (repo: ${basename(repo)}, profile mock).`,
        `The Offload checkout to change is ${OFFLOAD_ROOT}.`,
        'Evidence:',
      ]);
      assert.ok(prompt.includes('Please:') && prompt.some((line) => /^1\. /.test(line)));
      assert.equal(prompt.at(-1), 'Add tests for each change, run the full suite, and report what you changed and verified.');
      assert.ok(prompt.some((line) => line.startsWith('- protocol-failure-finish: job ')));

      // No secret, source, diff, brief beyond one clipped line, or absolute path of this machine in the digest.
      const wire = JSON.stringify(digest);
      assert.ok(Buffer.byteLength(wire) <= 6144 && Buffer.byteLength(skeleton) <= 4096);
      for (const forbidden of [secret, 'hunter2hunter2', repo, home, 'export const a', 'write_file', 'then stop'])
        assert.ok(!wire.includes(forbidden) && !skeleton.includes(forbidden), `leaked ${forbidden}`);
      assert.ok(session.jobs.every((job) => job.task.length <= 100 && !job.task.includes('\n')));
      assert.ok(!skeleton.replace(OFFLOAD_ROOT, '').includes(home));

      // The request boundary: one digest over several jobs, nothing that belongs to a single job or a window.
      for (const args of [
        { jobId: bad.jobId },
        { all: true },
        { maxJobs: 5 },
        { tail: 5 },
        { jobIds: [] },
        { jobIds: [bad.jobId, bad.jobId] },
        { jobIds: ['no such job'] },
        { jobIds: [`oj-${'0'.repeat(40)}`] },
      ])
        assert.equal((await retrospective(args)).isError, true, JSON.stringify(args));
      const strayIds = await mcp.call('offload_job', { repoPath: repo, jobIds: [bad.jobId] });
      assert.equal(strayIds.isError, true);
      assert.match(strayIds.text, /jobIds apply only to include "retrospective"/);

      // Every successful digest left one bounded line in the local history, without the skeleton or the brief.
      const file = join(home, 'state', 'offload', 'retrospectives.jsonl');
      const records = (await readFile(file, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      assert.equal(records.length, 5, 'one per successful digest, none for a refused request');
      assert.ok(
        records.every((record) => record.v === 1 && !('maintainerPromptSkeleton' in record) && !JSON.stringify(record).includes(secret)),
      );
      assert.equal((await stat(file)).mode & 0o777, 0o600);
      const cli = (...args) =>
        execFileSync(process.execPath, [join(OFFLOAD_ROOT, 'bin', 'offload.mjs'), ...args], {
          cwd: repo,
          encoding: 'utf8',
          env: {
            ...process.env,
            HOME: home,
            XDG_CONFIG_HOME: join(home, 'config'),
            XDG_STATE_HOME: join(home, 'state'),
            OFFLOAD_E2E_KEY: 'e2e-key',
          },
        });
      const aggregate = JSON.parse(cli('retrospective', 'list'));
      assert.equal(aggregate.retrospectives, 5);
      assert.equal(aggregate.warranted, 3 + Number(drifted(clean)));
      const counted = Object.fromEntries(
        aggregate.signals.filter((row) => !row.code.startsWith('stale-')).map((row) => [row.code, row.retrospectives]),
      );
      assert.deepEqual(counted, { 'protocol-failure-finish': 3, 'apply-without-server-verification': 2 });
      assert.equal(JSON.parse(cli('retrospective', 'export', '--last', '2')).records.length, 2);
      // The terminal form prints the digest and then the skeleton, and records nothing itself.
      const printed = cli('retrospective', '--jobs', `${bad.jobId},${good.jobId}`);
      assert.ok(printed.includes('--- maintainer prompt skeleton (edit before pasting) ---\nImprove Offload based on one real session'));
      assert.equal(JSON.parse(printed.slice(0, printed.indexOf('\n\n---'))).totals.jobs, 2);
      assert.equal(JSON.parse(cli('retrospective', 'list')).retrospectives, 5);
    });
  },
);
