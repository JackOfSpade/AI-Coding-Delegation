#!/usr/bin/env node
/**
 * Live latency smoke for `offload complete` (spends real DeepSeek credit, a fraction of a cent).
 *
 *   node scripts/complete-latency-smoke.mjs [--turns 5] [--pauseMs 6000] [--route deepseek-flash]
 *
 * Runs deepseek-flash with reasoning disabled and stream: true, first as cold one-shot CLI
 * processes, then as turns of one warm `--serve` process (with a pause between turns longer than
 * Node fetch's default idle keep-alive). Prints, per call: overheadMs and firstTokenMs from the
 * result, and wall-clock ms from the request being written to the first delta line. Uses this
 * checkout's bin/offload.mjs and your normal Offload config and DeepSeek key.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};
const turns = Number(flag('turns', '5'));
const pauseMs = Number(flag('pauseMs', '6000'));
const route = flag('route', 'deepseek-flash');
const bin = fileURLToPath(new URL('../bin/offload.mjs', import.meta.url));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const request = (n) => ({
  route,
  messages: [
    { role: 'system', content: 'You are a friendly interviewer opening a practice interview. Reply in one short sentence.' },
    { role: 'user', content: `Start the interview (take ${n}).` },
  ],
  maxTokens: 60,
  reasoning: { enabled: false },
  timeoutMs: 30_000,
  caller: 'latency-smoke',
  tag: 'ttft',
  stream: true,
});

function lineReader(stream, onLine) {
  let buffered = '';
  stream.on('data', (chunk) => {
    buffered += chunk;
    let index;
    while ((index = buffered.indexOf('\n')) >= 0) {
      const text = buffered.slice(0, index);
      buffered = buffered.slice(index + 1);
      if (text.trim()) onLine(JSON.parse(text));
    }
  });
}

async function oneShot(n) {
  const spawnedAt = performance.now();
  const child = spawn(process.execPath, [bin, 'complete', '--stream'], { stdio: ['pipe', 'pipe', 'inherit'] });
  let firstDeltaAt;
  let result;
  lineReader(child.stdout, (line) => {
    if (line.type === 'delta') firstDeltaAt ??= performance.now();
    if (line.type === 'result') result = line;
  });
  child.stdin.end(JSON.stringify(request(n)));
  await new Promise((resolve) => child.on('exit', resolve));
  return { result, wallToFirstDeltaMs: firstDeltaAt === undefined ? null : Math.round(firstDeltaAt - spawnedAt) };
}

async function warm() {
  const child = spawn(process.execPath, [bin, 'complete', '--serve'], { stdio: ['pipe', 'pipe', 'inherit'] });
  const waiting = new Map();
  const firstDelta = new Map();
  lineReader(child.stdout, (line) => {
    if (line.type === 'delta' && !firstDelta.has(line.id)) firstDelta.set(line.id, performance.now());
    if (['ready', 'warm', 'result', 'error'].includes(line.type)) waiting.get(line.id ?? line.type)?.(line);
  });
  const next = (key) => new Promise((resolve) => waiting.set(key, resolve));
  const send = (line) => child.stdin.write(`${JSON.stringify(line)}\n`);
  await next('ready');
  const warmed = next('w');
  send({ type: 'warm', id: 'w', route });
  const warmLine = await warmed;
  const rows = [];
  for (let n = 1; n <= turns; n++) {
    if (n > 1) await pause(pauseMs);
    const id = `t${n}`;
    const done = next(id);
    const sentAt = performance.now();
    send({ id, ...request(n) });
    const result = await done;
    rows.push({ result, wallToFirstDeltaMs: firstDelta.has(id) ? Math.round(firstDelta.get(id) - sentAt) : null });
  }
  child.stdin.end();
  await new Promise((resolve) => child.on('exit', resolve));
  return { warmLine, rows };
}

const describe = ({ result, wallToFirstDeltaMs }) => ({
  ok: result?.ok,
  error: result?.error?.code,
  model: result?.model,
  overheadMs: result?.overheadMs,
  firstTokenMs: result?.firstTokenMs,
  wallToFirstDeltaMs,
  latencyMs: result?.latencyMs,
  costUsd: result?.costUsd,
});

const cold = [];
for (let n = 1; n <= Math.min(turns, 3); n++) cold.push(describe(await oneShot(n)));
console.log('one-shot (cold process per call):');
console.table(cold);
const { warmLine, rows } = await warm();
console.log(`serve: warm line ok=${warmLine.ok} model=${warmLine.model}; ${pauseMs} ms idle between turns`);
console.table(rows.map(describe));
