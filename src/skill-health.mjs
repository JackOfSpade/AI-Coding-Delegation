/**
 * Whether the skill a client reads is the skill this server was built with.
 *
 * The session-start hook (`install.mjs --doctor-hook`) and offload_job health
 * both answer this through `skillCopyStatus`, so they cannot disagree about a
 * given file. They differ only in what they compare against: the hook uses the
 * checkout it was launched from, health the loaded server's own skill hash.
 */
import { resolveClientPaths } from './client-paths.mjs';
import { skillHashOf } from './identity.mjs';
import { readRegularFileSync } from './regular-file.mjs';

const MAX_SKILL_BYTES = 1_048_576;
export const SKILL_RESTART_ACTION =
  'The installed Offload skill differs from this server: run `node install.mjs` from the Offload checkout, then restart Claude Code/the MCP client. Offload never hot-reloads or kills a client process.';

const RESTART_FALLBACK = 'Run `node install.mjs` from the Offload checkout, then restart the MCP client before starting a job.';

/** Hash of one skill file, or `{ error }` (`missing` when absent, `unreadable` for anything else). */
export function skillFileHash(file, { read = readRegularFileSync } = {}) {
  try {
    return { hash: skillHashOf(read(file, MAX_SKILL_BYTES)) };
  } catch (error) {
    return { error: error?.code === 'ENOENT' ? 'missing' : 'unreadable' };
  }
}

/** `current`, `stale`, `missing`, `unreadable`, or `unknown` when there is nothing to compare against. */
export function skillCopyStatus(file, expectedHash, options) {
  if (!expectedHash) return { status: 'unknown' };
  const found = skillFileHash(file, options);
  if (found.error) return { status: found.error };
  return { status: found.hash === expectedHash ? 'current' : 'stale', installedHash: found.hash };
}

/**
 * Installed skill copies (Claude and Codex) against the server's expected hash.
 * A copy that is absent is normal (client not installed, or a plugin supplies
 * the skill), so health never fails and never reports staleness for it.
 */
export function installedSkillHealth({ expectedHash, expectedOpusHash, home, env = process.env, platform = process.platform, read } = {}) {
  const paths = resolveClientPaths({ home, env, platform });
  const clients = {
    claude: skillCopyStatus(paths.claudeSkill, expectedHash, { read }),
    codex: skillCopyStatus(paths.codexSkill, expectedHash, { read }),
  };
  if (expectedOpusHash) {
    clients.claudeOpus = skillCopyStatus(paths.claudeOpusSkill, expectedOpusHash, { read });
    clients.codexOpus = skillCopyStatus(paths.codexOpusSkill, expectedOpusHash, { read });
  }
  const statuses = Object.values(clients).map((copy) => copy.status);
  const stale = statuses.includes('stale');
  const state = stale
    ? 'stale'
    : statuses.includes('current')
      ? 'current'
      : statuses.includes('unreadable') || statuses.includes('unknown')
        ? 'unknown'
        : 'not-installed';
  const reason = {
    stale: 'installed-skill-differs-from-server',
    current: 'installed-skill-matches-server',
    'not-installed': 'no-installed-skill-found',
    unknown: statuses.includes('unknown') ? 'no-expected-skill-hash' : 'installed-skill-unreadable',
  }[state];
  const shown = Object.values(clients).find((copy) => copy.status === (stale ? 'stale' : 'current'));
  return {
    expectedHash: shown && (shown === clients.claudeOpus || shown === clients.codexOpus) ? expectedOpusHash : (expectedHash ?? null),
    installedHash: shown?.installedHash ?? null,
    stale,
    state,
    reason,
    clients,
  };
}

/**
 * An update during a session makes the loaded server stale and its skill hash
 * old, so the freshly installed skill reads as stale too. Every differing copy
 * matching the package on disk means the install already ran: only a restart is left.
 */
function installAlreadyRan(server, skill) {
  if (server.stale !== true) return false;
  const expected = {
    claude: server.installedSkillHash,
    codex: server.installedSkillHash,
    claudeOpus: server.installedOpusSkillHash,
    codexOpus: server.installedOpusSkillHash,
  };
  const differing = Object.entries(skill.clients ?? {}).filter(([, copy]) => copy?.status === 'stale');
  return differing.length > 0 && differing.every(([client, copy]) => !!copy.installedHash && copy.installedHash === expected[client]);
}

/** Fold the installed-skill answer into the server identity (and health's top level). */
export function withSkillHealth(server, skill) {
  const staleSkill = skill.stale === true;
  const restartRequired = server.restartRequired === true || staleSkill;
  const restartAction =
    staleSkill && !installAlreadyRan(server, skill)
      ? [server.restartRequired === true ? server.restartAction : undefined, SKILL_RESTART_ACTION].filter(Boolean).join(' ')
      : server.restartAction;
  return {
    server: { ...server, skill, ...(staleSkill ? { restartRequired: true, restartAction } : {}) },
    staleSkill,
    restartRequired,
    ...(restartRequired && restartAction ? { restartAction } : {}),
  };
}

/**
 * What a job-less offload_job leads with when a restart is due, so the instruction
 * sits above the job list and health detail rather than among them. It clears
 * only when health does, so it stays until the client has really restarted.
 */
export function withRestartNotice(listing, { requireCurrentSkill = true } = {}) {
  const health = listing?.health;
  if (health?.restartRequired !== true) return listing;
  const reason = health.server?.stale === true ? health.server.staleReason : health.server?.skill?.reason;
  let startsRefused = false;
  try {
    assertStartRuntimeCurrent(health, { requireCurrentSkill });
  } catch {
    startsRefused = true;
  }
  return {
    restart: {
      required: true,
      ...(typeof reason === 'string' ? { reason } : {}),
      action: typeof health.restartAction === 'string' && health.restartAction.trim() ? health.restartAction : RESTART_FALLBACK,
      startsRefused,
    },
    ...listing,
  };
}

/**
 * A health response is advisory for readers, but never advisory at the point
 * that would create a billable job.  Keep this decision beside the health
 * shape so the server, tests, and any future start entrypoint use the same
 * stale-server/skill boundary.
 */
export function assertStartRuntimeCurrent(health, { requireCurrentSkill = true } = {}) {
  const server = health?.server && typeof health.server === 'object' ? health.server : {};
  const skillIsStale = health?.staleSkill === true || server.skill?.stale === true;
  const staleSkill = requireCurrentSkill && skillIsStale;
  const staleServer = server.stale === true;
  // withSkillHealth mirrors a stale client skill into server.restartRequired.
  // A CLI has no client skill to consume, so that mirror must not make a
  // direct/local start fail; genuine runtime restart requirements still do.
  const restartRequired = staleServer || (server.restartRequired === true && !skillIsStale);
  if (!staleSkill && !staleServer && !restartRequired) return;

  const reasons = [
    staleServer
      ? 'the Offload server runtime is STALE'
      : restartRequired && !staleSkill
        ? 'the Offload server runtime requires a restart'
        : undefined,
    staleSkill ? 'the installed Offload skill is STALE' : undefined,
  ].filter(Boolean);
  const action = typeof health?.restartAction === 'string' ? health.restartAction : server.restartAction;
  throw new Error(
    `OFFLOAD START REFUSED: ${reasons.join(' and ')}. No job was created and no provider budget was spent. ${
      typeof action === 'string' && action.trim() ? action.trim() : RESTART_FALLBACK
    } For /offload_economy or /offload_premium, stop the requested task; do not continue implementation locally or through native subagents or bypass this refusal through the CLI.`,
  );
}
