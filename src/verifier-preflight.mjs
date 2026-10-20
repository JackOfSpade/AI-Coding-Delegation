import { readdirSync } from 'node:fs';
import { dirname, posix } from 'node:path';
import { matchesAny } from './glob.mjs';
import { PathPolicy } from './policy.mjs';
import { readRegularFileSync } from './regular-file.mjs';

const SOURCE = /\.(?:[cm]?[jt]sx?|py|sh|json)$/;
const SKIP = new Set(['node_modules', '.git', '.venv', 'venv', 'coverage', 'dist', 'build']);
const MAX_FILES = 256;
const MAX_BYTES = 8_000_000;

/** Advisory only: never execute repository code or widen verifier permissions.
 * Follow literal command paths, package scripts and local imports. Dynamic
 * imports, runner config and external packages require a real primary check. */
export function preflightVerifier({ repoPath, testCommand, denyRead = [] }) {
  if (!testCommand) return undefined;
  const policy = new PathPolicy({ repoPath, ownedPaths: [], denyRead });
  const candidates = [];
  let entries = 0,
    bytes = 0,
    limited = false;
  const read = (path) => {
    const buffer = readRegularFileSync(policy.assertReadable(path), 2_000_000);
    bytes += buffer.length;
    if (bytes > MAX_BYTES) {
      limited = true;
      throw new Error('scan limit');
    }
    return buffer.toString('utf8');
  };
  const walk = (directory = '') => {
    let children;
    try {
      children = readdirSync(directory ? policy.assertReadable(directory) : policy.repoPath, { withFileTypes: true });
    } catch {
      limited = true;
      return;
    }
    for (const entry of children) {
      if (++entries > 10_000) {
        limited = true;
        return;
      }
      if (entry.isSymbolicLink() || SKIP.has(entry.name) || entry.name.startsWith('.')) continue;
      const path = posix.join(directory, entry.name);
      try {
        policy.assertReadable(path);
      } catch {
        continue;
      }
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && SOURCE.test(path)) candidates.push(path);
    }
  };
  walk();
  const warnings = [];
  const seenWarnings = new Set();
  const warn = (code, path) => {
    const key = `${code}:${path}`;
    if (seenWarnings.has(key) || warnings.length >= 24) return;
    seenWarnings.add(key);
    warnings.push({ code, path });
  };
  const inspect = (text, path) => {
    if (/(?:^|[\s'"`=])\/(?:private\/)?(?:tmp(?:\/|\b)|var\/folders\/)/m.test(text)) warn('system-temp', path);
    if (/\b(?:child_process|execFile(?:Sync)?|spawn(?:Sync)?|subprocess|os\.(?:system|popen))\b/.test(text)) warn('child-process', path);
    if (/(?:['"`]\/?(?:bin\/)?ps['"`]|(?:^|[;&|]\s*|\s)ps\s+-)/m.test(text)) warn('process-inspection', path);
  };
  const queue = [];
  const selected = new Set();
  const enqueue = (path) => {
    if (selected.has(path) || !candidates.includes(path)) return;
    selected.add(path);
    queue.push(path);
  };
  const commands = new Set();
  const command = (text, depth = 0) => {
    if (commands.has(text) || depth > 8) return;
    commands.add(text);
    inspect(text, 'testCommand');
    // Preserve quoted globs and paths. This is detection, never shell evaluation.
    const script = /\b(?:npm|pnpm|yarn)\s+(?:run\s+)?([\w:-]+)/.exec(text)?.[1];
    const words = text.match(/"[^"]*"|'[^']*'|[^\s;&|]+/g) ?? [];
    for (let word of words) {
      word = word.replace(/^(['"])(.*)\1$/, '$2').replace(/^\.\//, '');
      if (script && ['npm', 'pnpm', 'yarn', 'run', script].includes(word)) continue;
      if (!word || word.startsWith('-') || word.includes('..') || word.startsWith('/')) continue;
      for (const path of candidates) {
        try {
          if (path === word || path.startsWith(`${word}/`) || matchesAny(path, [word])) enqueue(path);
        } catch {}
      }
    }
    if (script) {
      try {
        const pkg = JSON.parse(read('package.json'));
        if (typeof pkg.scripts?.[script] === 'string') command(pkg.scripts[script], depth + 1);
        else limited = true;
      } catch {
        limited = true;
      }
    }
  };
  command(testCommand);
  let scannedFiles = 0;
  for (let index = 0; index < queue.length; index++) {
    if (scannedFiles >= MAX_FILES || bytes >= MAX_BYTES) {
      limited = true;
      break;
    }
    const path = queue[index];
    let text;
    try {
      text = read(path);
    } catch {
      limited = true;
      continue;
    }
    scannedFiles++;
    inspect(text, path);
    // ESM imports/exports, require() and literal dynamic imports. Read paths
    // are confined by PathPolicy; no host files or dependencies are mounted.
    const imports = text.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)['"]([^'"]+)['"]/g);
    for (const [, specifier] of imports) {
      if (!specifier.startsWith('.')) continue;
      const target = posix.normalize(posix.join(dirname(path), specifier));
      for (const suffix of ['', '.js', '.mjs', '.cjs', '.ts', '.tsx', '/index.js', '/index.ts']) enqueue(target + suffix);
    }
    if (path.endsWith('.py')) {
      for (const [, module] of text.matchAll(/(?:^|\n)\s*(?:from|import)\s+([\w.]+)/g)) {
        const target = module.replaceAll('.', '/');
        enqueue(`${target}.py`);
        enqueue(`${dirname(path)}/${target}.py`);
      }
    }
  }
  return {
    status: warnings.length ? 'warning' : 'unknown',
    scannedFiles,
    limited: limited || !scannedFiles,
    warnings,
    note: 'Static advisory; dynamic imports, runner configuration and external packages are not fully analyzed. No test was run.',
  };
}

export function verifierPreflightLines(value) {
  if (!value || !Array.isArray(value.warnings)) return [];
  const advice = {
    'system-temp': 'hard-coded system temp path may fail with EPERM; use TMPDIR / os.tmpdir() / tempfile',
    'child-process': 'child-process use may fail with spawn EPERM under verifier restrictions; check in the primary before spending',
    'process-inspection':
      'ps / process identity inspection may be denied even when exec is permitted; use an injectable identity probe or verify in the primary',
  };
  return [
    `verifier preflight: ${value.scannedFiles ?? 0} file(s) scanned; static advisory${value.limited ? ' (incomplete)' : ''}, not a sandbox test`,
    ...value.warnings
      .filter((w) => advice[w?.code] && typeof w.path === 'string')
      .slice(0, 24)
      .map((w) => `verifier warning: ${w.path}: ${advice[w.code]}`),
  ];
}
