/**
 * Review packet: worker-authored evidence that makes the primary's review
 * scale with the worker's output instead of its input, plus the server's
 * deterministic check of that evidence. Nothing here calls a model.
 *
 * A packet (finish.reviewPacket) has:
 * - requirements: [{ criterion, status, evidence }] - `criterion` is the
 *   1-based index of an acceptance criterion (0 = the task itself).
 * - claims: [{ claim, path, startLine, endLine, quote }] - each quote must
 *   appear verbatim (whitespace-normalized) within the cited lines.
 * - uncertain: [string] - what the worker is unsure of or did not check.
 * - decisions: [string] - judgment calls, alternatives and reasons.
 * - changedFiles: [{ path, why }] - write jobs: every changed file, once.
 *
 * The check proves only that quotes exist where cited and that coverage is
 * complete. It never proves a claim is correct; `spotCheck` names claims the
 * primary should read for meaning.
 */
import { createHash } from 'node:crypto';
import { readRegularFile } from './regular-file.mjs';

export const REVIEW_PACKET_LIMITS = Object.freeze({
  requirements: 100,
  evidence: 300,
  claims: 40,
  claim: 400,
  quote: 600,
  path: 512,
  uncertain: 20,
  decisions: 20,
  note: 400,
  changedFiles: 100,
  why: 200,
  maxLineSpan: 40,
  // Field evidence: a correct quote can sit a few lines above its citation.
  maxLineDrift: 8,
  warnings: 10,
  minQuoteChars: 12,
  maxFileBytes: 8 * 1024 * 1024,
  defects: 24,
  spotCheck: 3,
});
const L = REVIEW_PACKET_LIMITS;
const STATUSES = new Set(['done', 'partial', 'not_done']);

/** JSON-schema fragment for the finish tool's `reviewPacket` property. */
export const REVIEW_PACKET_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  description:
    'Evidence for the reviewer. requirements: one entry per acceptance criterion by its number (0 = the task). claims: each with a verbatim quote from the cited file lines. uncertain: what you are unsure of or did not check. decisions: judgment calls with alternatives and reasons. changedFiles (write jobs): every file you changed.',
  required: ['requirements', 'claims', 'uncertain'],
  properties: {
    requirements: {
      type: 'array',
      maxItems: L.requirements,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['criterion', 'status', 'evidence'],
        properties: {
          criterion: { type: 'integer', minimum: 0, maximum: L.requirements },
          status: { type: 'string', enum: [...STATUSES] },
          evidence: { type: 'string', maxLength: L.evidence },
        },
      },
    },
    claims: {
      type: 'array',
      minItems: 1,
      maxItems: L.claims,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['claim', 'path', 'startLine', 'endLine', 'quote'],
        properties: {
          claim: { type: 'string', minLength: 1, maxLength: L.claim },
          path: { type: 'string', minLength: 1, maxLength: L.path },
          startLine: { type: 'integer', minimum: 1 },
          endLine: { type: 'integer', minimum: 1 },
          quote: { type: 'string', minLength: L.minQuoteChars, maxLength: L.quote },
        },
      },
    },
    uncertain: { type: 'array', maxItems: L.uncertain, items: { type: 'string', minLength: 1, maxLength: L.note } },
    decisions: { type: 'array', maxItems: L.decisions, items: { type: 'string', minLength: 1, maxLength: L.note } },
    changedFiles: {
      type: 'array',
      maxItems: L.changedFiles,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'why'],
        properties: { path: { type: 'string', minLength: 1, maxLength: L.path }, why: { type: 'string', maxLength: L.why } },
      },
    },
  },
});

const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max, min = 1) => typeof value === 'string' && value.length >= min && value.length <= max && !value.includes('\0');
const exactKeys = (value, allowed) => Object.keys(value).every((key) => allowed.includes(key));
const posInt = (value) => Number.isSafeInteger(value) && value >= 1;

/** Structural problems with a packet (empty array when well-formed). */
export function reviewPacketProblems(packet) {
  if (!plain(packet)) return ['reviewPacket must be an object'];
  const problems = [];
  if (!exactKeys(packet, ['requirements', 'claims', 'uncertain', 'decisions', 'changedFiles']))
    problems.push('reviewPacket has unknown fields');
  const list = (name, max, check, required = true) => {
    const value = packet[name];
    if (value === undefined && !required) return;
    if (!Array.isArray(value) || value.length > max) return problems.push(`reviewPacket.${name} must be an array of at most ${max}`);
    value.forEach((item, index) => {
      const problem = check(item);
      if (problem) problems.push(`reviewPacket.${name}[${index}] ${problem}`);
    });
  };
  list('requirements', L.requirements, (item) =>
    !plain(item) || !exactKeys(item, ['criterion', 'status', 'evidence'])
      ? 'must be {criterion, status, evidence}'
      : !Number.isSafeInteger(item.criterion) || item.criterion < 0 || item.criterion > L.requirements
        ? 'criterion must be an acceptance-criterion number (0 = the task)'
        : !STATUSES.has(item.status)
          ? 'status must be done, partial or not_done'
          : !text(item.evidence, L.evidence, 0)
            ? `evidence must be at most ${L.evidence} characters`
            : undefined,
  );
  if (Array.isArray(packet.claims) && packet.claims.length === 0)
    problems.push('reviewPacket.claims needs at least one claim with a verbatim quote');
  list('claims', L.claims, (item) =>
    !plain(item) || !exactKeys(item, ['claim', 'path', 'startLine', 'endLine', 'quote'])
      ? 'must be {claim, path, startLine, endLine, quote}'
      : !text(item.claim, L.claim) || !text(item.quote, L.quote) || !text(item.path, L.path)
        ? `needs claim (<=${L.claim}), path (<=${L.path}) and quote (<=${L.quote}) text`
        : !posInt(item.startLine) || !posInt(item.endLine) || item.endLine < item.startLine
          ? 'needs 1-based startLine <= endLine'
          : item.endLine - item.startLine >= L.maxLineSpan
            ? `may span at most ${L.maxLineSpan} lines`
            : squash(item.quote).length < L.minQuoteChars
              ? `quote must hold at least ${L.minQuoteChars} non-blank characters copied from the cited lines`
              : undefined,
  );
  list('uncertain', L.uncertain, (item) => (text(item, L.note) ? undefined : `must be 1-${L.note} characters`));
  list('decisions', L.decisions, (item) => (text(item, L.note) ? undefined : `must be 1-${L.note} characters`), false);
  list(
    'changedFiles',
    L.changedFiles,
    (item) =>
      plain(item) && exactKeys(item, ['path', 'why']) && text(item.path, L.path) && text(item.why, L.why, 0)
        ? undefined
        : 'must be {path, why}',
    false,
  );
  return problems.slice(0, L.defects);
}

/** Collapse whitespace runs so line wrapping and indentation do not decide a match. */
const squash = (value) => value.replace(/\s+/g, ' ').trim();
const posix = (value) => value.replace(/\\/g, '/').replace(/^\.\//, '');

/**
 * Where a quote actually lives when its citation drifted: the same span shifted
 * by at most L.maxLineDrift lines either way (clamped to the file), preferring
 * the smallest shift.
 */
function driftWindow(lines, quote, startLine, endLine) {
  const span = endLine - startLine + 1;
  for (let distance = 1; distance <= L.maxLineDrift; distance++) {
    for (const shift of [-distance, distance]) {
      const start = startLine + shift;
      const end = start + span - 1;
      if (start < 1 || end > lines.length) continue;
      if (squash(lines.slice(start - 1, end).join('\n')).includes(quote)) return { start, end, distance };
    }
  }
  return undefined;
}

/** Deterministic claim indices for the primary to read for meaning. */
function spotCheckIndices(seed, count) {
  if (!count) return [];
  const picks = [];
  for (let round = 0; picks.length < Math.min(L.spotCheck, count) && round < 64; round++) {
    const value = createHash('sha256').update(`${seed}\0${round}`).digest().readUInt32BE(0) % count;
    if (!picks.includes(value)) picks.push(value);
  }
  return picks.sort((a, b) => a - b);
}

/**
 * Check a packet against the workspace. Options:
 * - mode: 'write' | 'report'
 * - acceptanceCriteria: string[] (the brief's)
 * - changedFiles: string[] (write jobs: repo-relative changed paths)
 * - providedPaths: string[] (paths Offload itself provides read-only, for
 *   example the node_modules link: excluded from the changed set, and listing
 *   one is a warning, not a defect)
 * - resolveReadable(path): absolute path, throwing for unreadable/denied paths
 * - seed: string for the spot-check sample (the job id)
 */
export async function checkReviewPacket(
  packet,
  { mode, acceptanceCriteria = [], changedFiles = [], providedPaths = [], resolveReadable, seed = '' } = {},
) {
  const defects = [];
  const warnings = [];
  let driftedClaims = 0;
  const add = (message) => {
    if (defects.length < L.defects) defects.push(message);
  };
  if (packet === undefined) {
    add('finish.reviewPacket is missing; this job requires one');
    return summarize({ defects, claims: 0, verifiedClaims: 0, missingCriteria: [], unlistedFiles: [], spotCheck: [] });
  }
  const problems = reviewPacketProblems(packet);
  if (problems.length) {
    problems.forEach(add);
    return summarize({ defects, claims: 0, verifiedClaims: 0, missingCriteria: [], unlistedFiles: [], spotCheck: [] });
  }
  // Coverage: every acceptance criterion (1..n) has exactly one entry.
  const counts = new Map();
  for (const { criterion } of packet.requirements) counts.set(criterion, (counts.get(criterion) ?? 0) + 1);
  const missingCriteria = [];
  for (let index = 1; index <= acceptanceCriteria.length; index++) if (!counts.has(index)) missingCriteria.push(index);
  if (missingCriteria.length) add(`requirements has no entry for acceptance criteria ${missingCriteria.join(', ')}`);
  for (const [criterion, count] of counts) {
    if (criterion > acceptanceCriteria.length)
      add(`requirements names criterion ${criterion}, but the brief has ${acceptanceCriteria.length}`);
    if (count > 1) add(`requirements lists criterion ${criterion} ${count} times`);
  }
  // Claims: quotes must appear verbatim (whitespace-normalized) inside the cited lines.
  const files = new Map();
  const load = async (path) => {
    if (!files.has(path))
      files.set(
        path,
        (async () => {
          const target = resolveReadable(path);
          const bytes = await readRegularFile(target, L.maxFileBytes);
          return new TextDecoder('utf-8', { fatal: true }).decode(bytes).split(/\r?\n/);
        })().catch(() => undefined),
      );
    return files.get(path);
  };
  let verifiedClaims = 0;
  for (const [index, claim] of packet.claims.entries()) {
    const path = posix(claim.path);
    let lines;
    try {
      lines = await load(path);
    } catch {
      lines = undefined;
    }
    if (!lines) {
      add(`claims[${index}] cites ${JSON.stringify(path)}, which is not a readable text file in the workspace`);
      continue;
    }
    if (claim.endLine > lines.length) {
      add(`claims[${index}] cites lines ${claim.startLine}-${claim.endLine}, but ${path} has ${lines.length} lines`);
      continue;
    }
    const quote = squash(claim.quote);
    if (!quote) {
      add(`claims[${index}] has a blank quote`);
      continue;
    }
    if (squash(lines.slice(claim.startLine - 1, claim.endLine).join('\n')).includes(quote)) {
      verifiedClaims++;
      continue;
    }
    // A citation a few lines off is drift, not a defect: credit the quote and
    // tell the reviewer where it really sits.
    const drift = driftWindow(lines, quote, claim.startLine, claim.endLine);
    if (drift) {
      verifiedClaims++;
      driftedClaims++;
      if (warnings.length < L.warnings)
        warnings.push(
          `claims[${index}] quote found at ${path}:${drift.start}-${drift.end}, ${drift.distance} line(s) from the cited ${claim.startLine}-${claim.endLine}`,
        );
      continue;
    }
    // Help the worker fix a citation: report where the quote really starts, if anywhere.
    const whole = lines.map((line) => squash(line));
    const first = squash(claim.quote.split(/\r?\n/).find((line) => line.trim()) ?? '');
    const found = first ? whole.findIndex((line) => line.includes(first)) : -1;
    add(
      found >= 0
        ? `claims[${index}] quote is not within ${path}:${claim.startLine}-${claim.endLine}; its first line appears at line ${found + 1}`
        : `claims[${index}] quote does not appear in ${path}`,
    );
  }
  // Write jobs: every changed file listed, and only changed files.
  const unlistedFiles = [];
  if (mode !== 'report') {
    // Paths Offload itself provides (the read-only node_modules link) are never
    // the worker's work: they must not count as changed, and a packet that
    // lists one gets a warning rather than a "no change" defect.
    const provided = providedPaths.map(posix).filter(Boolean);
    const isProvided = (path) => provided.some((root) => path === root || path.startsWith(`${root}/`));
    const listedAll = (packet.changedFiles ?? []).map((entry) => posix(entry.path));
    const listed = new Set(listedAll);
    const changed = new Set(changedFiles.map(posix).filter((path) => !isProvided(path)));
    for (const path of changed) if (!listed.has(path)) unlistedFiles.push(path);
    if (unlistedFiles.length) add(`changedFiles omits ${unlistedFiles.slice(0, 10).join(', ')}${unlistedFiles.length > 10 ? ', ...' : ''}`);
    const unchanged = [...listed].filter((path) => !isProvided(path) && !changed.has(path));
    if (unchanged.length) add(`changedFiles lists paths with no change: ${unchanged.slice(0, 10).join(', ')}`);
    for (const path of new Set(listedAll.filter(isProvided)))
      if (warnings.length < L.warnings) warnings.push(`changedFiles lists ${path}, a read-only link Offload provides; never list it`);
  }
  return summarize({
    defects,
    claims: packet.claims.length,
    verifiedClaims,
    missingCriteria,
    unlistedFiles: unlistedFiles.slice(0, 50),
    spotCheck: spotCheckIndices(seed, packet.claims.length),
    notDone: packet.requirements.filter((entry) => entry.status !== 'done').map((entry) => entry.criterion),
    uncertain: packet.uncertain.length,
    driftedClaims,
    warnings,
  });
}

function summarize({ defects, driftedClaims = 0, warnings = [], ...rest }) {
  return {
    status: defects.length ? 'failed' : 'passed',
    ...rest,
    driftedClaims,
    warnings: warnings.slice(0, L.warnings),
    defects,
  };
}

/** One correction message the worker can act on. */
export function reviewPacketCorrection(check) {
  return `TOOL_ERROR: review packet check failed; nothing was accepted. Fix these and call finish again with a corrected reviewPacket:\n${check.defects
    .map((defect) => `- ${defect}`)
    .join('\n')}`;
}
