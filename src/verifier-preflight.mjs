import { readdirSync } from 'node:fs';
import { dirname, posix } from 'node:path';
import { matchesAny } from './glob.mjs';
import { PathPolicy } from './policy.mjs';
import { readRegularFileSync } from './regular-file.mjs';

const SOURCE = /\.(?:[cm]?[jt]sx?|py|sh|json)$/;
const TEST_CODE = /\.(?:[cm]?[jt]sx?|py)$/;
const SKIP = new Set(['node_modules', '.git', '.venv', 'venv', 'coverage', 'dist', 'build']);
const MAX_FILES = 256;
const MAX_BYTES = 8_000_000;
const MAX_VALUES = 256;

// Shell tokenization only: never expand substitutions, globs, variables or run code.
function commandSegments(text) {
  const segments = [[]];
  let word = '',
    quote = '',
    started = false;
  const flush = () => {
    if (started) segments.at(-1).push(word);
    word = '';
    started = false;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\' && quote !== "'") {
      const next = text[i + 1];
      if (!quote || ['"', '\\', '$', '`', '\n'].includes(next)) {
        word += next ?? '';
        i++;
      } else word += c;
      started = true;
    } else if (quote) {
      if (c === quote) quote = '';
      else word += c;
      started = true;
    } else if (c === '"' || c === "'") {
      quote = c;
      started = true;
    } else if (/[;&|\n]/.test(c)) {
      flush();
      if (segments.at(-1).length) segments.push([]);
    } else if (/\s/.test(c)) flush();
    else {
      word += c;
      started = true;
    }
  }
  flush();
  return { segments: segments.filter((part) => part.length), incomplete: !!quote };
}

// A deliberately small string grammar covers literal test lists and argv-based
// group runners. No eval, module loading, arbitrary expressions or repo execution.
function localReferences(text, argv = []) {
  const bindings = new Map();
  let incomplete = false;
  const combine = (prefixes, suffixes) => {
    const result = [];
    for (const prefix of prefixes)
      for (const suffix of suffixes) {
        if (result.length >= MAX_VALUES) {
          incomplete = true;
          return result;
        }
        result.push(prefix + suffix);
      }
    return result;
  };
  const values = (expression, depth = 0) => {
    if (depth > 8) return [];
    const expr = expression.trim();
    if (bindings.has(expr)) return bindings.get(expr);
    const arg = /^process\.argv\[(\d+)\]$/.exec(expr);
    if (arg) return typeof argv[+arg[1]] === 'string' ? [argv[+arg[1]]] : [];
    if (/^(['"])[^'"\\]*\1$/.test(expr)) return [expr.slice(1, -1)];
    if (expr.startsWith('`') && expr.endsWith('`') && !expr.includes('\\')) {
      const body = expr.slice(1, -1),
        parts = body.split(/(\$\{[^}]+\})/);
      let result = [''];
      for (const part of parts) {
        const options = part.startsWith('${') ? values(part.slice(2, -1), depth + 1) : [part];
        result = combine(result, options);
      }
      return result;
    }
    // Split + outside string literals, so a + in a filename stays literal.
    if (expr.includes('+')) {
      const terms = expr.match(/['"][^'"]*['"]|`[^`]*`|[^+]+/g) ?? [];
      let result = [''];
      for (const term of terms) result = combine(result, values(term, depth + 1));
      return result;
    }
    return [];
  };
  for (const [, name, expression] of text.matchAll(
    /\b(?:const|let|var)\s+(\w+)\s*=\s*(\[[^\]\n]*\]|process\.argv\[\d+\]|'[^'\n]*'|"[^"\n]*")/g,
  )) {
    const array = expression.startsWith('[');
    const items = array
      ? expression
          .slice(1, -1)
          .split(',')
          .filter((item) => item.trim())
      : [expression];
    const resolved = items.flatMap((item) => values(item));
    if (resolved.length <= MAX_VALUES) bindings.set(name, resolved);
    else incomplete = true;
  }
  for (const [, name, list] of text.matchAll(/\bfor\s*\(\s*(?:const|let|var)\s+(\w+)\s+of\s+(\w+)\s*\)/g))
    if (bindings.has(list)) bindings.set(name, bindings.get(list));
  const found = [];
  for (const [, specifier] of text.matchAll(/(?:\bfrom\s*|\bimport\s+)['"]([^'"]+)['"]/g)) found.push(specifier);
  for (const [, expression] of text.matchAll(/\b(?:import|require)\s*\(\s*([^;\n]*?)\s*\)/g)) {
    const resolved = values(expression);
    if (!resolved.length) incomplete = true;
    found.push(...resolved);
  }
  return { found, incomplete };
}

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
    // Advisory only: common native dependencies can fail at import time even
    // when the interpreter declaration is accepted. Never import repo code here.
    if (
      /(?:^|[;\n])\s*(?:from\s+(?:torch|numpy|scipy|tensorflow|jax|cv2|pandas)(?:[.\s])|import\s+[^;\n#]*\b(?:torch|numpy|scipy|tensorflow|jax|cv2|pandas)\b)/.test(
        text,
      )
    )
      warn('native-import', path);
    if (/(?:^|[\s'"`=])\/(?:private\/)?(?:tmp(?:\/|\b)|var\/folders(?:\/|\b))/m.test(text)) warn('system-temp', path);
    if (/\bchild_process\b|\b(?:execFile(?:Sync)?|spawn(?:Sync)?)\s*\(|\bsubprocess\b|\bos\.(?:system|popen)\s*\(/.test(text))
      warn('child-process', path);
    if (/(?:['"`]\/?(?:bin\/)?ps['"`]|(?:^|[;&|]\s*|\s)ps\s+-)/m.test(text)) warn('process-inspection', path);
  };
  const queue = [];
  const selected = new Set();
  const available = new Set(candidates);
  const enqueue = (path, argv = []) => {
    const key = JSON.stringify([path, argv]);
    if (selected.has(key) || !available.has(path)) return false;
    if (selected.size >= MAX_FILES * 2) {
      limited = true;
      return false;
    }
    selected.add(key);
    queue.push({ path, argv });
    return true;
  };
  const references = (text, path, argv) => {
    const result = localReferences(text, argv);
    limited ||= result.incomplete;
    for (const specifier of result.found) {
      if (!specifier.startsWith('.')) continue;
      const target = posix.normalize(posix.join(dirname(path), specifier));
      let resolved = false;
      for (const suffix of [
        '',
        '.js',
        '.mjs',
        '.cjs',
        '.ts',
        '.tsx',
        '.jsx',
        '.mts',
        '.cts',
        '.json',
        '/index.js',
        '/index.mjs',
        '/index.ts',
      ]) {
        if (!available.has(target + suffix)) continue;
        enqueue(target + suffix, argv);
        resolved = true;
        break;
      }
      if (!resolved) limited = true;
    }
  };
  const commands = new Set();
  // Files the command itself names (not their imports): what a run's duration
  // is weighed against.
  const named = new Set();
  const command = (text, depth = 0) => {
    if (commands.has(text) || depth > 8) {
      limited = true;
      return;
    }
    commands.add(text);
    inspect(text, 'testCommand');
    const parsed = commandSegments(text);
    limited ||= parsed.incomplete;
    for (const words of parsed.segments) {
      const script = /\b(?:npm|pnpm|yarn)\s+(?:run\s+)?([\w:-]+)/.exec(words.join(' '))?.[1];
      for (let index = 0; index < words.length; index++) {
        const word = words[index].replace(/^--(?:import|require|loader)=/, '').replace(/^\.\//, '');
        if (['-e', '--eval', '-p', '--print', '-c'].includes(words[index])) {
          const inline = words[++index] ?? '';
          inspect(inline, 'testCommand');
          references(inline, 'testCommand');
          continue;
        }
        if (script && ['npm', 'pnpm', 'yarn', 'run', script].includes(word)) continue;
        if (!word || word.startsWith('-') || word.includes('..') || word.startsWith('/')) continue;
        for (const path of candidates) {
          try {
            if (path === word || path.startsWith(`${word}/`) || matchesAny(path, [word])) {
              enqueue(path, [words[0], ...words.slice(index)]);
              named.add(path);
            }
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
    }
  };
  command(testCommand);
  const resolvedFiles = new Set();
  const cache = new Map();
  let commandBytes = 0;
  for (let index = 0; index < queue.length; index++) {
    if (resolvedFiles.size >= MAX_FILES || bytes >= MAX_BYTES) {
      limited = true;
      break;
    }
    const { path, argv } = queue[index];
    let text;
    try {
      text = cache.get(path) ?? read(path);
      cache.set(path, text);
    } catch {
      limited = true;
      continue;
    }
    // Only test code is weighed; data and fixture files a named directory holds are not.
    if (!resolvedFiles.has(path) && named.has(path) && TEST_CODE.test(path)) commandBytes += Buffer.byteLength(text);
    resolvedFiles.add(path);
    inspect(text, path);
    references(text, path, argv);
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
    scannedFiles: resolvedFiles.size,
    resolvedFiles: [...resolvedFiles],
    commandBytes,
    limited: limited || !resolvedFiles.size,
    warnings,
    note: 'Static advisory; dynamic imports, runner configuration and external packages are not fully analyzed. No test was run.',
  };
}

export function verifierPreflightLines(value) {
  if (!value || !Array.isArray(value.warnings)) return [];
  const advice = {
    'native-import':
      'native Python imports may crash inside the verifier sandbox even with an accepted interpreter declaration; probe the dependencies with health verifierInterpreter + verifierImports before spending, and compare failures in the primary',
    'system-temp': 'hard-coded system temp path may fail with EPERM; use TMPDIR / os.tmpdir() / tempfile',
    'child-process': 'child-process use may fail with spawn EPERM under verifier restrictions; check in the primary before spending',
    'process-inspection':
      'ps / process identity inspection may be denied even when exec is permitted; use an injectable identity probe or verify in the primary',
  };
  return [
    `verifier preflight: ${value.scannedFiles ?? 0} file(s) scanned; static advisory${value.limited ? ' (incomplete)' : ''}, not a sandbox test`,
    ...(value.previousFailures ?? []).map(
      (failure) =>
        `verifier session warning: ${failure.jobId} (${failure.kind}): ${failure.files.join(', ') || 'offending files unknown'}; exclude these files from testCommand and check them in the primary before spending again`,
    ),
    ...value.warnings
      .filter((w) => advice[w?.code] && typeof w.path === 'string')
      .slice(0, 24)
      .map((w) => `verifier warning: ${w.path}: ${advice[w.code]}`),
  ];
}
