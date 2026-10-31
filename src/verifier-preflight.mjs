import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
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
// `spans` parallels `segments` with each word's [start, end) in the source text.
function commandSegments(text) {
  const segments = [[]];
  const spans = [[]];
  let word = '',
    quote = '',
    started = false,
    start = 0;
  const begin = (index) => {
    if (!started) start = index;
    started = true;
  };
  const flush = (end) => {
    if (started) {
      segments.at(-1).push(word);
      spans.at(-1).push([start, end]);
    }
    word = '';
    started = false;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\' && quote !== "'") {
      begin(i);
      const next = text[i + 1];
      if (!quote || ['"', '\\', '$', '`', '\n'].includes(next)) {
        word += next ?? '';
        i++;
      } else word += c;
    } else if (quote) {
      if (c === quote) quote = '';
      else word += c;
    } else if (c === '"' || c === "'") {
      begin(i);
      quote = c;
    } else if (/[;&|\n]/.test(c)) {
      flush(i);
      if (segments.at(-1).length) {
        segments.push([]);
        spans.push([]);
      }
    } else if (/\s/.test(c)) flush(i);
    else {
      begin(i);
      word += c;
    }
  }
  flush(text.length);
  const kept = segments.map((part, index) => [part, spans[index]]).filter(([part]) => part.length);
  return { segments: kept.map(([part]) => part), spans: kept.map(([, span]) => span), incomplete: !!quote };
}

// Options of a script interpreter that take the next word as their value.
const VALUE_FLAGS = new Set([
  '--import',
  '--require',
  '-r',
  '--loader',
  '--experimental-loader',
  '--env-file',
  '--conditions',
  '-C',
  '--input-type',
  '--title',
  '-W',
  '-X',
]);
/**
 * The index of the script word a `node`/`python`-style segment runs (its
 * program; every later word is that program's argument), or -1 when the
 * segment runs no script file (`-e`, `-c`, `-m`, `node --test`, another tool).
 */
const interpreter = (words) => /^(?:node(?:\d+)?|nodejs|bun|tsx|ts-node|python(?:\d+(?:\.\d+)?)?)$/.test(posix.basename(words[0] ?? ''));
function interpreterScriptIndex(words) {
  if (!interpreter(words)) return -1;
  for (let index = 1; index < words.length; index++) {
    const word = words[index];
    if (word === '--') return index + 1 < words.length ? index + 1 : -1;
    if (['-e', '--eval', '-p', '--print', '-c', '-m', '--test'].includes(word)) return -1;
    if (!word.startsWith('-')) return index;
    if (VALUE_FLAGS.has(word)) index++;
  }
  return -1;
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

const SYSTEM_TEMP_PATH = /^\/(?:private\/)?(?:tmp|var\/folders)(?:\/|$)/;
const MAX_FINDINGS = 24;
// Findings a compact response or refusal names before counting the rest.
const COMPACT_FINDINGS = 3;
// Collected before runner scoping demotes some, so that a selected suite's
// finding is never crowded out by the suites the runner was not given.
const MAX_SCAN_FINDINGS = 256;
// Calls that create or write a path. Only their first argument (Python: dir=)
// is resolved; a call whose target cannot be resolved statically is ignored.
const JS_WRITE_CALL = /\b(mkdtemp(?:Sync)?|mkdir(?:Sync)?|writeFile(?:Sync)?|appendFile(?:Sync)?|createWriteStream)\s*\(/g;
const PY_TEMP_CALL = /\b(mkdtemp|mkstemp|TemporaryDirectory|NamedTemporaryFile)\s*\(/g;
const PY_MKDIR_CALL = /\bos\.(makedirs|mkdir)\s*\(/g;

/** The text of a call's arguments, from just after its `(`, at depth 0. Strings are skipped whole. */
function callArguments(text, from) {
  const args = [];
  let depth = 0,
    current = '';
  for (let i = from; i < text.length && i < from + 600; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') {
      const end = text.indexOf(c, i + 1);
      if (end < 0) return undefined;
      current += text.slice(i, end + 1);
      i = end;
    } else if ('([{'.includes(c)) {
      depth++;
      current += c;
    } else if (')]}'.includes(c)) {
      if (depth === 0) {
        if (current.trim()) args.push(current.trim());
        return args;
      }
      depth--;
      current += c;
    } else if (c === ',' && depth === 0) {
      args.push(current.trim());
      current = '';
    } else current += c;
  }
  return undefined;
}

/**
 * Statically resolve a path expression in `file` to where it lands:
 * `{ kind: 'repo', path }` (relative to the worktree root, where the verifier
 * runs), `{ kind: 'system', path }` (a hard-coded system temp path),
 * `{ kind: 'tmp' }` (TMPDIR-based) or `{ kind: 'other' }`; undefined when it
 * cannot be resolved. Interpolations become `x`: only the directory matters.
 */
function resolvePathExpression(expression, context, depth = 0) {
  const { file, text, at, inCode } = context;
  if (depth > 6) return undefined;
  const expr = expression
    .trim()
    .replace(/^str\((.*)\)$/s, '$1')
    .replace(/^r(['"])/, '$1');
  const fileDir = dirname(file) === '.' ? '' : dirname(file);
  const literal = (value) => {
    if (value.startsWith('/')) return SYSTEM_TEMP_PATH.test(value) ? { kind: 'system', path: value } : { kind: 'other' };
    if (/^[a-z]+:/i.test(value)) return { kind: 'other' };
    const path = posix.normalize(value || '.');
    return path === '..' || path.startsWith('../')
      ? { kind: 'other' }
      : { kind: 'repo', path: path === '.' ? '' : path.replace(/\/$/, '') };
  };
  const append = (base, part) => {
    if (!base) return undefined;
    if (part.startsWith('/')) return literal(part);
    if (base.kind === 'system') return { kind: 'system', path: posix.join(base.path, part) };
    if (base.kind !== 'repo') return base;
    return literal(posix.join(base.path || '.', part));
  };
  let match;
  if ((match = /^(['"])([^'"\\]*)\1$/.exec(expr))) return literal(match[2]);
  if (expr.startsWith('`') && expr.endsWith('`')) {
    const body = expr.slice(1, -1);
    const lead = /^\$\{([^}]+)\}(.*)$/s.exec(body);
    if (lead) return append(resolvePathExpression(lead[1], context, depth + 1), lead[2].replace(/\$\{[^}]*\}/g, 'x'));
    return literal(body.replace(/\$\{[^}]*\}/g, 'x'));
  }
  if (/^(?:process\.cwd\(\)|os\.getcwd\(\)|(?:pathlib\.)?Path\.cwd\(\))$/.test(expr)) return { kind: 'repo', path: '' };
  if (/^(?:os\.)?tmpdir\(\)$|^process\.env\.(?:TMPDIR|TMP|TEMP)\b|^tempfile\.gettempdir\(\)$/.test(expr)) return { kind: 'tmp' };
  if (/^(?:__dirname|import\.meta\.dirname)$/.test(expr)) return { kind: 'repo', path: fileDir };
  if (/^(?:__filename|import\.meta\.filename|(?:url\.)?fileURLToPath\(\s*import\.meta\.url\s*\)|__file__)$/.test(expr))
    return { kind: 'repo', path: file };
  if (
    (match = /^(?:(?:url\.)?fileURLToPath\()?\s*new URL\(\s*(['"])([^'"\\]*)\1\s*,\s*import\.meta\.url\s*\)\s*\)?(?:\.pathname)?$/.exec(
      expr,
    ))
  )
    return literal(posix.join(fileDir || '.', match[2]));
  // Python: Path(__file__).resolve().parent.parent / 'x'
  if (
    (match = /^(?:pathlib\.)?Path\(\s*(.+?)\s*\)((?:\.(?:resolve|absolute)\(\))*)((?:\.parent)*)((?:\s*\/\s*(['"])[^'"\\]*\5)*)$/s.exec(
      expr,
    ))
  ) {
    let base = resolvePathExpression(match[1], context, depth + 1);
    for (let n = match[3].split('.parent').length - 1; n > 0 && base?.kind === 'repo'; n--)
      base = { kind: 'repo', path: dirname(base.path) === '.' ? '' : dirname(base.path) };
    for (const [, , part] of match[4].matchAll(/(['"])([^'"\\]*)\1/g)) base = append(base, part);
    return base;
  }
  if ((match = /^(?:os\.path\.|path\.|posix\.)?dirname\((.+)\)$/s.exec(expr))) {
    const inner = resolvePathExpression(match[1].replace(/^os\.path\.(?:abspath|realpath)\((.+)\)$/s, '$1'), context, depth + 1);
    if (inner?.kind !== 'repo') return inner;
    return { kind: 'repo', path: dirname(inner.path) === '.' ? '' : dirname(inner.path) };
  }
  if ((match = /^(?:os\.path\.|path\.|posix\.)?(join|resolve)\((.*)\)$/s.exec(expr))) {
    const parts = callArguments(`${match[2]})`, 0);
    if (!parts?.length) return undefined;
    let base = resolvePathExpression(parts[0], context, depth + 1);
    for (const part of parts.slice(1)) {
      // Literal segments join as written, so `..` climbs from the base;
      // interpolations become `x`.
      const quoted = /^(['"])([^'"\\]*)\1$/.exec(part)?.[2] ?? /^`([^`]*)`$/.exec(part)?.[1].replace(/\$\{[^}]*\}/g, 'x');
      if (quoted !== undefined) base = append(base, quoted);
      else base = resolvePathExpression(part, context, depth + 1)?.kind === 'system' ? { kind: 'other' } : append(base, 'x');
    }
    return base;
  }
  if ((match = /^(?:os\.path\.)?(?:abspath|realpath)\((.+)\)$/s.exec(expr))) return resolvePathExpression(match[1], context, depth + 1);
  if (/^[A-Za-z_$][\w$]*$/.test(expr)) {
    // The nearest declaration before the use: names are reused across tests in one file.
    const escaped = expr.replace(/\$/g, '\\$');
    const pattern = new RegExp(`(?:\\b(?:const|let|var)\\s+${escaped}\\s*=|^[ \\t]*${escaped}\\s*=(?!=))\\s*([^;\\n]+)`, 'gm');
    let binding;
    for (const match of text.matchAll(pattern)) if (match.index < (at ?? text.length) && (!inCode || inCode(match.index))) binding = match;
    if (binding) return resolvePathExpression(binding[1].replace(/\s+#.*$/, ''), { file, text, at: binding.index, inCode }, depth + 1);
  }
  return undefined;
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

/**
 * Which characters of a source file are code: string literals (a fixture's
 * file contents, a child program), comments and JS regex literals are not.
 * A light lexer, not a parser: a template literal is skipped whole.
 */
function codeMask(text, python) {
  const skip = new Uint8Array(text.length);
  const mark = (from, to) => skip.fill(1, from, Math.min(to, text.length));
  let previous = '';
  for (let i = 0; i < text.length;) {
    const c = text[i];
    const next = text[i + 1];
    let end = -1;
    if (python ? c === '#' : c === '/' && next === '/') end = text.indexOf('\n', i) < 0 ? text.length : text.indexOf('\n', i);
    else if (!python && c === '/' && next === '*') end = text.indexOf('*/', i + 2) < 0 ? text.length : text.indexOf('*/', i + 2) + 2;
    else if (c === '"' || c === "'" || (!python && c === '`')) {
      const quote = python && text.startsWith(c.repeat(3), i) ? c.repeat(3) : c;
      let j = i + quote.length;
      while (j < text.length && !text.startsWith(quote, j)) {
        if (text[j] === '\\') j++;
        else if (quote.length === 1 && c !== '`' && text[j] === '\n') break;
        j++;
      }
      end = j + quote.length;
    } else if (!python && c === '/' && (!previous || /[(,=:[!&|?{};+\-*%<>~^]/.test(previous))) {
      let j = i + 1,
        inClass = false;
      for (; j < text.length && text[j] !== '\n'; j++) {
        if (text[j] === '\\') j++;
        else if (text[j] === '[') inClass = true;
        else if (text[j] === ']') inClass = false;
        else if (text[j] === '/' && !inClass) break;
      }
      end = j + 1;
    }
    if (end > i) {
      mark(i, end);
      previous = c;
      i = end;
      continue;
    }
    if (!/\s/.test(c)) previous = c;
    i++;
  }
  return (index) => !skip[index];
}
const globLiteral = (path) => !/[*?[\]{}]/.test(path);

/**
 * Writes the verifier sandbox is certain to deny: a hard-coded system temp
 * path, or a worktree path outside the job's write scope. Each finding names
 * the file, line and resolved target, plus the narrow extraWritable glob that
 * would cover a worktree target.
 */
function writeFindings(text, file, { repoPath, writeScope }) {
  const findings = [];
  const add = (call, index, target, temp) => {
    if (!target || findings.length >= MAX_FINDINGS) return;
    const before = findings.length;
    record(call, index, target, temp);
    // Not serialized: only runner scoping reads it.
    for (const finding of findings.slice(before))
      if (atModuleScope?.(index)) Object.defineProperty(finding, 'moduleScope', { value: true });
  };
  let atModuleScope;
  const record = (call, index, target, temp) => {
    const line = lineOf(text, index);
    if (target.kind === 'system')
      findings.push({ code: 'system-temp-write', path: file, line, call, target: temp ? `${target.path}XXXXXX` : target.path });
    if (target.kind !== 'repo' || !Array.isArray(writeScope)) return;
    const node = temp ? `${target.path}XXXXXX` : target.path;
    if (!node) return;
    let writable = false;
    try {
      writable = matchesAny(node, writeScope);
    } catch {}
    if (writable) return;
    // A recursive mkdir of a directory that already exists writes nothing.
    if (/^mkdir|^makedirs/.test(call) && existsSync(join(repoPath, node))) return;
    const glob = temp ? `${target.path}**` : /^mkdir|^makedirs/.test(call) ? `${node}/**` : node;
    findings.push({
      code: 'temp-outside-scope',
      path: file,
      line,
      call,
      target: node,
      ...(globLiteral(target.path) ? { extraWritable: glob } : {}),
    });
  };
  if (file === 'testCommand') {
    const { segments } = commandSegments(text);
    for (const words of segments) {
      const name = posix.basename(words[0] ?? '');
      if (name !== 'mktemp' && name !== 'mkdir') continue;
      for (const word of words.slice(1)) {
        const value = word.replace(/^--tmpdir=/, '');
        if (value.startsWith('-')) continue;
        const target = resolvePathExpression(JSON.stringify(value), { file, text });
        // A relative mktemp operand is a template, often TMPDIR-based (-t).
        if (name === 'mkdir' || target?.kind === 'system') add(name, text.indexOf(word), target, false);
      }
    }
    return findings;
  }
  const inCode = codeMask(text, file.endsWith('.py'));
  // A write at module scope runs whenever the file is imported, whatever a
  // runner then selects; one inside a function or callback runs only if called.
  const depth = new Int32Array(text.length + 1);
  for (let i = 0, level = 0; i < text.length; i++) {
    depth[i] = level;
    if (!inCode(i)) continue;
    if ('([{'.includes(text[i])) level++;
    else if (')]}'.includes(text[i])) level = Math.max(0, level - 1);
  }
  atModuleScope = (index) =>
    file.endsWith('.py') ? !/[ \t]/.test(text[text.lastIndexOf('\n', index - 1) + 1] ?? '') && depth[index] === 0 : depth[index] === 0;
  const context = (index) => ({ file, text, at: index, inCode });
  const calls = (pattern) => [...text.matchAll(pattern)].filter((match) => inCode(match.index));
  if (file.endsWith('.py')) {
    for (const match of calls(PY_TEMP_CALL)) {
      const args = callArguments(text, match.index + match[0].length) ?? [];
      const dir = args.find((arg) => /^dir\s*=/.test(arg));
      if (!dir) continue;
      const prefix = /^(['"])([^'"\\]*)\1$/.exec(args.find((arg) => /^prefix\s*=/.test(arg))?.replace(/^prefix\s*=\s*/, '') ?? '')?.[2];
      const base = resolvePathExpression(dir.replace(/^dir\s*=\s*/, ''), context(match.index));
      add(
        match[1],
        match.index,
        base?.kind === 'repo' || base?.kind === 'system'
          ? { ...base, path: posix.join(base.path || '.', prefix ?? 'tmp').replace(/^\.\//, '') }
          : base,
        true,
      );
    }
    for (const match of calls(PY_MKDIR_CALL)) {
      const first = callArguments(text, match.index + match[0].length)?.[0];
      if (first) add(match[1], match.index, resolvePathExpression(first, context(match.index)), false);
    }
    return findings;
  }
  for (const match of calls(JS_WRITE_CALL)) {
    const first = callArguments(text, match.index + match[0].length)?.[0];
    if (first) add(match[1], match.index, resolvePathExpression(first, context(match.index)), match[1].startsWith('mkdtemp'));
  }
  return findings;
}

/** Never executes repository code or widens verifier permissions. Follows
 * literal command paths, package scripts and local imports; dynamic imports,
 * runner config and external packages require a real primary check. Returns
 * the public result plus the import graph and command words narrowing needs. */
function scanVerifier({ repoPath, testCommand, denyRead = [], writeScope }) {
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
  const blocking = [];
  const seenWarnings = new Set();
  // Import edges (file -> local files it imports), to name the test file that pulled a helper in.
  const edges = new Map();
  const edge = (from, to) => {
    if (!edges.has(from)) edges.set(from, new Set());
    edges.get(from).add(to);
  };
  const block = (findings) => {
    for (const finding of findings) {
      const key = `${finding.code}:${finding.path}:${finding.line}`;
      if (blocking.length >= MAX_SCAN_FINDINGS || seenWarnings.has(key)) continue;
      seenWarnings.add(key);
      blocking.push(finding);
    }
  };
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
  // The suites a file-filtered runner is given, and what they import, are
  // read ahead of the rest so the scan limits cannot leave them unread.
  const urgent = [];
  const pressing = new Set();
  const selected = new Set();
  const available = new Set(candidates);
  const enqueue = (path, argv = [], from) => {
    const key = JSON.stringify([path, argv]);
    if (selected.has(key) || !available.has(path)) return false;
    if (selected.size >= MAX_FILES * 2) {
      limited = true;
      return false;
    }
    selected.add(key);
    const given = runners.some(
      (runner) => runner.path === from && runner.operands.some((operand) => path === operand || path.endsWith(`/${operand}`)),
    );
    if (given || pressing.has(from)) {
      pressing.add(path);
      urgent.push({ path, argv });
    } else queue.push({ path, argv });
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
        edge(path, target + suffix);
        enqueue(target + suffix, argv, path);
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
  // The top-level command's words and the files each one names, for narrowing.
  const words0 = [];
  // Script runners given explicit test-file arguments (`node runner.js a.js`):
  // a runner that loads every suite but runs only the ones it is given.
  const runners = [];
  const command = (text, depth = 0) => {
    if (commands.has(text) || depth > 8) {
      limited = true;
      return;
    }
    commands.add(text);
    inspect(text, 'testCommand');
    block(writeFindings(text, 'testCommand', { repoPath: policy.repoPath, writeScope }));
    const parsed = commandSegments(text);
    limited ||= parsed.incomplete;
    for (const [segment, words] of parsed.segments.entries()) {
      const script = /\b(?:npm|pnpm|yarn)\s+(?:run\s+)?([\w:-]+)/.exec(words.join(' '))?.[1];
      const matched = words.map(() => new Set());
      if (depth === 0) words0.push({ words, spans: parsed.spans[segment], matched, script });
      const scriptAt = interpreterScriptIndex(words);
      if (scriptAt >= 0) {
        const operands = words
          .slice(scriptAt + 1)
          .filter((word) => !word.startsWith('-') && TEST_CODE.test(word))
          .map((word) => posix.normalize(word));
        // Recorded without operands too: a runner some segment runs unfiltered is never scoped.
        runners.push({ path: posix.normalize(words[scriptAt]), operands });
      }
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
              matched[index].add(path);
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
  for (let index = 0; urgent.length || index < queue.length;) {
    if (resolvedFiles.size >= MAX_FILES || bytes >= MAX_BYTES) {
      limited = true;
      break;
    }
    const { path, argv } = urgent.length ? urgent.shift() : queue[index++];
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
    if (!resolvedFiles.has(path) && TEST_CODE.test(path)) block(writeFindings(text, path, { repoPath: policy.repoPath, writeScope }));
    resolvedFiles.add(path);
    inspect(text, path);
    references(text, path, argv);
    if (path.endsWith('.py')) {
      for (const [, module] of text.matchAll(/(?:^|\n)\s*(?:from|import)\s+([\w.]+)/g)) {
        const target = module.replaceAll('.', '/');
        for (const candidate of [`${target}.py`, `${dirname(path)}/${target}.py`])
          if (available.has(candidate)) {
            edge(path, candidate);
            enqueue(candidate, [], path);
          }
      }
    }
  }
  const reach = new Map();
  const reachable = (root) => {
    if (!reach.has(root)) {
      const seen = new Set([root]);
      for (const file of seen) for (const next of edges.get(file) ?? []) seen.add(next);
      reach.set(root, seen);
    }
    return reach.get(root);
  };
  // The test files the command names that run `file` (itself, or through imports).
  const testFilesFor = (file) => [...named].filter((root) => TEST_CODE.test(root) && reachable(root).has(file)).sort();
  // A runner given test files (by path or bare name) runs only those suites
  // even though it imports every one. Its suites are what it imports from the
  // directories the selected ones are in; a write inside a suite it was not
  // given is advisory, unless it sits at module scope (the import runs it).
  // Whatever the runner reaches without passing through an unselected suite
  // (a harness, a reporter) always runs and stays blocking. A runner that any
  // segment runs without file arguments is never scoped, and a scope is
  // trusted only when every file its selected suites reach was read.
  const scopes = [...new Set(runners.map((runner) => runner.path))].flatMap((path) => {
    const calls = runners.filter((runner) => runner.path === path);
    if (!resolvedFiles.has(path) || calls.some((call) => !call.operands.length)) return [];
    const operands = calls.flatMap((call) => call.operands);
    const direct = [...(edges.get(path) ?? [])];
    const selected = direct.filter((file) => operands.some((operand) => file === operand || file.endsWith(`/${operand}`)));
    if (!selected.length) return [];
    const closure = new Set(selected.flatMap((file) => [...reachable(file)]));
    if (![...closure].every((file) => resolvedFiles.has(file))) return [];
    const folders = new Set(selected.map((file) => dirname(file)));
    const suites = direct.filter((file) => !selected.includes(file) && TEST_CODE.test(file) && folders.has(dirname(file)));
    return suites.length ? [{ runner: path, selected, suites }] : [];
  });
  let advisory = [];
  let scopedWarnings = 0;
  if (scopes.length) {
    const runnerPaths = new Set(scopes.map((scope) => scope.runner));
    const unselectedSuites = new Set(scopes.flatMap((scope) => scope.suites));
    const kept = new Set();
    for (const root of [...named, 'testCommand', ...scopes.flatMap((scope) => scope.selected)])
      if (!runnerPaths.has(root)) for (const file of reachable(root)) kept.add(file);
    for (const file of runnerPaths)
      if (!kept.has(file) && !unselectedSuites.has(file)) {
        kept.add(file);
        for (const next of edges.get(file) ?? []) if (!unselectedSuites.has(next)) runnerPaths.add(next);
      }
    const unselected = (path) => !kept.has(path) && scopes.find((scope) => scope.suites.some((suite) => reachable(suite).has(path)));
    const demoted = blocking.filter((finding) => finding.path !== 'testCommand' && !finding.moduleScope && unselected(finding.path));
    advisory = demoted.map((finding) => ({ ...finding, runner: unselected(finding.path).runner }));
    blocking.splice(0, blocking.length, ...blocking.filter((finding) => !demoted.includes(finding)));
    const before = warnings.length;
    warnings.splice(0, warnings.length, ...warnings.filter((warning) => warning.path === 'testCommand' || !unselected(warning.path)));
    scopedWarnings = before - warnings.length;
  }
  blocking.splice(MAX_FINDINGS);
  for (const finding of blocking) {
    const testFiles = finding.path === 'testCommand' ? [] : testFilesFor(finding.path);
    if (testFiles.length && !(testFiles.length === 1 && testFiles[0] === finding.path)) finding.testFiles = testFiles.slice(0, 8);
  }
  const result = {
    status: blocking.length ? 'blocking' : warnings.length || advisory.length ? 'warning' : 'unknown',
    scannedFiles: resolvedFiles.size,
    resolvedFiles: [...resolvedFiles],
    commandBytes,
    limited: limited || !resolvedFiles.size,
    warnings,
    ...(blocking.length ? { blocking } : {}),
    ...(scopes.length
      ? {
          scoped: scopes.map((scope) => ({ runner: scope.runner, files: scope.selected.sort().slice(0, MAX_FINDINGS) })),
          ...(advisory.length ? { advisory: advisory.slice(0, MAX_FINDINGS), advisoryCount: advisory.length } : {}),
          ...(scopedWarnings ? { scopedWarnings } : {}),
        }
      : {}),
    note: 'Static advisory; dynamic imports, runner configuration and external packages are not fully analyzed. No test was run.',
  };
  return { result, words: words0, named, testFilesFor, read };
}

/** The public static preflight of a testCommand (undefined without one). Pass
 * the job's write scope (ownedPaths + extraWritable) to get `blocking` findings:
 * writes the verifier sandbox is certain to deny. */
export function preflightVerifier({ repoPath, testCommand, denyRead = [], writeScope }) {
  if (!testCommand) return undefined;
  return scanVerifier({ repoPath, testCommand, denyRead, writeScope }).result;
}

const shellWord = (value) => (/^[\w./@+=:,%-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`);
const GLOB = /[*?[]/;
// The runner a command segment invokes, from its leading words only.
function segmentRunner(words) {
  const names = words.slice(0, 4).map((word) => posix.basename(word));
  const at = (name) => names.indexOf(name);
  if (at('pytest') >= 0 || at('py.test') >= 0 || (names.includes('-m') && words[names.indexOf('-m') + 1] === 'pytest')) return 'pytest';
  if (at('vitest') >= 0) return 'vitest';
  if (at('jest') >= 0) return 'jest';
  if (/^node(?:\d+)?$/.test(names[0] ?? '') && words.includes('--test')) return 'node-test';
  return undefined;
}
const exclusion = {
  pytest: (file) => `--ignore=${shellWord(file)}`,
  vitest: (file) => `--exclude ${shellWord(file)}`,
  jest: (file) => `--testPathIgnorePatterns ${shellWord(file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))}`,
};

/** Rewrite one command text so it no longer runs `drop` (named test files). */
function narrowCommandText(text, words0, drop) {
  const edits = [];
  const handled = new Set();
  for (const { words, spans, matched, script } of words0) {
    if (script) continue;
    const runner = segmentRunner(words);
    const scriptAt = interpreterScriptIndex(words);
    const exclusions = [];
    let named = 0,
      kept = 0,
      runnerFiles = 0,
      runnerDropped = 0;
    for (const [index, files] of matched.entries()) {
      const tests = [...files].filter((file) => TEST_CODE.test(file));
      if (!tests.length) continue;
      named++;
      if (scriptAt >= 0 && index > scriptAt) runnerFiles++;
      const dropped = tests.filter((file) => drop.has(file));
      if (!dropped.length) {
        kept++;
        continue;
      }
      if (tests.length === 1 && tests[0] === words[index].replace(/^\.\//, '')) {
        // A preload (`--import x.mjs`) would leave its option without a value.
        if (interpreter(words) && (scriptAt < 0 || index < scriptAt) && VALUE_FLAGS.has(words[index - 1]))
          return {
            reason: `${words[index]} is loaded by ${words[index - 1]} for the whole command, not run as a test file; remove that option by hand if it must go`,
          };
        // The program a `node runner.js a.js` segment runs: without it the
        // interpreter would run its first argument, or nothing at all, so no
        // rewrite of this word is executable as the same command.
        if (index === scriptAt)
          return {
            reason:
              index + 1 < words.length
                ? `${words[index]} is the script this command runs and it is given arguments (${words.slice(index + 1, index + 3).join(' ')}${words.length > index + 3 ? ' …' : ''}); dropping it would run an argument as the program, so exclude the suites inside the runner instead`
                : `${words[index]} is the script this command runs; dropping it would leave ${posix.basename(words[0])} with no program to run`,
          };
        if (scriptAt >= 0 && index > scriptAt) runnerDropped++;
        edits.push({ span: spans[index], text: '' });
      } else if (runner === 'node-test' && GLOB.test(words[index])) {
        const rest = tests.filter((file) => !drop.has(file));
        if (rest.length) kept++;
        edits.push({ span: spans[index], text: rest.map(shellWord).join(' ') });
      } else if (exclusion[runner]) {
        kept++;
        exclusions.push(...dropped.map(exclusion[runner]));
      } else {
        // Left as is: the files stay unhandled and the caller explains why.
        kept++;
        continue;
      }
      for (const file of dropped) handled.add(file);
    }
    if (named && !kept) return { reason: 'every test file the command names would be dropped' };
    if (runnerFiles && runnerDropped === runnerFiles)
      return {
        reason: `${words[scriptAt]} would get none of its test-file arguments and could then run every suite it loads; drop the suites by hand`,
      };
    if (exclusions.length) edits.push({ span: [spans.at(-1)[1], spans.at(-1)[1]], text: ` ${exclusions.join(' ')}` });
  }
  let command = text;
  for (const { span, text: replacement } of edits.sort((a, b) => b.span[0] - a.span[0]))
    command = command.slice(0, span[0]) + replacement + command.slice(span[1]);
  return { command: command.replace(/[ \t]{2,}/g, ' ').trim(), handled };
}

/**
 * A testCommand that no longer runs `files` (verifier-failure or blocking files,
 * test files or helpers they import), or the reason none can be given. Advisory:
 * the primary reviews it before using it. Handles literal file operands, quoted
 * globs under node --test, pytest/vitest/jest exclusion flags, and a package
 * script whose body is a plain `node` command (inlined, since it needs no
 * node_modules/.bin on PATH).
 */
export function narrowTestCommand({ repoPath, testCommand, denyRead = [], files = [] }) {
  if (!testCommand || !files.length) return undefined;
  const scan = scanVerifier({ repoPath, testCommand, denyRead });
  const drop = new Set();
  for (const file of files) for (const test of scan.named.has(file) ? [file] : scan.testFilesFor(file)) drop.add(test);
  if (!drop.size)
    return {
      reason: files.some((file) => scan.result.resolvedFiles.includes(file))
        ? 'the testCommand loads these files from inline code or a runner, not as file operands'
        : 'the files are not reached by this testCommand',
      drop: [],
    };
  const dropList = [...drop].sort().slice(0, 24);
  const direct = narrowCommandText(testCommand, scan.words, drop);
  if (direct.reason) return { reason: direct.reason, drop: dropList };
  let command = direct.command;
  const left = [...drop].filter((file) => !direct.handled.has(file));
  if (left.length) {
    const scripts = scan.words.filter((entry) => entry.script);
    if (scripts.length !== 1 || scan.words.length !== 1)
      return { reason: 'the files run through a package script or runner whose file list cannot be narrowed here', drop: dropList };
    let body;
    try {
      body = JSON.parse(scan.read('package.json')).scripts?.[scripts[0].script];
    } catch {}
    const inner = typeof body === 'string' ? scanVerifier({ repoPath, testCommand: body, denyRead }) : undefined;
    const runner = inner?.words.length === 1 ? segmentRunner(inner.words[0].words) : undefined;
    if (runner === 'node-test') {
      const narrowed = narrowCommandText(body, inner.words, drop);
      if (narrowed.reason) return { reason: narrowed.reason, drop: dropList };
      if (left.some((file) => !narrowed.handled.has(file)))
        return { reason: `package script "${scripts[0].script}" names these files through a directory`, drop: dropList };
      command = narrowed.command;
    } else if (exclusion[runner]) {
      const separator = posix.basename(scripts[0].words[0]) === 'npm' ? ' --' : '';
      command = `${testCommand.trim()}${separator} ${left.map(exclusion[runner]).join(' ')}`;
    } else
      return { reason: `package script "${scripts[0].script}" runs a command whose file list cannot be narrowed here`, drop: dropList };
  }
  return command && command !== testCommand.trim() ? { command, drop: dropList } : { reason: 'the command did not change', drop: dropList };
}

const BLOCKING_ADVICE = {
  'system-temp-write': 'the verifier can write only its per-run TMPDIR; create it under os.tmpdir() / tempfile without dir=',
  'temp-outside-scope':
    'the verifier can write only ownedPaths, extraWritable and its per-run TMPDIR; create it under os.tmpdir(), or declare it in extraWritable (never integrated)',
};
/** One line per blocking finding: file:line, the resolved target and the fix. */
export function verifierBlockingLines(value, { limit = MAX_FINDINGS } = {}) {
  if (!Array.isArray(value?.blocking)) return [];
  const shown = value.blocking.filter((finding) => BLOCKING_ADVICE[finding?.code] && typeof finding.path === 'string');
  const lines = shown
    .slice(0, limit)
    .map(
      (finding) =>
        `verifier blocker: ${finding.path}${Number.isInteger(finding.line) ? `:${finding.line}` : ''}: ${finding.call || 'write'} ${finding.target} — ${BLOCKING_ADVICE[finding.code]}${finding.extraWritable ? ` (extraWritable: "${finding.extraWritable}")` : ''}${finding.testFiles?.length ? `; run by ${finding.testFiles.join(', ')}` : ''}`,
    );
  return shown.length > lines.length
    ? [...lines, `verifier blocker: ${shown.length - lines.length} more (detail "full" lists them)`]
    : lines;
}
/** Writes in suites a file-filtered runner was not given: reported, never refused. */
function verifierAdvisoryLines(value, { limit = MAX_FINDINGS } = {}) {
  if (!Array.isArray(value?.advisory)) return [];
  const total = Number.isInteger(value.advisoryCount) ? value.advisoryCount : value.advisory.length;
  const files = [...new Set(value.advisory.filter((finding) => typeof finding?.path === 'string').map((finding) => finding.path))];
  if (!files.length) return [];
  const runner = value.advisory[0].runner;
  return [
    `verifier advisory: ${total} denied-write finding(s) in ${files.length === 1 ? files[0] : `${files.length} suites (${files.slice(0, limit).join(', ')}${files.length > limit ? ', …' : ''})`}, which ${runner || 'the runner'} imports but was not given as an argument; not refused (they fail the run only if the runner ignores its file arguments)`,
  ];
}
const narrowingLine = (value) =>
  value?.suggestedTestCommand
    ? `verifier suggestion: drop ${(value.drop ?? []).join(', ')} from testCommand: \`${value.suggestedTestCommand}\` (static rewrite; review before use)`
    : value?.narrowing
      ? `verifier suggestion: drop ${(value.drop ?? []).join(', ') || 'the files above'} from testCommand by hand (${value.narrowing})`
      : undefined;

/** The refusal `offload_start` raises for blocking findings, before any job exists. */
export function verifierBlockingMessage(value) {
  return (
    [
      'verifier preflight refused the start: the testCommand runs writes the verifier sandbox is certain to deny, so the job would end VERIFY_ENV_FAILED after spending its budget.',
      ...verifierBlockingLines(value, { limit: COMPACT_FINDINGS }),
      narrowingLine(value),
      'Fix the tests, declare the listed extraWritable glob, drop the files from testCommand (and check them in the primary), or pass acceptVerifierBlockers: true to start anyway.',
    ]
      .filter(Boolean)
      // MCP error text drops control characters, so newlines would run lines together.
      .join(' | ')
      .slice(0, 3_000)
  );
}

/** Report lines for a stored preflight; `lean` (the compact report) names at most three of each kind. */
export function verifierPreflightLines(value, { lean = false } = {}) {
  if (!value || !Array.isArray(value.warnings)) return [];
  const limit = lean ? COMPACT_FINDINGS : MAX_FINDINGS;
  const advice = {
    'native-import':
      'native Python imports may crash inside the verifier sandbox even with an accepted interpreter declaration; probe the dependencies with health verifierInterpreter + verifierImports before spending, and compare failures in the primary',
    'system-temp': 'hard-coded system temp path may fail with EPERM; use TMPDIR / os.tmpdir() / tempfile',
    'child-process': 'child-process use may fail with spawn EPERM under verifier restrictions; check in the primary before spending',
    'process-inspection':
      'ps / process identity inspection may be denied even when exec is permitted; use an injectable identity probe or verify in the primary',
  };
  return [
    `verifier preflight: ${value.scannedFiles ?? 0} file(s) scanned; static advisory${value.limited ? ' (incomplete)' : ''}, not a sandbox test${value.blockersAccepted ? '; blocking findings accepted by the caller' : ''}`,
    ...verifierBlockingLines(value, { limit }),
    ...verifierAdvisoryLines(value, { limit }),
    ...(value.previousFailures ?? []).map((failure) =>
      failure.inCommand?.length === 0 && failure.files?.length
        ? `verifier session note: ${failure.jobId} (${failure.kind}): ${failure.files.join(', ')} no longer run by this testCommand`
        : `verifier session warning: ${failure.jobId} (${failure.kind}): ${(failure.inCommand ?? failure.files).join(', ') || 'offending files unknown'}; exclude these files from testCommand and check them in the primary before spending again`,
    ),
    narrowingLine(value),
    ...value.warnings
      .filter((w) => advice[w?.code] && typeof w.path === 'string')
      .slice(0, limit)
      .map((w) => `verifier warning: ${w.path}: ${advice[w.code]}`),
    lean && value.warnings.length > limit && `verifier warning: ${value.warnings.length - limit} more (detail "full" lists them)`,
  ].filter(Boolean);
}

const findingView = ({ code, path, line, call, target, extraWritable, runner }) => ({
  code,
  path,
  ...(Number.isInteger(line) ? { line } : {}),
  ...(call ? { call } : {}),
  ...(target ? { target } : {}),
  ...(extraWritable ? { extraWritable } : {}),
  ...(runner ? { runner } : {}),
});
/**
 * The preflight as start, cancel, wait and job responses carry it by default:
 * counts and the first three findings (blocking, then advisory, then
 * warnings). The stored record and detail "full" keep every list.
 */
export function compactVerifierPreflight(value) {
  if (!value || typeof value !== 'object') return value;
  const list = (key) => (Array.isArray(value[key]) ? value[key] : []);
  const advisoryCount = Number.isInteger(value.advisoryCount) ? value.advisoryCount : list('advisory').length;
  const findings = [
    ...list('blocking').map((finding) => ({ severity: 'blocking', ...findingView(finding) })),
    ...list('advisory').map((finding) => ({ severity: 'advisory', ...findingView(finding) })),
    ...list('warnings').map(({ code, path }) => ({ severity: 'warning', code, path })),
  ];
  return {
    ...(value.status ? { status: value.status } : {}),
    scannedFiles: value.scannedFiles ?? 0,
    limited: value.limited === true,
    counts: {
      blocking: list('blocking').length,
      advisory: advisoryCount,
      warnings: list('warnings').length,
      resolvedFiles: list('resolvedFiles').length,
      ...(list('previousFailures').length ? { previousFailures: list('previousFailures').length } : {}),
    },
    ...(findings.length ? { findings: findings.slice(0, COMPACT_FINDINGS) } : {}),
    // Kept whole (a few per session): they name the files to exclude before spending again.
    ...(list('previousFailures').length
      ? {
          previousFailures: list('previousFailures')
            .slice(0, 8)
            .map((failure) => ({
              ...failure,
              ...(Array.isArray(failure?.files) ? { files: failure.files.slice(0, 8) } : {}),
              ...(Array.isArray(failure?.inCommand) ? { inCommand: failure.inCommand.slice(0, 8) } : {}),
            })),
        }
      : {}),
    ...(Array.isArray(value.scoped) ? { scoped: value.scoped.map(({ runner, files }) => ({ runner, files: (files ?? []).length })) } : {}),
    ...(value.suggestedTestCommand ? { suggestedTestCommand: value.suggestedTestCommand } : {}),
    ...(value.narrowing ? { narrowing: value.narrowing } : {}),
    ...(Array.isArray(value.drop) && value.drop.length
      ? { drop: value.drop.slice(0, COMPACT_FINDINGS), dropCount: value.drop.length }
      : {}),
    ...(value.blockersAccepted ? { blockersAccepted: true } : {}),
    ...(findings.length > COMPACT_FINDINGS || list('resolvedFiles').length
      ? { more: 'detail "full" (offload_job or offload_wait) lists every file and finding' }
      : {}),
  };
}
