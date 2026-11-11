import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, posix as posixPath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchesAny } from './glob.mjs';
import { isTestPath } from './budget-sizing.mjs';

// A verifier failure that no worker round can fix: every path that has to
// change is outside what the job may write. An automatic repair spends a model
// round (and budget) on such a failure and ends with the same failure, so the
// job ends VERIFY_FAILED and the primary is told what to fix and where.
// Detection is deliberately narrow: when anything is unclear, the answer is
// "repairable" and today's automatic repair runs.

/** The plugin content-version test names its own fix; the manifests it rewrites. */
export const PLUGIN_VERSION_MARKER = 'run npm run plugin:version';
export const PLUGIN_VERSION_COMMAND = 'npm run plugin:version';
export const PLUGIN_MANIFESTS = Object.freeze(['plugins/offload/plugin.json', 'plugins/offload/.codex-plugin/plugin.json']);

export const SKILL_FILES = Object.freeze([
  'plugins/offload/skills/offload_economy/SKILL.md',
  'plugins/offload/skills/offload_premium/SKILL.md',
]);
const SKILL_SYNC_MARKER = 'edit both SKILL.md bodies together';
// Only failures the skill text alone can fix. "the skill gates on X, which the server does not
// report" and "the skill pins the revision" can come from a server-side change the worker can undo.
const SKILL_NAME_MARKERS = [/the skill never mentions capability ([\w.-]+)/g, /the skill never mentions (?!capability\b)([\w.-]+)/g];
const SKILL_PLAIN_MARKERS = [SKILL_SYNC_MARKER];

const MAX_OUTPUT = 128 * 1024;
const MAX_TEST_FILE_BYTES = 512 * 1024;
const MAX_PATHS = 8;
const SCRIPT = String.raw`[A-Za-z0-9_.@+~-]+(?:/[A-Za-z0-9_.@+~-]+)*\.(?:[cm]?[jt]sx?|py)`;

const fileExists = (path) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};
const MAX_CLOSURE_FILES = 200;
const EXTENSIONS = ['', '.mjs', '.js', '.cjs', '.ts', '.mts', '.tsx', '.jsx', '.json'];
// Anything that lets a test observe files or code outside its import graph.
const OPAQUE =
  /\b(?:child_process|spawn|spawnSync|execFile|execFileSync|exec|execSync|fork|worker_threads|readFile|readFileSync|readdir|readdirSync|createReadStream|require|eval)\b|node:fs|from ['"]fs|import\s*\(/;
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*)['"]([^'"]+)['"]/g;

/**
 * The repo-relative files a JavaScript test statically imports, transitively.
 * Undefined (unsure) when a file is not JavaScript, cannot be read or resolved,
 * is large, imports a package rather than a relative path or a Node built-in,
 * can reach other files by non-import means, or the closure has no relative
 * import to analyze at all.
 */
function importClosure(root, starts) {
  const seen = new Set();
  let relativeImports = 0;
  const queue = [...starts];
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    if (seen.size >= MAX_CLOSURE_FILES) return undefined;
    seen.add(file);
    if (file.endsWith('.json')) continue;
    if (!/\.[cm]?[jt]sx?$/.test(file)) return undefined;
    let source;
    try {
      source = readFileSync(join(root, file), 'utf8');
    } catch {
      return undefined;
    }
    if (source.length > MAX_TEST_FILE_BYTES || OPAQUE.test(source)) return undefined;
    for (const match of source.matchAll(SPECIFIER)) {
      const specifier = match[1];
      if (specifier.startsWith('node:')) continue;
      if (!specifier.startsWith('.')) return undefined;
      relativeImports += 1;
      const base = posixPath.normalize(posixPath.join(dirname(file), specifier));
      const resolved = [
        ...EXTENSIONS.map((ext) => base + ext),
        ...EXTENSIONS.slice(1).map((ext) => posixPath.join(base, 'index') + ext),
      ].find((candidate) => fileExists(join(root, candidate)));
      if (!resolved || resolved.startsWith('..')) return undefined;
      queue.push(resolved);
    }
  }
  return relativeImports > 0 ? seen : undefined;
}
const safeRealpath = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};
const inside = (scope, path) => {
  try {
    return matchesAny(path, scope);
  } catch {
    // An unmatchable pattern proves nothing about the path.
    return true;
  }
};
const posix = (value) => value.replaceAll('\\', '/');

/**
 * Every repo-relative path the verifier output points at: `file://` locations
 * (node:test/TAP, stack frames), absolute paths under a root, and `FAIL x`
 * lines. Returns undefined when a location cannot be placed relative to the
 * workspace: the caller then keeps the automatic repair.
 */
function referencedPaths(text, roots) {
  const found = new Set();
  let unplaced = false;
  const place = (absolute) => {
    const normal = posix(absolute);
    for (const root of roots) {
      const prefix = `${posix(root).replace(/\/+$/, '')}/`;
      if (normal.startsWith(prefix)) {
        const relative = normal.slice(prefix.length);
        if (relative && !relative.startsWith('node_modules/') && !relative.includes('/node_modules/')) found.add(relative);
        return;
      }
    }
    // Node internals and dependencies are neither the job's nor fixable by it.
    if (/^node:|\/node_modules\//.test(normal)) return;
    unplaced = true;
  };
  for (const match of text.matchAll(/file:\/\/(\/[^\s):'"]+?\.(?:[cm]?[jt]sx?|py))(?=[:\s)'"]|$)/g)) {
    let path;
    try {
      path = fileURLToPath(`file://${match[1]}`);
    } catch {
      unplaced = true;
      continue;
    }
    place(path);
  }
  for (const match of text.matchAll(
    new RegExp(String.raw`(?:^|[\s("'])(/(?:[^\s:)"']+/)*[^\s:)"']+\.(?:[cm]?[jt]sx?|py))(?=[:\s)"']|$)`, 'gm'),
  ))
    place(match[1]);
  for (const match of text.matchAll(new RegExp(String.raw`^\s*FAIL\s+(${SCRIPT})`, 'gm'))) found.add(match[1]);
  return unplaced ? undefined : [...found];
}

function failingTestFiles(text, referenced) {
  const names = new Set();
  // node:test/TAP: a failing test is reported at its own file location.
  for (const match of text.matchAll(/(?:test at|location:)\s+'?(?:file:\/\/)?(\S+?\.(?:[cm]?[jt]sx?|py))(?::\d+)?/g)) names.add(match[1]);
  for (const match of text.matchAll(new RegExp(String.raw`^\s*FAIL\s+(${SCRIPT})`, 'gm'))) names.add(match[1]);
  const files = new Set();
  for (const name of names) {
    const hit = referenced.find((path) => path === name || name.endsWith(`/${path}`));
    if (hit) files.add(hit);
    else if (!name.startsWith('/') && !name.startsWith('file:')) files.add(name);
    else return undefined;
  }
  return [...files];
}

/** The failure blocks of node:test ("failing tests:") or TAP ("not ok") output; undefined when neither is recognizable. */
function failureBlocks(text) {
  const at = text.indexOf('failing tests:');
  if (at >= 0)
    return text
      .slice(at)
      .split(/^test at /m)
      .slice(1);
  if (/^not ok /m.test(text)) return text.split(/^not ok /m).slice(1);
  return undefined;
}

/**
 * A verifier that fails only on the skill-text checks: each failing test
 * carries one of their assertion messages. Returns `{ names, version }` or
 * undefined when anything is unclear.
 */
function skillTextFailures(text) {
  const blocks = failureBlocks(text);
  if (!blocks?.length) return undefined;
  const reported = text.match(/^\s*(?:ℹ|#)\s*fail\s+(\d+)\s*$/m);
  if (reported && Number(reported[1]) !== blocks.length) return undefined;
  const names = [];
  let skill = 0;
  let version = false;
  for (const block of blocks) {
    const found = SKILL_NAME_MARKERS.flatMap((marker) => [...block.matchAll(marker)].map((match) => match[1]));
    const marked = found.length > 0 || SKILL_PLAIN_MARKERS.some((marker) => block.includes(marker));
    if (marked) {
      skill += 1;
      names.push(...found);
    } else if (block.includes(PLUGIN_VERSION_MARKER)) version = true;
    else return undefined;
  }
  if (!skill) return undefined;
  return { names: [...new Set(names)].slice(0, MAX_PATHS), version };
}

/**
 * Decide whether a failed verifier run is fixable only outside the job's
 * writable scope. Returns `{ reason, paths, command? }` or undefined.
 *
 * @param {object} args
 * @param {object} args.verify the failed verifier result
 * @param {string[]} args.scope ownedPaths + extraWritable
 * @param {string[]|undefined} args.changed repo-relative paths the job changed; undefined when unknown (only the plugin check applies)
 * @param {string[]} args.roots absolute workspace/repo roots the output may name
 */
export function repairOutsideScope({ verify, scope, changed, roots = [] } = {}) {
  if (!verify || verify.verdict === 'PASS' || !Array.isArray(scope) || !scope.length) return undefined;
  const raw = [verify.result?.stderr, verify.result?.stdout].map((value) => String(value ?? '').slice(-MAX_OUTPUT)).join('\n');
  let text = raw;
  try {
    text = decodeURIComponent(raw);
  } catch {
    // Keep the raw text: percent signs in ordinary output are common.
  }
  const absoluteRoots = [
    ...new Set(roots.filter((root) => typeof root === 'string' && root).flatMap((root) => [root, safeRealpath(root)])),
  ];
  // Skill text is only fixable in the SKILL.md files; a test the job owns must not be edited to pass.
  const skillText = skillTextFailures(text);
  if (skillText && !SKILL_FILES.some((path) => inside(scope, path))) {
    const manifestsOutside = PLUGIN_MANIFESTS.every((path) => !inside(scope, path));
    if (!skillText.version || manifestsOutside)
      return {
        reason: 'skill-text',
        paths: [...SKILL_FILES],
        missing: skillText.names,
        ...(skillText.version ? { command: PLUGIN_VERSION_COMMAND } : {}),
      };
  }
  const referenced = referencedPaths(text, absoluteRoots);
  if (!referenced) return undefined;
  // The worker can still change any in-scope file the failure points at.
  if (referenced.some((path) => inside(scope, path))) return undefined;
  const failing = failingTestFiles(text, referenced);
  if (!failing?.length) return undefined;
  if (failing.some((path) => inside(scope, path))) return undefined;
  const base = { paths: failing.slice(0, MAX_PATHS) };

  if (text.includes(PLUGIN_VERSION_MARKER)) {
    const manifests = PLUGIN_MANIFESTS.filter((path) => !inside(scope, path));
    // Writable manifests mean the worker could run the command itself.
    if (manifests.length !== PLUGIN_MANIFESTS.length) return undefined;
    return { reason: 'plugin-content-version', command: PLUGIN_VERSION_COMMAND, paths: [...PLUGIN_MANIFESTS] };
  }

  if (!Array.isArray(changed)) return undefined;
  // A changed test file may be what a failing one loads or shares state with.
  if (changed.some((path) => isTestPath(path))) return undefined;
  // A failing test the job's changes can reach (or that could reach anything
  // by other means) may be failing because of them: the worker can fix that.
  const root = roots.find((candidate) => candidate && failing.every((test) => fileExists(join(candidate, test))));
  if (!root) return undefined;
  const reachable = importClosure(root, failing);
  if (!reachable || changed.some((path) => reachable.has(path))) return undefined;
  return { reason: 'tests-outside-scope', paths: base.paths };
}

/** The sentence a report gives the primary for a skipped automatic repair. */
export function repairSkippedLine(skipped) {
  if (!skipped || typeof skipped !== 'object' || typeof skipped.reason !== 'string') return '';
  const paths = (Array.isArray(skipped.paths) ? skipped.paths : []).filter((path) => typeof path === 'string').slice(0, MAX_PATHS);
  const list = paths.join(', ');
  if (skipped.reason === 'plugin-content-version')
    return `automatic repair skipped: the verifier fails only on the plugin content version, which the worker cannot change (${list || 'plugin manifests'} are outside its scope). The primary must fix it: run \`${PLUGIN_VERSION_COMMAND}\` in the primary after applying, then re-run the check.`;
  if (skipped.reason === 'tests-outside-scope')
    return `automatic repair skipped: every failing test file (${list}) is outside the job's writable scope and none of the job's changes is a test or is named by those tests, so no worker round can fix it. The primary must fix or triage it, then apply after its own check.`;
  if (skipped.reason === 'skill-text') {
    const missing = (Array.isArray(skipped.missing) ? skipped.missing : []).filter((name) => typeof name === 'string').slice(0, MAX_PATHS);
    const files = SKILL_FILES.join(' and ');
    const what = missing.length ? ` (${missing.join(', ')})` : '';
    return `automatic repair skipped: the verifier fails only on skill-text checks${what}, which only ${files} can fix, and they are outside the job's writable scope. The primary must edit both SKILL.md bodies identically, run \`${PLUGIN_VERSION_COMMAND}\`, then apply after its own check.`;
  }
  return '';
}

const SKIP_REASONS = new Set(['plugin-content-version', 'tests-outside-scope', 'skill-text']);
/** The persisted/public shape: a closed reason, bounded repo-relative paths and the fixed command. */
export function safeRepairSkipped(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !SKIP_REASONS.has(value.reason)) return undefined;
  const paths = (Array.isArray(value.paths) ? value.paths : [])
    .filter((path) => typeof path === 'string' && path.length > 0 && path.length <= 1024 && !/[\0-\x1f\x7f]/.test(path))
    .slice(0, MAX_PATHS);
  const missing = (Array.isArray(value.missing) ? value.missing : [])
    .filter((name) => typeof name === 'string' && /^[\w.-]{1,128}$/.test(name))
    .slice(0, MAX_PATHS);
  return {
    reason: value.reason,
    paths,
    ...(value.reason === 'skill-text' ? { missing } : {}),
    ...(value.reason === 'plugin-content-version' || value.reason === 'skill-text' ? { command: PLUGIN_VERSION_COMMAND } : {}),
  };
}
