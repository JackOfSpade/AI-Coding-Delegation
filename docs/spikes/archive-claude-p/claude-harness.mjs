// claude-harness.mjs - spawn the REAL `claude -p` against mock-anthropic.mjs, hermetically.
//
// What "hermetic" means here (all verified, see README.md):
//  - the child env is built from scratch (NOT process.env): when this runs inside a Claude Code
//    session the parent env carries ANTHROPIC_BASE_URL, CLAUDE_CODE_OAUTH_*, CLAUDE_CODE_MESSAGING_*,
//    CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH... which would leak into the child.
//  - CLAUDE_CONFIG_DIR and HOME are fresh temp dirs (never the real ~/.claude).
//  - ANTHROPIC_BASE_URL points at the mock; auth is a dummy key/token.
//  - CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 silences the telemetry / bootstrap / MCP-registry
//    calls that otherwise go to api.anthropic.com (hard-coded, not derived from ANTHROPIC_BASE_URL).
//  - HTTPS_PROXY/HTTP_PROXY point at a local "canary" sink that refuses (403) and records every
//    CONNECT it sees, so a test can assert that nothing tried to leave the machine.
//  - on macOS, when sandbox-exec exists, the child additionally runs under a profile that denies all
//    outbound network except loopback and denies writes to the real ~/.claude and ~/.claude.json.

import { spawn, execFileSync } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, mkdirSync, existsSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir, homedir, platform } from 'node:os';
import { join, delimiter } from 'node:path';

// Deliberately not credential-shaped, so repository secret scans remain useful.
export const DUMMY_KEY = 'mock-api-key-for-local-test-only';
export const DUMMY_TOKEN = 'dummy-auth-token-not-real';

/** Locate the claude binary: $CLAUDE_BIN, then ~/.local/bin/claude, then PATH. Returns null if absent. */
export function findClaude() {
  const candidates = [process.env.CLAUDE_BIN, join(homedir(), '.local', 'bin', 'claude')].filter(Boolean);
  for (const p of (process.env.PATH || '').split(delimiter)) candidates.push(join(p, 'claude'));
  return (
    candidates.find((p) => {
      try {
        return existsSync(p);
      } catch {
        return false;
      }
    }) ?? null
  );
}

export const sandboxAvailable = () => platform() === 'darwin' && existsSync('/usr/bin/sandbox-exec');

/** macOS sandbox profile: loopback-only network, and no writes to the user's real Claude state. */
export function sandboxProfile(home = homedir()) {
  const esc = home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [
    '(version 1)',
    '(allow default)',
    '(deny network-outbound)',
    '(allow network-outbound (remote ip "localhost:*"))',
    `(deny file-write* (subpath "${home}/.claude") (regex #"^${esc}/\\.claude\\.json"))`,
  ].join('\n');
}

/** A local HTTP proxy that refuses everything and records what was attempted: `hosts` = ['CONNECT host:443', ...]. */
export async function startCanaryProxy() {
  const attempts = [];
  const server = http.createServer((req, res) => {
    attempts.push(`HTTP ${req.method} ${req.url}`);
    res.writeHead(403);
    res.end();
  });
  server.on('connect', (req, sock) => {
    attempts.push(`CONNECT ${req.url}`);
    sock.end('HTTP/1.1 403 Forbidden\r\n\r\n');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    attempts,
    close: () =>
      new Promise((r) => {
        server.close(() => r());
        server.closeAllConnections?.();
      }),
  };
}

/** Fresh scratch dir (real path, so it matches what claude reports for cwd). */
export function makeScratch(prefix = 'dsw-mock-') {
  return realpathSync(mkdtempSync(join(process.env.DSW_TMPDIR || tmpdir(), prefix)));
}

/** A throwaway git repo with one commit. Returns its path. */
export function makeTempRepo(parent = makeScratch(), files = { 'README.md': '# temp repo\n' }) {
  const repo = join(parent, 'repo');
  mkdirSync(repo, { recursive: true });
  const genv = { PATH: process.env.PATH, HOME: parent, GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...a) =>
    execFileSync('git', ['-c', 'user.name=Mock', '-c', 'user.email=mock@example.invalid', '-c', 'commit.gpgsign=false', ...a], {
      cwd: repo,
      env: genv,
      stdio: 'ignore',
    });
  git('init', '-q', '-b', 'main');
  for (const [name, content] of Object.entries(files)) writeFileSync(join(repo, name), content);
  git('add', '-A');
  git('commit', '-q', '-m', 'initial');
  return repo;
}

/**
 * Build the child env from scratch. `auth`: 'api-key' (ANTHROPIC_API_KEY -> `x-api-key` header) or
 * 'auth-token' (ANTHROPIC_AUTH_TOKEN -> `Authorization: Bearer`).
 */
export function hermeticEnv({ configDir, homeDir, baseUrl, auth = 'api-key', token, proxyUrl, extra = {} }) {
  const env = {
    PATH: process.env.PATH,
    HOME: homeDir,
    CLAUDE_CONFIG_DIR: configDir,
    ANTHROPIC_BASE_URL: baseUrl,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };
  if (auth === 'api-key') env.ANTHROPIC_API_KEY = token ?? DUMMY_KEY;
  else if (auth === 'auth-token') env.ANTHROPIC_AUTH_TOKEN = token ?? DUMMY_TOKEN;
  else if (auth !== 'none') throw new Error(`unknown auth ${auth}`);
  if (proxyUrl) {
    for (const k of ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy']) env[k] = proxyUrl;
    env.NO_PROXY = env.no_proxy = '127.0.0.1,localhost,::1';
  }
  for (const [k, v] of Object.entries(extra)) {
    if (v === null || v === undefined) delete env[k];
    else env[k] = String(v);
  }
  return env;
}

/**
 * Run `claude -p` once against the mock and collect everything.
 *
 * @param {object} o
 * @param {{url:string}} o.mock                 a startMock() handle (or pass `baseUrl`)
 * @param {string} o.prompt
 * @param {string} [o.cwd]                       defaults to a fresh temp git repo
 * @param {'api-key'|'auth-token'|'none'} [o.auth='api-key']
 * @param {string} [o.token]                     dummy credential (default constant)
 * @param {string[]} [o.allowedTools]            e.g. ['Write','Edit','Bash(git status*)']
 * @param {string} [o.permissionMode='dontAsk']
 * @param {string[]} [o.args]                    extra CLI args (appended)
 * @param {object} [o.env]                       extra env; null/undefined deletes a key
 * @param {boolean|'auto'} [o.sandbox='auto']    macOS sandbox-exec loopback-only profile
 * @param {number} [o.timeoutMs=60000]
 * @param {boolean} [o.canary=true]              route proxy-aware traffic to a refusing sink and report attempts
 *                                               (canary:false => no proxy env; claude then also sends `HEAD /api/hello` to the mock)
 * @param {string[]} [o.cliArgs]                 replace the whole default argv (after the binary) - for probing flag behaviour
 * @param {'ignore'|'pipe-open'} [o.stdin='ignore']  'pipe-open' reproduces the open-stdin-pipe gotcha (3s stall + warning)
 */
export async function runClaude(o) {
  const claudeBin = o.claudeBin ?? findClaude();
  if (!claudeBin) throw new Error('claude binary not found (set CLAUDE_BIN)');
  const scratch = o.scratch ?? makeScratch();
  const cwd = o.cwd ?? makeTempRepo(scratch);
  const configDir = o.configDir ?? join(scratch, 'claude-config');
  const homeDir = o.homeDir ?? join(scratch, 'home');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  const canary = o.canary === false ? null : await startCanaryProxy();
  const env = hermeticEnv({
    configDir,
    homeDir,
    baseUrl: o.baseUrl ?? o.mock.url,
    auth: o.auth,
    token: o.token,
    proxyUrl: canary?.url,
    extra: o.env,
  });

  let cli = o.cliArgs;
  if (!cli) {
    cli = ['-p', o.prompt, '--output-format', 'stream-json', '--verbose', '--permission-mode', o.permissionMode ?? 'dontAsk'];
    if (o.allowedTools?.length) cli.push('--allowedTools', ...o.allowedTools);
    cli.push(...(o.args ?? []));
  }

  const useSandbox = (o.sandbox ?? 'auto') === 'auto' ? sandboxAvailable() : !!o.sandbox;
  const [cmd, argv] = useSandbox ? ['/usr/bin/sandbox-exec', ['-p', sandboxProfile(), claudeBin, ...cli]] : [claudeBin, cli];

  const started = Date.now();
  // stdin MUST NOT be an open pipe: claude waits 3s ("no stdin data received") before proceeding.
  const child = spawn(cmd, argv, { cwd, env, stdio: [o.stdin === 'pipe-open' ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => {
    stdout += d;
  });
  child.stderr.on('data', (d) => {
    stderr += d;
  });
  let timedOut = false;
  const killer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 3000).unref();
  }, o.timeoutMs ?? 60000);
  const [code, signal] = await new Promise((resolve) => child.on('close', (c, s) => resolve([c, s])));
  clearTimeout(killer);
  const attempts = canary ? [...canary.attempts] : [];
  await canary?.close();

  const events = [];
  const rawLines = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      rawLines.push(line);
    }
  }
  const result = events.find((e) => e.type === 'result');
  return {
    code,
    signal,
    timedOut,
    durationMs: Date.now() - started,
    stdout,
    stderr,
    events,
    rawLines,
    init: events.find((e) => e.type === 'system' && e.subtype === 'init'),
    result,
    text: result?.result,
    scratch,
    cwd,
    configDir,
    homeDir,
    env,
    sandboxed: useSandbox,
    outsideAttempts: attempts, // proxy-visible attempts to reach anything but the mock
    command: [cmd, ...argv],
  };
}
