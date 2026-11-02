/**
 * A forward look at the reservation gate, from what a job has actually spent.
 * It only reports: the conservative reservation in the agent loop stays the
 * sole authority over whether a request may be sent, and nothing here feeds it.
 */
const MIN_OBSERVED_TURNS = 6;
const WINDOW_TURNS = 8;
const WATCH_TURNS = 12;
const CRITICAL_TURNS = 4;
const LEVELS = new Set(['ok', 'watch', 'critical']);
const MAX_USD = 10_000_000_000;

const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;

/**
 * `turns` holds one { costUsd, requiredUsd, inputTokens, cacheHitTokens } per
 * completed request, oldest first. Undefined until enough turns were observed
 * for a mean to mean anything. requiredUsd grows with the prompt, so the
 * headroom shrinks by that growth as well as by the spend.
 */
export function budgetOutlook({ turns, remainingUsd, turnsLeftInCap }) {
  if (!Array.isArray(turns) || turns.length < MIN_OBSERVED_TURNS || !(remainingUsd >= 0)) return undefined;
  const recent = turns.slice(-WINDOW_TURNS);
  const avgTurnUsd = mean(recent.map((turn) => turn.costUsd));
  const requiredUsd = recent.at(-1).requiredUsd;
  const growthUsd = Math.max(0, (requiredUsd - recent[0].requiredUsd) / (recent.length - 1));
  const perTurnUsd = avgTurnUsd + growthUsd;
  if (!(perTurnUsd > 0) || !Number.isFinite(perTurnUsd)) return undefined;
  const turnsLeft = Math.max(0, Math.floor((remainingUsd - requiredUsd) / perTurnUsd));
  const inputTokens = recent.reduce((sum, turn) => sum + turn.inputTokens, 0);
  const cacheHitTokens = recent.reduce((sum, turn) => sum + turn.cacheHitTokens, 0);
  // A turn cap that binds first means the reservation is not what stops this job.
  const onCourse = turnsLeft < turnsLeftInCap;
  return {
    level: !onCourse || turnsLeft > WATCH_TURNS ? 'ok' : turnsLeft > CRITICAL_TURNS ? 'watch' : 'critical',
    turnsLeft,
    avgTurnUsd,
    remainingUsd,
    requiredUsd,
    ...(inputTokens > 0 ? { recentCacheHitRate: cacheHitTokens / inputTokens } : {}),
  };
}

export const budgetNotice = (turnsLeft) =>
  `Budget notice: at the current spend about ${turnsLeft} more request(s) fit in this job's budget. Your edits are retained. Complete only what the task still requires, avoid new broad reads, and call finish as the only tool call while you still can.`;

const usd = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_USD;

/** The stored or reported outlook, or undefined when it is malformed. */
export function safeBudgetOutlook(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const { level, turnsLeft, avgTurnUsd, remainingUsd, requiredUsd, recentCacheHitRate } = value;
  if (!LEVELS.has(level) || !Number.isSafeInteger(turnsLeft) || turnsLeft < 0 || ![avgTurnUsd, remainingUsd, requiredUsd].every(usd))
    return undefined;
  const rate =
    typeof recentCacheHitRate === 'number' && recentCacheHitRate >= 0 && recentCacheHitRate <= 1 ? recentCacheHitRate : undefined;
  return { level, turnsLeft, avgTurnUsd, remainingUsd, requiredUsd, ...(rate !== undefined ? { recentCacheHitRate: rate } : {}) };
}

/** The outlook a caller should be told about: only while a round can still act on it. */
export function budgetWarning(job) {
  if (job?.status !== 'RUNNING' && job?.status !== 'REPAIRING') return undefined;
  const outlook = safeBudgetOutlook(job.budgetOutlook);
  return outlook && outlook.level !== 'ok' ? outlook : undefined;
}

export function budgetWarningLine(job) {
  const outlook = budgetWarning(job);
  if (!outlook) return '';
  const cache =
    outlook.recentCacheHitRate === undefined
      ? ''
      : `; recent prompt cache hit rate ${(100 * outlook.recentCacheHitRate).toFixed(1)}%${outlook.recentCacheHitRate < 0.4 ? ' (prompt prefixes are being rewritten, which is what makes these requests dear)' : ''}`;
  return `budget warning (${outlook.level}): on course for the reservation stop in about ${outlook.turnsLeft} request(s): $${outlook.avgTurnUsd.toFixed(4)} per request, $${outlook.remainingUsd.toFixed(4)} remaining, the next request reserves $${outlook.requiredUsd.toFixed(4)}${cache}`;
}
