import test from 'node:test';
import assert from 'node:assert/strict';
import { budgetNotice, budgetOutlook, budgetWarning, budgetWarningLine, safeBudgetOutlook } from '../../src/budget-outlook.mjs';

const turns = (count, costUsd, requiredUsd = 0.5, rest = {}) =>
  Array.from({ length: count }, () => ({ costUsd, requiredUsd, inputTokens: 100, cacheHitTokens: 50, ...rest }));
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} is not ${expected}`);
const look = (overrides = {}) => budgetOutlook({ turns: turns(8, 0.2), remainingUsd: 3, turnsLeftInCap: 100, ...overrides });

test('the outlook waits for enough turns to mean anything, and needs spend to project', () => {
  assert.equal(look({ turns: turns(5, 0.2) }), undefined);
  assert.equal(look({ turns: turns(6, 0) }), undefined);
  assert.equal(look({ turns: undefined }), undefined);
  assert.equal(look({ remainingUsd: -1 }), undefined);
  assert.ok(look({ turns: turns(6, 0.2) }));
});

test('turns left come from observed spend against the reservation, with levels at 12 and 4', () => {
  // ($3 - $0.5 reserved) / $0.2 per turn
  const { avgTurnUsd, ...rest } = look();
  assert.deepEqual(rest, { level: 'watch', turnsLeft: 12, remainingUsd: 3, requiredUsd: 0.5, recentCacheHitRate: 0.5 });
  near(avgTurnUsd, 0.2);
  assert.equal(look({ remainingUsd: 3.2 }).level, 'ok');
  assert.equal(look({ remainingUsd: 1.3 }).level, 'critical');
  assert.equal(look({ remainingUsd: 1.3 }).turnsLeft, 4);
  assert.equal(look({ remainingUsd: 0.1 }).turnsLeft, 0, 'never negative');
});

test('a growing reservation shortens the outlook, and only the recent window counts', () => {
  const growing = Array.from({ length: 8 }, (_, index) => ({
    costUsd: 0.2,
    requiredUsd: 0.5 + index * 0.1,
    inputTokens: 1,
    cacheHitTokens: 0,
  }));
  // ($3 - $1.2) / ($0.2 + $0.1 growth)
  assert.equal(look({ turns: growing }).turnsLeft, 6);
  const shrinking = [...growing].reverse();
  near(look({ turns: shrinking }).avgTurnUsd, 0.2);
  assert.equal(look({ turns: shrinking }).turnsLeft, 12, 'a falling reservation does not add headroom beyond itself');
  const bimodal = [...turns(20, 2), ...turns(8, 0.1)];
  near(look({ turns: bimodal }).avgTurnUsd, 0.1);
});

test('a turn cap that stops the job first is not a warning', () => {
  assert.equal(look({ turnsLeftInCap: 12 }).level, 'ok');
  assert.equal(look({ turnsLeftInCap: 13 }).level, 'watch');
});

test('a stored outlook is validated, and warned about only while a job can still be affected', () => {
  const outlook = look();
  assert.deepEqual(safeBudgetOutlook(outlook), outlook);
  for (const bad of [
    null,
    [],
    'x',
    { ...outlook, level: 'panic' },
    { ...outlook, turnsLeft: -1 },
    { ...outlook, turnsLeft: 1.5 },
    { ...outlook, avgTurnUsd: -1 },
    { ...outlook, requiredUsd: Infinity },
  ])
    assert.equal(safeBudgetOutlook(bad), undefined);
  assert.equal(safeBudgetOutlook({ ...outlook, recentCacheHitRate: 2 }).recentCacheHitRate, undefined);

  assert.deepEqual(budgetWarning({ status: 'RUNNING', budgetOutlook: outlook }), outlook);
  assert.deepEqual(budgetWarning({ status: 'REPAIRING', budgetOutlook: outlook }), outlook);
  for (const status of ['BUDGET', 'DONE', 'FAILED']) assert.equal(budgetWarning({ status, budgetOutlook: outlook }), undefined);
  assert.equal(budgetWarning({ status: 'RUNNING', budgetOutlook: { ...outlook, level: 'ok' } }), undefined);
  assert.equal(budgetWarningLine({ status: 'DONE', budgetOutlook: outlook }), '');
});

test('the warning line gives the numbers and names low cache hit rates as the cost driver', () => {
  const line = budgetWarningLine({ status: 'RUNNING', budgetOutlook: look({ turns: turns(8, 0.2, 0.5, { cacheHitTokens: 10 }) }) });
  assert.match(
    line,
    /^budget warning \(watch\): on course for the reservation stop in about 12 request\(s\): \$0\.2000 per request, \$3\.0000 remaining, the next request reserves \$0\.5000/,
  );
  assert.match(line, /recent prompt cache hit rate 10\.0% \(prompt prefixes are being rewritten/);
  assert.doesNotMatch(budgetWarningLine({ status: 'RUNNING', budgetOutlook: look() }), /being rewritten/);
  assert.match(budgetNotice(7), /about 7 more request\(s\)/);
});
