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
      if (blocking.length >= MAX_FINDINGS || seenWarnings.has(key)) continue;
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
        edge(path, target + suffix);
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
  // The top-level command's words and the files each one names, for narrowing.
  const words0 = [];
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
            enqueue(candidate);
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
  for (const finding of blocking) {
    const testFiles = finding.path === 'testCommand' ? [] : testFilesFor(finding.path);
    if (testFiles.length && !(testFiles.length === 1 && testFiles[0] === finding.path)) finding.testFiles = testFiles.slice(0, 8);
  }
  const result = {
    status: blocking.length ? 'blocking' : warnings.length ? 'warning' : 'unknown',
    scannedFiles: resolvedFiles.size,
    resolvedFiles: [...resolvedFiles],
    commandBytes,
    limited: limited || !resolvedFiles.size,
    warnings,
    ...(blocking.length ? { blocking } : {}),
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
    const exclusions = [];
    let named = 0,
      kept = 0;
    for (const [index, files] of matched.entries()) {
      const tests = [...files].filter((file) => TEST_CODE.test(file));
      if (!tests.length) continue;
      named++;
      const dropped = tests.filter((file) => drop.has(file));
      if (!dropped.length) {
        kept++;
        continue;
      }
      if (tests.length === 1 && tests[0] === words[index].replace(/^\.\//, '')) {
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
export function verifierBlockingLines(value) {
  if (!Array.isArray(value?.blocking)) return [];
  return value.blocking
    .filter((finding) => BLOCKING_ADVICE[finding?.code] && typeof finding.path === 'string')
    .slice(0, MAX_FINDINGS)
    .map(
      (finding) =>
        `verifier blocker: ${finding.path}${Number.isInteger(finding.line) ? `:${finding.line}` : ''}: ${finding.call || 'write'} ${finding.target} — ${BLOCKING_ADVICE[finding.code]}${finding.extraWritable ? ` (extraWritable: "${finding.extraWritable}")` : ''}${finding.testFiles?.length ? `; run by ${finding.testFiles.join(', ')}` : ''}`,
    );
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
      ...verifierBlockingLines(value),
      narrowingLine(value),
      'Fix the tests, declare the listed extraWritable glob, drop the files from testCommand (and check them in the primary), or pass acceptVerifierBlockers: true to start anyway.',
    ]
      .filter(Boolean)
      // MCP error text drops control characters, so newlines would run lines together.
      .join(' | ')
      .slice(0, 3_000)
  );
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
    `verifier preflight: ${value.scannedFiles ?? 0} file(s) scanned; static advisory${value.limited ? ' (incomplete)' : ''}, not a sandbox test${value.blockersAccepted ? '; blocking findings accepted by the caller' : ''}`,
    ...verifierBlockingLines(value),
    ...(value.previousFailures ?? []).map((failure) =>
      failure.inCommand?.length === 0 && failure.files?.length
        ? `verifier session note: ${failure.jobId} (${failure.kind}): ${failure.files.join(', ')} no longer run by this testCommand`
        : `verifier session warning: ${failure.jobId} (${failure.kind}): ${(failure.inCommand ?? failure.files).join(', ') || 'offending files unknown'}; exclude these files from testCommand and check them in the primary before spending again`,
    ),
    narrowingLine(value),
    ...value.warnings
      .filter((w) => advice[w?.code] && typeof w.path === 'string')
      .slice(0, 24)
      .map((w) => `verifier warning: ${w.path}: ${advice[w.code]}`),
  ].filter(Boolean);
}
