import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { escapeRegExp, matchesAny } from './glob.mjs';
import { PathPolicy } from './policy.mjs';
import { readRegularFileSync } from './regular-file.mjs';
import { SYSTEM_TEMP_PATH } from './verify-env.mjs';

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
        parts = body.split(/(\$\{[^{}]+\})/);
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

const MAX_FINDINGS = 24;
// Findings a compact response or refusal names before counting the rest.
const COMPACT_FINDINGS = 3;
// Collected before runner scoping demotes some, so that a selected suite's
// finding is never crowded out by the suites the runner was not given.
const MAX_SCAN_FINDINGS = 256;
// Calls that create or write a path. Only their first argument (Python: dir=)
// is resolved; a call whose target cannot be resolved statically is ignored.
// A member call may not take a path at all: a FileHandle's writeFile takes data.
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

// A `${...}` interpolation. It never spans another `{`, so a run of `${`
// cannot be rescanned from every position.
const INTERPOLATION = /\$\{[^{}]*\}/g;
// Stands in for a value the scan cannot know, inside a resolved path. It never
// leaves this file: findings render it as DYNAMIC_LABEL.
const DYNAMIC_SEGMENT = 'OFFLOAD_UNRESOLVED_VALUE';
const DYNAMIC_LABEL = '<dynamic>';
const shownTarget = (path) => path.replaceAll(DYNAMIC_SEGMENT, DYNAMIC_LABEL);
/** The index of the `)` closing the `(` just before `from`, skipping quoted text; -1 when unbalanced. */
function closingParen(text, from) {
  for (let i = from, depth = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') {
      const end = text.indexOf(c, i + 1);
      if (end < 0) return -1;
      i = end;
    } else if (c === '(') depth++;
    else if (c === ')') {
      if (depth === 0) return i;
      depth--;
    }
  }
  return -1;
}

/**
 * Statically resolve a path expression in `file` to where it lands:
 * `{ kind: 'repo', path }` (relative to the worktree root, where the verifier
 * runs), `{ kind: 'system', path }` (a hard-coded system temp path),
 * `{ kind: 'tmp' }` (TMPDIR-based) or `{ kind: 'other' }`; undefined when it
 * cannot be resolved. Interpolations become DYNAMIC_SEGMENT: a known directory
 * still places the write, and an unknown leading one means it is not placed.
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
    if (lead) return append(resolvePathExpression(lead[1], context, depth + 1), lead[2].replace(INTERPOLATION, DYNAMIC_SEGMENT));
    return literal(body.replace(INTERPOLATION, DYNAMIC_SEGMENT));
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
  // The argument is found by matching its parenthesis, not by a lazy regex
  // group, so a long expression cannot make the match backtrack.
  const pathCall = /^(?:pathlib\.)?Path\(/.exec(expr);
  const close = pathCall ? closingParen(expr, pathCall[0].length) : -1;
  if (
    close > 0 &&
    (match = /^((?:\.(?:resolve|absolute)\(\))*)((?:\.parent)*)((?:\s*\/\s*(['"])[^'"\\]*\4)*)$/.exec(expr.slice(close + 1)))
  ) {
    let base = resolvePathExpression(expr.slice(pathCall[0].length, close), context, depth + 1);
    for (let n = match[2].split('.parent').length - 1; n > 0 && base?.kind === 'repo'; n--)
      base = { kind: 'repo', path: dirname(base.path) === '.' ? '' : dirname(base.path) };
    for (const [, , part] of match[3].matchAll(/(['"])([^'"\\]*)\1/g)) base = append(base, part);
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
      // interpolations become DYNAMIC_SEGMENT.
      const quoted = /^(['"])([^'"\\]*)\1$/.exec(part)?.[2] ?? /^`([^`]*)`$/.exec(part)?.[1].replace(INTERPOLATION, DYNAMIC_SEGMENT);
      if (quoted !== undefined) base = append(base, quoted);
      else {
        // A segment bound to a literal places the write as surely as the literal would.
        const bound = resolvePathExpression(part, context, depth + 1);
        base = bound?.kind === 'system' ? { kind: 'other' } : append(base, bound?.kind === 'repo' ? bound.path : DYNAMIC_SEGMENT);
      }
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
    if (binding) {
      // A trailing Python comment: cut at the first `#` after whitespace, then the whitespace.
      const comment = binding[1].search(/\s#/);
      const value = comment < 0 ? binding[1] : binding[1].slice(0, comment).trimEnd();
      return resolvePathExpression(value, { file, text, at: binding.index, inCode }, depth + 1);
    }
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

/** The codeMask test above plus module scope: a call outside any function or
 * callback runs whenever the file is imported, whatever a runner selects. */
function sourceScopes(text, python) {
  const inCode = codeMask(text, python);
  const depth = new Int32Array(text.length + 1);
  for (let i = 0, level = 0; i < text.length; i++) {
    depth[i] = level;
    if (!inCode(i)) continue;
    if ('([{'.includes(text[i])) level++;
    else if (')]}'.includes(text[i])) level = Math.max(0, level - 1);
  }
  const atModuleScope = (index) =>
    python ? !/[ \t]/.test(text[text.lastIndexOf('\n', index - 1) + 1] ?? '') && depth[index] === 0 : depth[index] === 0;
  return { inCode, atModuleScope, depth };
}
// A listener call: only where it is code does it open a socket.
const LISTENER_CALL =
  /\b(?:createServer|createSecureServer)\s*\(|\b(?:app|server|srv|httpServer|httpsServer|fastify)\.listen\s*\(|\bHTTPServer\s*\(|\bsocket\.bind\s*\(/;
const UNCERTAIN_WRITE = 'write-target-unresolved';
const globLiteral = (path) => !/[*?[\]{}]/.test(path);

/**
 * Writes the verifier sandbox is certain to deny: a hard-coded system temp
 * path, or a worktree path outside the job's write scope. Each finding names
 * the file, line and resolved target, plus the narrow extraWritable glob that
 * would cover a worktree target. A target whose leading segment is unknown is
 * not certain of anything, so it gets its own code (UNCERTAIN_WRITE), which
 * scanVerifier reports without refusing.
 */
function writeFindings(text, file, { repoPath, writeScope }) {
  const findings = [];
  const add = (call, index, target, temp) => {
    // Certain findings have their own cap: unplaced targets must not crowd out a real denial.
    if (!target || findings.filter((finding) => finding.code !== UNCERTAIN_WRITE).length >= MAX_FINDINGS) return;
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
      findings.push({
        code: 'system-temp-write',
        path: file,
        line,
        call,
        target: shownTarget(temp ? `${target.path}XXXXXX` : target.path),
      });
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
    if (node.startsWith(DYNAMIC_SEGMENT)) {
      if (findings.filter((finding) => finding.code === UNCERTAIN_WRITE).length < MAX_FINDINGS)
        findings.push({ code: UNCERTAIN_WRITE, path: file, line, call, target: shownTarget(node) });
      return;
    }
    // With a dynamic name, the literal text before it is all a glob can honestly cover.
    const dynamicAt = target.path.indexOf(DYNAMIC_SEGMENT);
    const glob =
      dynamicAt >= 0
        ? `${target.path.slice(0, dynamicAt)}**`
        : temp
          ? `${target.path}**`
          : /^mkdir|^makedirs/.test(call)
            ? `${node}/**`
            : node;
    findings.push({
      code: 'temp-outside-scope',
      path: file,
      line,
      call,
      target: shownTarget(node),
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
        // Shell expansion ($VAR, $(..), backticks, ~) is not resolved statically, so a relative operand is not a repo-relative
        // literal. An absolute operand keeps its literal prefix (/tmp/$USER-x is still a system-temp write).
        if (!value.startsWith('/') && /[$`]|^~/.test(value)) continue;
        const target = resolvePathExpression(JSON.stringify(value), { file, text });
        // A relative mktemp operand is a template, often TMPDIR-based (-t).
        if (name === 'mkdir' || target?.kind === 'system') add(name, text.indexOf(word), target, false);
      }
    }
    return findings;
  }
  // A write at module scope runs whenever the file is imported, whatever a
  // runner then selects; one inside a function or callback runs only if called.
  const source = sourceScopes(text, file.endsWith('.py'));
  const { inCode } = source;
  atModuleScope = source.atModuleScope;
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

/**
 * Every listener call that is code, not a mention in a fixture's string
 * literal, comment or regex, with the line it opens on and whether it runs at
 * module scope. Which one may block depends on the import graph, so
 * scanVerifier decides reachability once it has scanned the closure.
 */
function listenerCandidates(text, file) {
  const { inCode, atModuleScope } = sourceScopes(text, file.endsWith('.py'));
  return [...text.matchAll(new RegExp(LISTENER_CALL, 'g'))]
    .filter((match) => inCode(match.index))
    .map((match) => ({ index: match.index, line: lineOf(text, match.index), moduleScope: atModuleScope(match.index) }));
}

// Words that look like a call but only open a block or an expression.
const NOT_A_CALL = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'function',
  'return',
  'typeof',
  'new',
  'await',
  'do',
  'else',
  'try',
  'with',
  'yield',
  'delete',
  'void',
  'instanceof',
  'case',
  'throw',
  'super',
  'import',
  'export',
]);
const CALL_SITE = /([A-Za-z_$][\w$]*)\s*\(/g;
// A bare name handed to a call: `app.on('ready', startServer)` runs it too.
const CALL_ARGUMENT = /[,(]\s*([A-Za-z_$][\w$]*)\s*[,)]/g;
const FUNCTION_HEADER = /(?:^|[^\w$.])(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/g;
const ASSIGNED_FUNCTION =
  /(?:^|[^\w$.])(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function\b|\([^()]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/g;
const PROPERTY_FUNCTION = /(?:^|[,{;\n])\s*([A-Za-z_$][\w$]*)\s*:\s*(?:async\s+)?(?:function\b|\([^()]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/g;
const METHOD_FUNCTION = /^[ \t]*(?:(?:static|async|get|set)\s+)*([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*\{/gm;
const PY_DEF = /(?:^|\n)([ \t]*)(?:async\s+)?def\s+([A-Za-z_$][\w$]*)\s*\(/g;

/** The brace a function header opens, or -1 when the arrow has an expression body. */
function functionBodyStart(text, inCode, from) {
  let parens = 0;
  for (let index = from; index < Math.min(text.length, from + 400); index++) {
    if (!inCode(index)) continue;
    const char = text[index];
    if (char === '(') parens++;
    else if (char === ')') parens = Math.max(0, parens - 1);
    else if (char === '{' && !parens) return index;
    else if (char === ';' && !parens) return -1;
  }
  return -1;
}
/** Where an expression-bodied arrow ends: the next `;`, `,`, newline or closing bracket. */
function expressionEnd(text, inCode, from) {
  let parens = 0;
  for (let index = from; index < text.length; index++) {
    if (!inCode(index)) continue;
    const char = text[index];
    if ('([{'.includes(char)) parens++;
    else if (')]}'.includes(char)) {
      if (!parens) return index;
      parens--;
    } else if (!parens && (char === ';' || char === ',' || char === '\n')) return index;
  }
  return text.length;
}
/** A Python block: the first following line that is not more indented than its `def`. */
function pythonBlockEnd(text, from, indent) {
  for (let index = from; index < text.length;) {
    const lineEnd = text.indexOf('\n', index);
    const line = text.slice(index, lineEnd < 0 ? text.length : lineEnd);
    if (line.trim() && !line.trimStart().startsWith('#') && (line.match(/^[ \t]*/) ?? [''])[0].length <= indent) return index;
    if (lineEnd < 0) break;
    index = lineEnd + 1;
  }
  return text.length;
}
/** Function boundaries of one file, by brace depth or indentation: enough to
 * name the functions a call sits inside. Light lexing, not a parser. */
function functionScopes(text, python, inCode, depth) {
  const scopes = [];
  const add = (name, nameIndex, start, end) => {
    if (name && NOT_A_CALL.has(name)) return;
    if (end > start) scopes.push({ name, nameIndex, start, end });
  };
  if (python) {
    for (const match of text.matchAll(PY_DEF)) {
      const name = match[2];
      const nameIndex = match.index + match[0].lastIndexOf(name);
      if (!inCode(nameIndex)) continue;
      const lineEnd = text.indexOf('\n', match.index);
      add(name, nameIndex, nameIndex, pythonBlockEnd(text, lineEnd < 0 ? text.length : lineEnd + 1, match[1].length));
    }
    return scopes;
  }
  for (const pattern of [FUNCTION_HEADER, ASSIGNED_FUNCTION, PROPERTY_FUNCTION, METHOD_FUNCTION]) {
    for (const match of text.matchAll(pattern)) {
      const name = match[1];
      const nameIndex = match.index + match[0].indexOf(name);
      if (!inCode(nameIndex)) continue;
      // A method header's match already ends on its body brace; start the body search on it.
      const from = match.index + match[0].length - (pattern === METHOD_FUNCTION ? 1 : 0);
      const brace = functionBodyStart(text, inCode, from);
      if (brace < 0) {
        add(name, nameIndex, nameIndex, expressionEnd(text, inCode, from));
        continue;
      }
      let end = text.length;
      for (let index = brace + 1; index < text.length; index++)
        if (text[index] === '}' && inCode(index) && depth[index] === depth[brace] + 1) {
          end = index;
          break;
        }
      add(name, nameIndex, brace, end);
    }
  }
  return scopes;
}
/** Whether an index sits inside a call's parentheses rather than an export list. */
function insideCall(text, inCode, index) {
  let depth = 0;
  for (let at = index - 1; at >= 0; at--) {
    if (!inCode(at)) continue;
    const char = text[at];
    if (char === ')') depth++;
    else if (char === '(') {
      if (!depth) return true;
      depth--;
    } else if (!depth && (char === ';' || char === '{' || char === '}')) return false;
  }
  return false;
}
/** The calls, definitions and function chains of one file: the raw material for
 * deciding whether a function that opens a listener ever runs. */
function callAnalysis(text, file) {
  const python = file.endsWith('.py');
  const { inCode, depth } = sourceScopes(text, python);
  const scopes = functionScopes(text, python, inCode, depth);
  const definitions = new Map();
  for (const scope of scopes) {
    if (!scope.name) continue;
    if (!definitions.has(scope.name)) definitions.set(scope.name, []);
    definitions.get(scope.name).push(scope.nameIndex);
  }
  const inside = (index) => scopes.some((scope) => scope.start <= index && index <= scope.end);
  const chainAt = (index) =>
    scopes
      .filter((scope) => scope.start <= index && index <= scope.end && scope.name)
      .sort((a, b) => b.start - a.start)
      .map((scope) => scope.name);
  const calls = [];
  const add = (name, index) => {
    if (NOT_A_CALL.has(name) || (definitions.get(name) ?? []).includes(index)) return;
    calls.push({ name, index, module: !inside(index), chain: chainAt(index) });
  };
  for (const match of text.matchAll(CALL_SITE)) if (inCode(match.index)) add(match[1], match.index);
  // A name handed to a call at module scope runs when the module loads.
  for (const match of text.matchAll(CALL_ARGUMENT)) {
    if (!inCode(match.index)) continue;
    const at = match.index + match[0].indexOf(match[1]);
    if (inside(at) || !insideCall(text, inCode, at)) continue;
    add(match[1], at);
  }
  return { calls, chainAt, names: new Set(definitions.keys()) };
}

/** Never executes repository code or widens verifier permissions. Follows
 * literal command paths, package scripts and local imports; dynamic imports,
 * runner config and external packages require a real primary check. Returns
 * the public result plus the import graph and command words narrowing needs. */
function scanVerifier({ repoPath, testCommand, denyRead = [], writeScope, ownedPaths, loopbackDenied = false }) {
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
  const uncertainFound = [];
  const block = (findings) => {
    for (const finding of findings) {
      const key = `${finding.code}:${finding.path}:${finding.line}`;
      // Collected apart, so that targets the scan cannot place never crowd out a real denial.
      const list = finding.code === UNCERTAIN_WRITE ? uncertainFound : blocking;
      if (list.length >= MAX_SCAN_FINDINGS || seenWarnings.has(key)) continue;
      seenWarnings.add(key);
      list.push(finding);
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
      /(?:^|[;\n])[ \t]*(?:from\s+(?:torch|numpy|scipy|tensorflow|jax|cv2|pandas)(?:[.\s])|import\s[^;\n#]*\b(?:torch|numpy|scipy|tensorflow|jax|cv2|pandas)\b)/.test(
        text,
      )
    )
      warn('native-import', path);
    // A test that opens a TCP listener: the verifier sandbox denies bind unless
    // verifier.allowLoopback is on, and under Node the EPERM can abort the run.
    if (LISTENER_CALL.test(text)) warn('loopback-listen', path);
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
  // The listener call in code each read file has, if any (a raw-text mention is only a warning).
  const listeners = new Map();
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
    // Every file, helpers included: a listener they import may run too.
    if (!listeners.has(path)) listeners.set(path, listenerCandidates(text, path));
    resolvedFiles.add(path);
    inspect(text, path);
    references(text, path, argv);
    if (path.endsWith('.py')) {
      for (const [, module] of text.matchAll(/(?:^|\n)[ \t]*(?:from|import)\s+([\w.]+)/g)) {
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
  const selectedSuites = new Set();
  const scopeUnavailable = [];
  const missingArguments = [];
  // A runner argument the worker will create (inside ownedPaths) names a suite
  // that does not exist yet: pending, so the rest of its folder is unselected.
  const owned = (ownedPaths ?? []).filter((entry) => typeof entry === 'string');
  const ownedLiterals = owned.filter((entry) => !GLOB.test(entry));
  const walked = [...available];
  const isOwned = (file) => {
    try {
      return matchesAny(file, owned);
    } catch {
      return false;
    }
  };
  // The path a missing argument would be, when ownedPaths says the worker creates it.
  const pendingPath = (operand, direct) => {
    if (operand.includes('/')) return isOwned(operand) ? operand : undefined;
    const named = ownedLiterals.filter((entry) => entry.endsWith(`/${operand}`)).sort();
    const fromSuite = direct
      .map((file) => `${dirname(file)}/${operand}`)
      .filter((file) => isOwned(file))
      .sort();
    return named[0] ?? fromSuite[0];
  };
  const scopes = [...new Set(runners.map((runner) => runner.path))].flatMap((path) => {
    const calls = runners.filter((runner) => runner.path === path);
    if (!resolvedFiles.has(path) || calls.some((call) => !call.operands.length)) return [];
    const operands = calls.flatMap((call) => call.operands);
    const direct = [...(edges.get(path) ?? [])];
    const selected = direct.filter((file) => operands.some((operand) => file === operand || file.endsWith(`/${operand}`)));
    // Missing: no file the walk found bears the operand's path or bare name.
    // Pending: a missing operand the worker will create (it is inside ownedPaths).
    const pending = [];
    const missing = [];
    for (const operand of new Set(operands)) {
      if (walked.some((file) => file === operand || file.endsWith(`/${operand}`))) continue;
      const target = pendingPath(operand, direct);
      if (!target) missing.push(operand);
      else if (!pending.includes(target)) pending.push(target);
    }
    if (!selected.length && !pending.length) {
      if (missing.length) missingArguments.push({ runner: path, files: missing.sort().slice(0, MAX_FINDINGS), scoped: false });
      return [];
    }
    for (const file of selected) selectedSuites.add(file);
    const closure = new Set(selected.flatMap((file) => [...reachable(file)]));
    const unread = [...closure].filter((file) => !resolvedFiles.has(file)).length;
    if (unread) {
      scopeUnavailable.push({ runner: path, unreadFiles: unread });
      if (missing.length) missingArguments.push({ runner: path, files: missing.sort().slice(0, MAX_FINDINGS), scoped: false });
      return [];
    }
    const folders = new Set([...selected, ...pending].map((file) => dirname(file)));
    const suites = direct.filter((file) => !selected.includes(file) && TEST_CODE.test(file) && folders.has(dirname(file)));
    const scope = suites.length ? [{ runner: path, selected, pending: pending.sort(), suites }] : [];
    if (missing.length) missingArguments.push({ runner: path, files: missing.sort().slice(0, MAX_FINDINGS), scoped: scope.length > 0 });
    return scope;
  });
  // A warning names the suites the command runs that reach it, like blocking findings do.
  function warningTestFiles(path) {
    if (path === 'testCommand') return [];
    const bySuite = [...selectedSuites].filter((suite) => reachable(suite).has(path)).sort();
    const testFiles = bySuite.length ? bySuite : testFilesFor(path);
    return testFiles.length && !(testFiles.length === 1 && testFiles[0] === path) ? testFiles.slice(0, 8) : [];
  }
  // A listener is refused only when a suite the command runs reaches code that
  // calls the function which opens it: one inside a named function nothing
  // calls (an imported module's `startServer`) never binds, so it stays a
  // warning. Module scope always runs, and a listener written in the suite
  // itself runs with its test callbacks.
  const analyses = new Map();
  const analyze = (path) => {
    if (!analyses.has(path)) {
      const text = cache.get(path);
      analyses.set(path, typeof text === 'string' ? callAnalysis(text, path) : undefined);
    }
    return analyses.get(path);
  };
  const isSuiteFile = (path) => named.has(path) || selectedSuites.has(path);
  const listenerDecision = (path) => {
    const candidates = listeners.get(path);
    if (!Array.isArray(candidates) || !candidates.length) return undefined;
    const moduleScoped = candidates.find((candidate) => candidate.moduleScope);
    if (moduleScoped) return { candidate: moduleScoped, reachable: true };
    const analysis = analyze(path);
    if (isSuiteFile(path) || !analysis) return { candidate: candidates[0], reachable: true };
    // Names called anywhere in the closure of a suite that reaches this file,
    // plus the fixpoint of calls from that file's own module scope.
    const called = new Set();
    for (const root of [...named, ...selectedSuites])
      if (root !== path && TEST_CODE.test(root) && reachable(root).has(path))
        for (const file of reachable(root)) {
          if (file === path) continue;
          for (const call of analyze(file)?.calls ?? []) called.add(call.name);
        }
    const reached = new Set([...called].filter((name) => analysis.names.has(name)));
    for (let changed = true; changed;) {
      changed = false;
      for (const call of analysis.calls) {
        if (reached.has(call.name) || !analysis.names.has(call.name)) continue;
        if (call.module || call.chain.some((name) => reached.has(name))) {
          reached.add(call.name);
          changed = true;
        }
      }
    }
    const runs = (candidate) => {
      const chain = analysis.chainAt(candidate.index);
      // An anonymous callback's caller is not visible here: err toward running.
      return !chain.length || chain.some((name) => reached.has(name));
    };
    const chosen = candidates.find(runs);
    return { candidate: chosen ?? candidates[0], reachable: Boolean(chosen) };
  };
  const decisions = new Map();
  const listenerDecisionFor = (path) => {
    if (!decisions.has(path)) decisions.set(path, listenerDecision(path));
    return decisions.get(path);
  };
  const listenerFinding = (path) => {
    const decision = listenerDecisionFor(path);
    if (!decision?.reachable) return undefined;
    const finding = { code: 'loopback-listen', path, line: decision.candidate.line };
    // Not serialized: only runner scoping reads it.
    if (decision.candidate.moduleScope) Object.defineProperty(finding, 'moduleScope', { value: true });
    return finding;
  };
  // A listener no suite calls stays a warning, flagged so a report can say why.
  for (const warning of warnings) {
    if (warning.code !== 'loopback-listen' || warning.path === 'testCommand') continue;
    const decision = listenerDecisionFor(warning.path);
    if (decision && !decision.reachable) warning.unreached = true;
  }
  // A listener the sandbox would deny bind on is a blocker once a suite the
  // command names runs the code that opens it. Done before the runner scoping
  // below, so a listener only an unselected runner suite runs is demoted like
  // any other finding outside the suites that runner was given as arguments.
  if (loopbackDenied) {
    const promotedFindings = new Map();
    const blockingListener = (path) => {
      if (!promotedFindings.has(path)) promotedFindings.set(path, listenerFinding(path));
      return promotedFindings.get(path);
    };
    const promoted = warnings.filter(
      (warning) =>
        warning.code === 'loopback-listen' &&
        warning.path !== 'testCommand' &&
        blockingListener(warning.path) &&
        (warningTestFiles(warning.path).length > 0 || (named.has(warning.path) && TEST_CODE.test(warning.path))),
    );
    for (const warning of promoted) {
      const finding = blockingListener(warning.path);
      const testFiles = warningTestFiles(warning.path);
      if (testFiles.length) finding.testFiles = testFiles;
      // The finding itself, so a non-enumerable moduleScope survives: runner scoping reads it.
      blocking.push(finding);
    }
    if (promoted.length) warnings.splice(0, warnings.length, ...warnings.filter((warning) => !promoted.includes(warning)));
  }
  // Not certain to be denied, so never refused; scoping treats them like the rest.
  let uncertain = uncertainFound;
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
    uncertain = uncertain.filter((finding) => finding.moduleScope || !unselected(finding.path));
    const before = warnings.length;
    warnings.splice(0, warnings.length, ...warnings.filter((warning) => warning.path === 'testCommand' || !unselected(warning.path)));
    scopedWarnings = before - warnings.length;
  }
  // Every warning names the test files the command runs that reach it.
  for (const warning of warnings) {
    const testFiles = warningTestFiles(warning.path);
    if (testFiles.length) warning.testFiles = testFiles;
  }
  blocking.splice(MAX_FINDINGS);
  for (const finding of [...blocking, ...uncertain]) {
    // Naming the runner says nothing when it was given files: name those that reach the write.
    const bySuite = finding.path === 'testCommand' ? [] : [...selectedSuites].filter((suite) => reachable(suite).has(finding.path)).sort();
    const testFiles = bySuite.length ? bySuite : finding.path === 'testCommand' ? [] : testFilesFor(finding.path);
    if (testFiles.length && !(testFiles.length === 1 && testFiles[0] === finding.path)) finding.testFiles = testFiles.slice(0, 8);
  }
  // A blocker in a file the job owns is a file testCommand must run: "drop it
  // from testCommand" would drop the job's own test, so name the test it fails
  // in and, when the runner can, the command that skips only that test.
  // Findings that cannot fire are advisory, never refused: the test is skipped by a
  // test-name filter already in testCommand, or by a sandbox skip guard.
  const kept = [];
  for (const finding of blocking) {
    if (finding.path === 'testCommand') {
      kept.push(finding);
      continue;
    }
    const text = cache.get(finding.path);
    const testCase = typeof text === 'string' ? enclosingTestCase(text, finding.path, finding.line) : undefined;
    const owned = [finding.path, ...(finding.testFiles ?? [])].some((file) => isOwned(file));
    if (owned && testCase?.name) finding.testName = testCase.name;
    // A test declared `{ skip: !sandboxAvailable() ... }` skips inside the verifier: sandbox-exec cannot nest there.
    if (testCase?.sandboxGuarded) {
      advisory.push({ ...finding, skippedBy: 'sandbox-guard' });
      continue;
    }
    if (owned && testCase?.name && testNameFilteredOut(testCommand, testCase.name)) {
      advisory.push({ ...finding, skippedBy: 'test-name-filter' });
      continue;
    }
    if (owned) finding.mustRun = true;
    kept.push(finding);
  }
  blocking.splice(0, blocking.length, ...kept);
  const mustRunBlockers = blocking.filter((finding) => finding.mustRun).length;
  const namedBlocker = blocking.find((finding) => finding.mustRun && typeof finding.testName === 'string');
  const testNameExclusion = namedBlocker ? testNameExclusionFor(testCommand, namedBlocker.testName) : undefined;
  const result = {
    status: blocking.length ? 'blocking' : warnings.length || advisory.length || uncertain.length ? 'warning' : 'unknown',
    scannedFiles: resolvedFiles.size,
    resolvedFiles: [...resolvedFiles],
    commandBytes,
    limited: limited || !resolvedFiles.size,
    warnings,
    ...(blocking.length ? { blocking } : {}),
    ...(uncertain.length ? { uncertain: uncertain.slice(0, MAX_FINDINGS), uncertainCount: uncertain.length } : {}),
    ...(scopeUnavailable.length ? { scopeUnavailable: scopeUnavailable.slice(0, MAX_FINDINGS) } : {}),
    ...(missingArguments.length ? { missingArguments: missingArguments.slice(0, MAX_FINDINGS) } : {}),
    ...(mustRunBlockers ? { mustRunBlockers } : {}),
    ...(testNameExclusion ? { testNameExclusion } : {}),
    ...(advisory.length ? { advisory: advisory.slice(0, MAX_FINDINGS), advisoryCount: advisory.length } : {}),
    ...(scopes.length
      ? {
          scoped: scopes.map(({ runner, selected, pending }) => ({
            runner,
            files: [...selected, ...pending].sort().slice(0, MAX_FINDINGS),
            ...(pending.length ? { pending: pending.slice(0, MAX_FINDINGS) } : {}),
          })),
          ...(scopedWarnings ? { scopedWarnings } : {}),
        }
      : {}),
    note: 'Static advisory; dynamic imports, runner configuration and external packages are not fully analyzed. No test was run.',
  };
  return { result, words: words0, named, testFilesFor, read };
}

/** The public static preflight of a testCommand (undefined without one). Pass
 * the job's write scope (ownedPaths + extraWritable) to get `blocking` findings:
 * writes the verifier sandbox is certain to deny. `loopbackDenied` (the sandbox
 * denies bind, because verifier.allowLoopback is off) adds a listener a named
 * suite reaches to `blocking` as well. */
export function preflightVerifier({ repoPath, testCommand, denyRead = [], writeScope, ownedPaths, loopbackDenied = false }) {
  if (!testCommand) return undefined;
  return scanVerifier({ repoPath, testCommand, denyRead, writeScope, ownedPaths, loopbackDenied }).result;
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
  jest: (file) => `--testPathIgnorePatterns ${shellWord(escapeRegExp(file))}`,
};

const TEST_CALL = /\b(?:test|it)\s*\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;
const PY_TEST_DEF = /(?:^|\n)([ \t]*)(?:async\s+)?def\s+(test\w*)\s*\(/g;

/** The innermost test case whose body spans a line: the name a per-test filter
 * skips, and whether its options object skips it inside the verifier sandbox. */
function enclosingTestCase(text, file, line) {
  const python = file.endsWith('.py');
  const { inCode } = sourceScopes(text, python);
  let best;
  const body = (start, end, name, sandboxGuarded = false) => {
    if (line < lineOf(text, start) || line > lineOf(text, end)) return;
    if (!best || end - start < best.end - best.start) best = { name, start, end, sandboxGuarded };
  };
  if (python) {
    for (const match of text.matchAll(PY_TEST_DEF)) {
      if (!inCode(match.index)) continue;
      // The match starts at the newline before the def; the def line itself ends the header.
      const defStart = text[match.index] === '\n' ? match.index + 1 : match.index;
      const lineEnd = text.indexOf('\n', defStart);
      body(defStart, pythonBlockEnd(text, lineEnd < 0 ? text.length : lineEnd + 1, match[1].length), match[2]);
    }
    return best && { name: best.name, sandboxGuarded: false };
  }
  // The code-only view of text[from, to): strings and comments blanked.
  const codeOnly = (from, to) => {
    let out = '';
    for (let at = from; at < to; at++) out += inCode(at) ? text[at] : ' ';
    return out;
  };
  for (const match of text.matchAll(TEST_CALL)) {
    if (!inCode(match.index)) continue;
    const open = text.indexOf('(', match.index);
    let depth = 0;
    let end = text.length;
    for (let at = open; at < text.length; at++) {
      if (!inCode(at)) continue;
      if (text[at] === '(') depth++;
      else if (text[at] === ')' && !--depth) {
        end = at;
        break;
      }
    }
    body(match.index, end, match[2], sandboxSkipGuard(text, match.index + match[0].length, end, inCode, codeOnly));
  }
  return best && { name: best.name, sandboxGuarded: best.sandboxGuarded };
}

/** Whether `test(name, { skip: <expr> }, fn)` skips on a sandbox: `from` is just
 * after the name. Nested sandbox-exec cannot run inside the verifier sandbox, so a
 * test that skips when the sandbox is unavailable (a `sandbox...()` call, or a
 * SANDBOX identifier in `skip`) skips there and cannot fire its finding. Other
 * skip expressions (a platform or binary check) still run on the verifier. */
function sandboxSkipGuard(text, from, limit, inCode, codeOnly) {
  let at = from;
  const next = () => {
    while (at < limit && /\s/.test(text[at])) at++;
    return text[at];
  };
  if (next() !== ',') return false;
  at++;
  if (next() !== '{') return false;
  const open = at;
  let depth = 0;
  let close = limit;
  for (let i = open; i < limit; i++) {
    if (!inCode(i)) continue;
    if ('([{'.includes(text[i])) depth++;
    else if (')]}'.includes(text[i]) && !--depth) {
      close = i;
      break;
    }
  }
  const options = codeOnly(open + 1, close);
  const key = /(?:^|[\s,{])skip\s*:/.exec(options);
  if (!key) return false;
  let expr = '';
  depth = 0;
  for (let i = key.index + key[0].length; i < options.length; i++) {
    const c = options[i];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === ',' && depth === 0) break;
    if (depth < 0) break;
    expr += c;
  }
  return /\bsandbox\w*\s*\(/i.test(expr) || /\w*SANDBOX\w*/.test(expr);
}

const compileNamePattern = (value) => {
  try {
    const literal = /^\/([\s\S]*)\/([a-z]*)$/.exec(value);
    return literal ? new RegExp(literal[1], literal[2]) : new RegExp(value);
  } catch {
    return undefined;
  }
};
// The `-k` expression forms this module emits: `not a and not b`. Anything richer is not parsed.
const pytestSkippedNames = (expr) => {
  const terms = expr.trim().split(/\s+and\s+/);
  const names = terms.map((term) => /^not\s+(\S.*)$/.exec(term)?.[1]);
  return names.every(Boolean) ? names : undefined;
};
// The jest/vitest pattern this module emits: a negative lookahead around the escaped name.
const NEGATIVE_LOOKAHEAD = /^\^\(\?!\.\*([\s\S]*)\)\.\*\$$/;
/** The occurrences of flag names (`--flag=V` or `--flag V`) in a segment's words: value and its word index. */
function flagOccurrences(words, flags) {
  const found = [];
  for (const [index, word] of words.entries())
    for (const flag of flags) {
      if (word === flag && index + 1 < words.length) found.push({ value: words[index + 1], index: index + 1, inline: false });
      else if (word.startsWith(`${flag}=`)) found.push({ value: word.slice(flag.length + 1), index, inline: true });
    }
  return found.sort((a, b) => a.index - b.index);
}
/** Whether one runner segment's test-name filters already keep `testName` from running. */
function segmentExcludes(runner, words, testName) {
  if (runner === 'node-test') {
    const compiled = (flag) =>
      flagOccurrences(words, [flag])
        .map((occurrence) => compileNamePattern(occurrence.value))
        .filter(Boolean);
    const skips = compiled('--test-skip-pattern');
    const selects = compiled('--test-name-pattern');
    return skips.some((re) => re.test(testName)) || (selects.length > 0 && !selects.some((re) => re.test(testName)));
  }
  if (runner === 'pytest') {
    const last = flagOccurrences(words, ['-k']).at(-1);
    const names = last && pytestSkippedNames(last.value);
    return Boolean(names?.some((name) => testName.toLowerCase().includes(name.toLowerCase())));
  }
  if (runner === 'jest' || runner === 'vitest') {
    const last = flagOccurrences(words, runner === 'jest' ? ['--testNamePattern', '-t'] : ['-t']).at(-1);
    if (!last || !NEGATIVE_LOOKAHEAD.test(last.value)) return false;
    const re = compileNamePattern(last.value);
    return Boolean(re) && !re.test(testName);
  }
  return false;
}
/** Whether every test runner in testCommand already filters `testName` out (so it never runs). */
function testNameFilteredOut(text, testName) {
  const runners = commandSegments(text)
    .segments.map((words) => [segmentRunner(words), words])
    .filter(([runner]) => runner);
  return runners.length > 0 && runners.every(([runner, words]) => segmentExcludes(runner, words, testName));
}

/** A command that skips only the named test, or why this runner has no such filter.
 * Undefined when testCommand already excludes it. */
function testNameExclusionFor(text, testName) {
  const pattern = escapeRegExp(testName);
  const { segments, spans } = commandSegments(text);
  let excluded = false;
  for (const [index, words] of segments.entries()) {
    const runner = segmentRunner(words);
    if (!runner) continue;
    if (segmentExcludes(runner, words, testName)) {
      excluded = true;
      continue;
    }
    const end = spans[index].at(-1)?.[1] ?? text.length;
    const replaceWord = (word, replacement) => {
      const [from, to] = spans[index][word];
      return `${text.slice(0, from)}${replacement}${text.slice(to)}`;
    };
    if (runner === 'node-test') {
      const insert = spans[index][words.indexOf('--test')]?.[1];
      if (insert === undefined) continue;
      const skip = `--test-skip-pattern=${shellWord(pattern)}`;
      return { testName, command: `${text.slice(0, insert)} ${skip}${text.slice(insert)}` };
    }
    if (runner === 'pytest') {
      // A later -k replaces an earlier one, so extend an existing expression rather than add a second flag.
      const last = flagOccurrences(words, ['-k']).at(-1);
      if (last && !last.inline) return { testName, command: replaceWord(last.index, shellWord(`(${last.value}) and not ${testName}`)) };
      return { testName, command: `${text.slice(0, end)} -k ${shellWord(`not ${testName}`)}${text.slice(end)}` };
    }
    if (runner === 'jest' || runner === 'vitest') {
      const flags = runner === 'jest' ? ['--testNamePattern', '-t'] : ['-t'];
      const last = flagOccurrences(words, flags).at(-1);
      const existing = last ? NEGATIVE_LOOKAHEAD.exec(last.value)?.[1] : undefined;
      if (existing !== undefined && !last.inline)
        return { testName, command: replaceWord(last.index, shellWord(`^(?!.*(?:${existing}|${pattern})).*$`)) };
      const skip = shellWord(`^(?!.*${pattern}).*$`);
      const flag = runner === 'jest' ? `--testNamePattern=${skip}` : `-t ${skip}`;
      return { testName, command: `${text.slice(0, end)} ${flag}${text.slice(end)}` };
    }
  }
  return excluded ? undefined : { testName, reason: 'runner has no test-name filter' };
}

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
  'loopback-listen':
    'the verifier sandbox denies bind unless verifier.allowLoopback is enabled, so the run is certain to end VERIFY_ENV_FAILED (loopback-denied); drop the suite from testCommand and run it in the primary, enable verifier.allowLoopback, or pass acceptVerifierBlockers: true',
};
/** Why a blocker inside the job's own suite cannot be dropped from testCommand,
 * and the command that skips only the test it fails in. */
function mustRunAdvice(value, finding) {
  const head = "this suite is in ownedPaths and must run, so dropping it from testCommand would drop the job's own test";
  const skip = value?.testNameExclusion;
  if (!finding.testName || !skip || skip.testName !== finding.testName) return head;
  if (skip.command) return `${head}; skip only the failing test "${finding.testName}": \`${skip.command}\``;
  return `${head}; no per-test filter for this runner: start with verifierMode "baseline-diff" (the start snapshot shares the failure, so it is tolerated), or plan to apply with offload_apply + applyThenVerifyTolerate [${JSON.stringify(finding.testName)}] / verifiedBy; acceptVerifierBlockers alone only pays for a run that will end VERIFY_ENV_FAILED`;
}
/** One line per blocking finding: file:line, the resolved target and the fix. */
function verifierBlockingLines(value, { limit = MAX_FINDINGS } = {}) {
  if (!Array.isArray(value?.blocking)) return [];
  const shown = value.blocking.filter((finding) => BLOCKING_ADVICE[finding?.code] && typeof finding.path === 'string');
  const lines = shown.slice(0, limit).map((finding) => {
    const place = `${finding.path}${Number.isInteger(finding.line) ? `:${finding.line}` : ''}`;
    const runBy = finding.testFiles?.length ? `; run by ${finding.testFiles.join(', ')}` : '';
    // A file testCommand must run cannot be dropped, so say so before the fix.
    const advice = finding.mustRun ? `${mustRunAdvice(value, finding)} | ${BLOCKING_ADVICE[finding.code]}` : BLOCKING_ADVICE[finding.code];
    // A listener finding has no write target, only the line that opens it.
    if (finding.code === 'loopback-listen')
      return `verifier blocker: ${place}: opens a TCP listener (createServer / server.listen)${runBy} — ${advice}`;
    return `verifier blocker: ${place}: ${finding.call || 'write'} ${finding.target} — ${advice}${finding.extraWritable ? ` (extraWritable: "${finding.extraWritable}")` : ''}${runBy}`;
  });
  return shown.length > lines.length
    ? [...lines, `verifier blocker: ${shown.length - lines.length} more (detail "full" lists them)`]
    : lines;
}
/** Writes in suites a file-filtered runner was not given: reported, never refused. */
function verifierAdvisoryLines(value, { limit = MAX_FINDINGS } = {}) {
  if (!Array.isArray(value?.advisory)) return [];
  const total = Number.isInteger(value.advisoryCount) ? value.advisoryCount : value.advisory.length;
  const placed = value.advisory.filter((finding) => typeof finding?.path === 'string');
  // Findings a test-name filter or a sandbox skip guard keeps from running are not runner-scoped ones.
  const unrun = placed.filter((finding) => finding.skippedBy);
  const scoped = placed.filter((finding) => !finding.skippedBy);
  const lines = [];
  const files = [...new Set(scoped.map((finding) => finding.path))];
  if (files.length) {
    const runner = scoped[0].runner;
    lines.push(
      `verifier advisory: ${total - unrun.length} denied finding(s) in ${files.length === 1 ? files[0] : `${files.length} suites (${files.slice(0, limit).join(', ')}${files.length > limit ? ', …' : ''})`}, which ${runner || 'the runner'} imports but was not given as an argument; not refused (they fail the run only if the runner ignores its file arguments)`,
    );
  }
  for (const finding of unrun.slice(0, limit)) {
    const place = `${finding.path}${Number.isInteger(finding.line) ? `:${finding.line}` : ''}`;
    lines.push(
      finding.skippedBy === 'sandbox-guard'
        ? `verifier advisory: ${place}: the test${finding.testName ? ` "${finding.testName}"` : ''} is skipped inside the verifier sandbox (sandbox-exec cannot nest); not refused`
        : `verifier advisory: ${place}: the test${finding.testName ? ` "${finding.testName}"` : ''} is excluded by a test-name filter already in testCommand; not refused`,
    );
  }
  return lines;
}
/** Writes whose target the scan could not place: reported, never refused. */
function verifierUncertainLines(value, { limit = MAX_FINDINGS } = {}) {
  if (!Array.isArray(value?.uncertain)) return [];
  const shown = value.uncertain.filter((finding) => typeof finding?.path === 'string');
  const total = Number.isInteger(value.uncertainCount) ? value.uncertainCount : shown.length;
  const lines = shown
    .slice(0, limit)
    .map(
      (finding) =>
        `verifier uncertain: ${finding.path}${Number.isInteger(finding.line) ? `:${finding.line}` : ''}: ${finding.call || 'write'} target ${finding.target} is not statically known; not refused (it may not be a path at all, and the sandbox denies it only if it lands outside the write scope)${finding.testFiles?.length ? `; run by ${finding.testFiles.join(', ')}` : ''}`,
    );
  return total > lines.length ? [...lines, `verifier uncertain: ${total - lines.length} more (detail "full" lists them)`] : lines;
}
/** Why a runner's file arguments could not limit the findings. */
const verifierScopeLines = (value) => [
  ...(Array.isArray(value?.scopeUnavailable) ? value.scopeUnavailable : [])
    .filter((gap) => typeof gap?.runner === 'string' && Number.isInteger(gap.unreadFiles))
    .map(
      (gap) =>
        `verifier scope: the suites ${gap.runner} was given reach ${gap.unreadFiles} file(s) past the scan limits, so findings could not be limited to those suites`,
    ),
  ...(Array.isArray(value?.missingArguments) ? value.missingArguments : [])
    .filter((gap) => typeof gap?.runner === 'string' && Array.isArray(gap.files) && gap.files.length)
    .map((gap) =>
      gap.scoped
        ? `verifier scope: ${gap.runner} was given ${gap.files.join(', ')}, which do not exist in the start snapshot and are not in ownedPaths; findings were scoped to the other arguments`
        : `verifier scope: ${gap.runner} was given ${gap.files.join(', ')}, which do not exist in the start snapshot and are not in ownedPaths, so no suite was selected and every suite it imports was scanned; if the worker creates them, the blockers in suites it was not given will not run, so add them to ownedPaths or pass acceptVerifierBlockers: true`,
    ),
];
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
      ...verifierScopeLines(value),
      ...(Number.isInteger(value?.mustRunBlockers) && value.mustRunBlockers
        ? [
            `verifier preflight: ${value.mustRunBlockers} blocker(s) are in files the job owns (ownedPaths), so testCommand must keep running them${
              value.testNameExclusion?.command
                ? `; skip only the failing test: \`${value.testNameExclusion.command}\``
                : value.testNameExclusion
                  ? '; no per-test filter for this runner: start with verifierMode "baseline-diff", or apply with applyThenVerifyTolerate / verifiedBy'
                  : ''
            }`,
          ]
        : []),
      narrowingLine(value),
      value?.mustRunBlockers
        ? 'Fix the tests, or skip only the listed test name: the suites in ownedPaths must keep running, so dropping them from testCommand is not an option, and acceptVerifierBlockers alone only pays for a run that will end VERIFY_ENV_FAILED.'
        : 'Fix the tests, declare the listed extraWritable glob, drop the files from testCommand (and check them in the primary), or pass acceptVerifierBlockers: true to start anyway.',
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
    'loopback-listen':
      'test opens a TCP listener (server.listen / createServer); the verifier sandbox denies bind unless verifier.allowLoopback is enabled, and the EPERM can abort Node before any assertion runs; narrow testCommand to exclude these files and check them in the primary before spending',
    'process-inspection':
      'ps / process identity inspection may be denied even when exec is permitted; use an injectable identity probe or verify in the primary',
  };
  return [
    `verifier preflight: ${value.scannedFiles ?? 0} file(s) scanned; static advisory${value.limited ? ' (incomplete)' : ''}, not a sandbox test${value.blockersAccepted ? '; blocking findings accepted by the caller' : ''}`,
    ...verifierBlockingLines(value, { limit }),
    ...verifierAdvisoryLines(value, { limit }),
    ...verifierUncertainLines(value, { limit }),
    ...verifierScopeLines(value),
    ...(value.previousFailures ?? []).map((failure) =>
      failure.inCommand?.length === 0 && failure.files?.length
        ? `verifier session note: ${failure.jobId} (${failure.kind}): ${failure.files.join(', ')} no longer run by this testCommand`
        : `verifier session warning: ${failure.jobId} (${failure.kind}): ${(failure.inCommand ?? failure.files).join(', ') || 'offending files unknown'}; exclude these files from testCommand and check them in the primary before spending again`,
    ),
    narrowingLine(value),
    ...(Number.isInteger(value.mustRunBlockers) && value.mustRunBlockers
      ? [
          `verifier preflight: ${value.mustRunBlockers} blocker(s) are in files the job owns (ownedPaths), so testCommand must keep running them${
            value.testNameExclusion?.testName ? `; the failing test is "${value.testNameExclusion.testName}"` : ''
          }`,
        ]
      : []),
    ...(value.testNameExclusion?.testName
      ? [
          value.testNameExclusion.command
            ? `verifier exclusion: skip only "${value.testNameExclusion.testName}": \`${value.testNameExclusion.command}\` (static rewrite; review before use)`
            : `verifier exclusion: no per-test filter for this runner to skip "${value.testNameExclusion.testName}"; start with verifierMode "baseline-diff" or plan to apply with applyThenVerifyTolerate [${JSON.stringify(value.testNameExclusion.testName)}] / verifiedBy`,
        ]
      : []),
    ...value.warnings
      .filter((w) => advice[w?.code] && typeof w.path === 'string')
      .slice(0, limit)
      .map(
        (w) =>
          `verifier warning: ${w.path}: ${advice[w.code]}${w.unreached ? ' (not refused: no suite calls the function that opens it)' : ''}${w.testFiles?.length ? `; reached by ${w.testFiles.join(', ')}` : ''}`,
      ),
    lean && value.warnings.length > limit && `verifier warning: ${value.warnings.length - limit} more (detail "full" lists them)`,
  ].filter(Boolean);
}

const findingView = ({ code, path, line, call, target, extraWritable, runner, mustRun, testName, skippedBy }) => ({
  code,
  path,
  ...(Number.isInteger(line) ? { line } : {}),
  ...(call ? { call } : {}),
  ...(target ? { target } : {}),
  ...(extraWritable ? { extraWritable } : {}),
  ...(runner ? { runner } : {}),
  ...(mustRun ? { mustRun: true } : {}),
  ...(testName ? { testName } : {}),
  ...(skippedBy ? { skippedBy } : {}),
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
    ...list('uncertain').map((finding) => ({ severity: 'uncertain', ...findingView(finding) })),
    ...list('warnings').map(({ code, path, testFiles, unreached }) => ({
      severity: 'warning',
      code,
      path,
      ...(unreached ? { unreached: true } : {}),
      ...(Array.isArray(testFiles) && testFiles.length ? { testFiles: testFiles.slice(0, 8) } : {}),
    })),
  ];
  return {
    ...(value.status ? { status: value.status } : {}),
    scannedFiles: value.scannedFiles ?? 0,
    limited: value.limited === true,
    counts: {
      blocking: list('blocking').length,
      advisory: advisoryCount,
      ...(list('uncertain').length
        ? { uncertain: Number.isInteger(value.uncertainCount) ? value.uncertainCount : list('uncertain').length }
        : {}),
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
    ...(list('scopeUnavailable').length ? { scopeUnavailable: list('scopeUnavailable').slice(0, COMPACT_FINDINGS) } : {}),
    ...(list('missingArguments').length ? { missingArguments: list('missingArguments').slice(0, COMPACT_FINDINGS) } : {}),
    ...(Array.isArray(value.scoped)
      ? {
          scoped: value.scoped.map(({ runner, files, pending }) => ({
            runner,
            files: (files ?? []).length,
            ...(Array.isArray(pending) && pending.length ? { pending: pending.length } : {}),
          })),
        }
      : {}),
    ...(value.suggestedTestCommand ? { suggestedTestCommand: value.suggestedTestCommand } : {}),
    ...(value.narrowing ? { narrowing: value.narrowing } : {}),
    ...(Array.isArray(value.drop) && value.drop.length
      ? { drop: value.drop.slice(0, COMPACT_FINDINGS), dropCount: value.drop.length }
      : {}),
    ...(value.blockersAccepted ? { blockersAccepted: true } : {}),
    ...(Number.isInteger(value.mustRunBlockers) && value.mustRunBlockers ? { mustRunBlockers: value.mustRunBlockers } : {}),
    ...(value.testNameExclusion && typeof value.testNameExclusion === 'object' ? { testNameExclusion: value.testNameExclusion } : {}),
    ...(findings.length > COMPACT_FINDINGS || list('resolvedFiles').length
      ? { more: 'detail "full" (offload_job or offload_wait) lists every file and finding' }
      : {}),
  };
}
