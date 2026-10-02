import test from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, win32 } from 'node:path';
import { doctor, doctorLive } from '../../src/doctor.mjs';
import { runCli } from '../../src/cli.mjs';

function sink() {
  let text = '';
  return {
    stream: new Writable({
      write(chunk, _, done) {
        text += chunk;
        done();
      },
    }),
    text: () => text,
  };
}

test('local doctor checks runtime, repository, config/key and registrations without a provider call', () => {
  const result = doctor({ root: process.cwd(), repoPath: process.cwd(), home: process.cwd() });
  assert.equal(typeof result.nodeOk, 'boolean');
  assert.equal(typeof result.git, 'boolean');
  assert.equal(result.repo.ok, true);
  assert.equal(typeof result.config.ok, 'boolean');
  assert.equal(typeof result.key.ok, 'boolean');
  assert.ok(['macos', 'policy-only'].includes(result.sandbox));
  assert.equal(result.sandboxSelfTest, undefined);
  assert.ok(['profile-applied', 'not-available'].includes(result.sandboxProbe));
});
test('doctor runs Git plumbing with a credential-free hardened environment', () => {
  const calls = [];
  const env = { PATH: '/usr/bin', HOME: '/private/home', OPENAI_API_KEY: 'must-not-reach-git', DEEPSEEK_API_KEY: 'also-private' };
  const spawnProcess = (command, args, options) => {
    calls.push({ command, args, options });
    return { status: 0, stdout: args.includes('--show-toplevel') ? `${process.cwd()}\n` : 'git version test' };
  };
  const result = doctor({ root: process.cwd(), repoPath: process.cwd(), home: process.cwd(), env, spawnProcess });
  assert.equal(result.git, true);
  assert.equal(result.repo.ok, true);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.command, 'git');
    assert.deepEqual(call.args.slice(0, 5), [
      '--no-optional-locks',
      '-c',
      'core.fsmonitor=false',
      '-c',
      `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`,
    ]);
    assert.equal(call.options.env.OPENAI_API_KEY, undefined);
    assert.equal(call.options.env.DEEPSEEK_API_KEY, undefined);
    assert.equal(call.options.env.GIT_TERMINAL_PROMPT, '0');
  }
});
test('doctor recognizes escaped Windows MCP registration paths', async () => {
  const home = await mkdtemp(join(tmpdir(), 'offload-doctor-home-'));
  const root = 'C:\\Program Files\\Offload';
  const bin = 'C:\\Program Files\\Offload\\bin\\offload.mjs';
  const claudeHome = join(home, 'relocated-claude');
  const codexHome = join(home, 'relocated-codex');
  const env = { CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: codexHome };
  await mkdir(claudeHome, { recursive: true });
  await mkdir(codexHome, { recursive: true });
  await mkdir(join(home, '.cursor'), { recursive: true });
  await writeFile(
    join(codexHome, 'config.toml'),
    `# offload managed MCP\n[mcp_servers.offload]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(bin)}, "mcp"]\nstartup_timeout_sec = 15\ntool_timeout_sec = 60\ndefault_tools_approval_mode = "writes"\n`,
  );
  await writeFile(
    join(claudeHome, '.claude.json'),
    JSON.stringify({ mcpServers: { offload: { type: 'stdio', command: process.execPath, args: [bin, 'mcp'], env: {} } } }),
  );
  await writeFile(
    join(home, '.cursor', 'mcp.json'),
    JSON.stringify({ mcpServers: { offload: { command: process.execPath, args: [bin, 'mcp'] } } }),
  );
  const result = doctor({ root, home, platform: 'win32', env });
  assert.deepEqual(result.registration, { codex: true, claude: true, cursor: true });
  assert.equal(result.sandbox, 'policy-only');
  assert.equal(win32.join(root, 'bin', 'offload.mjs'), bin);
});

function codexRegistration(
  bin,
  { command = process.execPath, args = [bin, 'mcp'], marker = true, approvalMode = 'writes', extra = '' } = {},
) {
  return `${marker ? '# offload managed MCP\n' : ''}[mcp_servers.offload]\ncommand = ${JSON.stringify(command)}\nargs = [${args.map(JSON.stringify).join(', ')}]\nstartup_timeout_sec = 15\ntool_timeout_sec = 60\ndefault_tools_approval_mode = ${JSON.stringify(approvalMode)}${extra}\n`;
}
function claudeRegistration(bin, { type = 'stdio', command = process.execPath, args = [bin, 'mcp'], env = {} } = {}) {
  return { mcpServers: { offload: { type, command, args, env } } };
}
function cursorRegistration(bin, { command = process.execPath, args = [bin, 'mcp'] } = {}) {
  return { mcpServers: { offload: { command, args } } };
}
test('doctor rejects non-canonical launch commands and arguments', async () => {
  const home = await mkdtemp(join(tmpdir(), 'offload-doctor-home-'));
  const root = await mkdtemp(join(tmpdir(), 'offload-doctor-root-'));
  const bin = join(root, 'bin', 'offload.mjs');
  const claudePath = join(home, '.claude.json'),
    codexPath = join(home, '.codex', 'config.toml'),
    cursorPath = join(home, '.cursor', 'mcp.json');
  await mkdir(dirname(codexPath), { recursive: true });
  await mkdir(dirname(cursorPath), { recursive: true });
  const writeGood = async () => {
    await writeFile(claudePath, JSON.stringify(claudeRegistration(bin)));
    await writeFile(codexPath, codexRegistration(bin));
    await writeFile(cursorPath, JSON.stringify(cursorRegistration(bin)));
  };
  const registration = () => doctor({ root, home }).registration;
  await writeGood();
  assert.deepEqual(registration(), { codex: true, claude: true, cursor: true });
  await writeFile(claudePath, JSON.stringify(claudeRegistration(bin, { command: 'node-not-offload' })));
  assert.equal(registration().claude, false);
  await writeGood();
  await writeFile(cursorPath, JSON.stringify(cursorRegistration(bin, { command: 'node-not-offload' })));
  assert.equal(registration().cursor, false);
  await writeGood();
  await writeFile(codexPath, codexRegistration(bin, { command: 'node-not-offload' }));
  assert.equal(registration().codex, false);
  await writeGood();
  await writeFile(claudePath, JSON.stringify(claudeRegistration(bin, { args: ['mcp', bin] })));
  assert.equal(registration().claude, false);
  await writeGood();
  await writeFile(cursorPath, JSON.stringify(cursorRegistration(bin, { args: [bin] })));
  assert.equal(registration().cursor, false);
  await writeGood();
  await writeFile(codexPath, codexRegistration(bin, { args: [bin] }));
  assert.equal(registration().codex, false);
  await writeGood();
  await writeFile(codexPath, codexRegistration(bin, { approvalMode: 'always' }));
  assert.equal(registration().codex, false);
});
test('doctor rejects an invalid Claude type and unsafe Codex table variants', async () => {
  const home = await mkdtemp(join(tmpdir(), 'offload-doctor-home-'));
  const root = await mkdtemp(join(tmpdir(), 'offload-doctor-root-'));
  const bin = join(root, 'bin', 'offload.mjs');
  const claudePath = join(home, '.claude.json'),
    codexPath = join(home, '.codex', 'config.toml');
  await mkdir(dirname(codexPath), { recursive: true });
  await writeFile(claudePath, JSON.stringify(claudeRegistration(bin)));
  const registration = () => doctor({ root, home }).registration;
  await writeFile(claudePath, JSON.stringify(claudeRegistration(bin, { type: 'sse' })));
  assert.equal(registration().claude, false);
  await writeFile(claudePath, JSON.stringify(claudeRegistration(bin)));
  await writeFile(
    codexPath,
    `${codexRegistration(bin)}[mcp_servers.offload]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(bin)}, "mcp"]\nstartup_timeout_sec = 15\ntool_timeout_sec = 60\ndefault_tools_approval_mode = "writes"\n`,
  );
  assert.equal(registration().codex, false);
  await writeFile(
    codexPath,
    '# offload managed MCP\n[mcp_servers.offload]\ncommand = "unterminated\nargs = []\nstartup_timeout_sec = 15\ntool_timeout_sec = 60\ndefault_tools_approval_mode = "writes"\n',
  );
  assert.equal(registration().codex, false);
  await writeFile(codexPath, codexRegistration(bin, { marker: false }));
  assert.equal(registration().codex, false);
  await writeFile(
    codexPath,
    '# offload managed MCP\n[mcp_servers.offload]\ncommand = "node"\nargs = []\nstartup_timeout_sec = 15\ntool_timeout_sec = 60\n',
  );
  assert.equal(registration().codex, false, 'missing approval mode is not a healthy managed registration');
});

async function liveConfig() {
  const dir = await mkdtemp(join(tmpdir(), 'offload-doctor-'));
  const configPath = join(dir, 'config.json');
  const pricingFile = join(dir, 'pricing.json');
  await writeFile(
    pricingFile,
    JSON.stringify({
      fetched_at: '2026-10-01',
      models: {
        mock: {
          usd_per_1m: {
            input_cache_hit: { off_peak: 0, peak: 0 },
            input_cache_miss: { off_peak: 1, peak: 1 },
            output: { off_peak: 1, peak: 1 },
          },
        },
      },
    }),
  );
  await writeFile(
    configPath,
    JSON.stringify({
      providers: { mock: { type: 'openai-chat', baseUrl: 'http://localhost', keyRef: 'env:DOCTOR_LIVE_KEY', pricingFile: 'pricing.json' } },
      profiles: { mock: { provider: 'mock', model: 'mock', effort: 'high' } },
      default: 'mock',
      limits: { maxTurns: 1, timeoutMinutes: 1, maxUsd: 1 },
    }),
  );
  return { configPath, env: { DOCTOR_LIVE_KEY: 'live-test-key' } };
}
const tool = (args = '{"ok":true}') => ({
  choices: [
    {
      delta: {
        tool_calls: [{ index: 0, id: 'doctor-call', type: 'function', function: { name: 'offload_doctor_echo', arguments: args } }],
      },
    },
  ],
});
const usage = (input, output) => ({
  choices: [{ delta: {} }],
  usage: { prompt_tokens: input, completion_tokens: output, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: input },
});
function scriptedFetch(scripts) {
  const requests = [];
  return {
    requests,
    fetchImpl: async (url, init) => {
      requests.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      const script = scripts.shift();
      if (script.status) return new Response('untrusted', { status: script.status });
      return new Response(`${script.chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`, {
        status: 200,
      });
    },
  };
}
test('live doctor uses two no-retry, pre-reserved synthetic requests and replays reasoning', async () => {
  const mock = scriptedFetch([
    { chunks: [{ model: 'mock', choices: [{ delta: { reasoning_content: 'mock reasoning' } }] }, tool(), usage(9, 1)] },
    { chunks: [{ model: 'mock', choices: [{ delta: { content: 'ok' } }] }, usage(13, 1)] },
  ]);
  const options = await liveConfig();
  const result = await doctorLive({ ...options, maxUsd: 0.02, fetchImpl: mock.fetchImpl });
  assert.equal(result.live, true);
  assert.equal(result.reasoningReplayed, true);
  assert.equal(result.first.returnedModel, 'mock');
  assert.equal(result.first.usage.inputTokens, 9);
  assert.equal(mock.requests.length, 2);
  assert.equal(mock.requests[0].headers.authorization, 'Bearer live-test-key');
  assert.equal(mock.requests[0].body.max_tokens, 32);
  assert.deepEqual(mock.requests[0].body.tool_choice, { type: 'function', function: { name: 'offload_doctor_echo' } });
  assert.equal(mock.requests[0].body.reasoning_effort, undefined);
  assert.deepEqual(mock.requests[0].body.thinking, { type: 'disabled' });
  assert.deepEqual(mock.requests[1].body.thinking, { type: 'disabled' });
  const replay = mock.requests[1].body.messages.find((message) => message.role === 'assistant');
  assert.equal(replay.reasoning_content, 'mock reasoning');
  assert.deepEqual(replay.tool_calls[0].function, { name: 'offload_doctor_echo', arguments: '{"ok":true}' });
  assert.ok(mock.requests[1].body.tools.length);
  assert.doesNotMatch(JSON.stringify(result), /live-test-key|mock reasoning|offload_doctor_echo once/);
});
test('live doctor refuses cap/usage failures and never retries an HTTP error', async () => {
  const mock = scriptedFetch([{ status: 401 }]);
  const options = await liveConfig();
  await assert.rejects(doctorLive({ ...options, maxUsd: 0.000001, fetchImpl: mock.fetchImpl }), /cap is insufficient/);
  assert.equal(mock.requests.length, 0);
  await assert.rejects(doctorLive({ ...options, maxUsd: 0.02, fetchImpl: mock.fetchImpl }), /HTTP 401/);
  assert.equal(mock.requests.length, 1);
  const malformed = scriptedFetch([{ chunks: [{ model: 'mock', choices: [{ delta: {} }] }] }]);
  await assert.rejects(doctorLive({ ...options, maxUsd: 0.02, fetchImpl: malformed.fetchImpl }), /exactly one usage/);
  assert.equal(malformed.requests.length, 1);
  await assert.rejects(doctorLive({ ...options, maxUsd: 0.021, fetchImpl: mock.fetchImpl }), /at most/);
});
test('live doctor reserves its disabled-thinking and forced-tool wire fields before the first request', async () => {
  const options = await liveConfig();
  const pricingFile = join(dirname(options.configPath), 'pricing.json');
  await writeFile(
    pricingFile,
    JSON.stringify({
      fetched_at: '2026-10-01',
      models: {
        mock: {
          usd_per_1m: {
            input_cache_hit: { off_peak: 0, peak: 0 },
            input_cache_miss: { off_peak: 10, peak: 10 },
            output: { off_peak: 10, peak: 10 },
          },
        },
      },
    }),
  );
  const mock = scriptedFetch([{ status: 401 }]);
  await assert.rejects(doctorLive({ ...options, maxUsd: 0.015, fetchImpl: mock.fetchImpl }), /cap is insufficient/);
  assert.equal(mock.requests.length, 0);
});
test('live doctor rejects a returned model outside its reservation before a follow-up request', async () => {
  const mock = scriptedFetch([
    { chunks: [{ model: 'substituted-model', choices: [{ delta: { reasoning_content: 'ignore' } }] }, tool(), usage(1, 1)] },
  ]);
  const options = await liveConfig();
  await assert.rejects(doctorLive({ ...options, maxUsd: 0.02, fetchImpl: mock.fetchImpl }), /not authorized by its reservation/);
  assert.equal(mock.requests.length, 1);
});
test('live doctor rejects conflicting model metadata within one streamed response', async () => {
  const mock = scriptedFetch([
    {
      chunks: [
        { model: 'mock', choices: [{ delta: { reasoning_content: 'ignore' } }] },
        tool(),
        { model: 'substituted-model', ...usage(1, 1) },
      ],
    },
  ]);
  const options = await liveConfig();
  await assert.rejects(doctorLive({ ...options, maxUsd: 0.02, fetchImpl: mock.fetchImpl }), /conflicting model metadata/);
  assert.equal(mock.requests.length, 1);
});
test('live doctor refuses an oversized local pricing file before contacting a provider', async () => {
  const options = await liveConfig();
  const oversized = join(dirname(options.configPath), 'pricing.json');
  await writeFile(oversized, ' '.repeat(1024 * 1024 + 1));
  const mock = scriptedFetch([]);
  await assert.rejects(doctorLive({ ...options, maxUsd: 0.02, fetchImpl: mock.fetchImpl }), /pricing file is unavailable/);
  assert.equal(mock.requests.length, 0);
});
test('ordinary doctor never contacts the configured provider and CLI requires a live cap', async () => {
  const options = await liveConfig();
  doctor({ root: process.cwd(), configPath: options.configPath, repoPath: process.cwd(), home: process.cwd() });
  const out = sink(),
    err = sink();
  const code = await runCli(['doctor', '--live'], { core: { job: async () => ({}) }, stdout: out.stream, stderr: err.stream });
  assert.equal(code, 2);
  assert.match(err.text(), /requires --maxUsd/);
  assert.equal(out.text(), '');
});
test('explicit false doctor flags do not enable a live request or hook-only output', async () => {
  const out = sink(),
    err = sink();
  const code = await runCli(['doctor', '--live=false', '--hook=false'], {
    core: { job: async () => ({ health: {} }) },
    stdout: out.stream,
    stderr: err.stream,
  });
  assert.equal(code, 0);
  assert.equal(err.text(), '');
  const result = JSON.parse(out.text());
  assert.equal(result.live, undefined);
  assert.equal(typeof result.nodeOk, 'boolean');
});
