import test from 'node:test';
import assert from 'node:assert/strict';
import {
  autoExtendedTurns,
  AUTO_TURNS_HEADROOM_MAX,
  AUTO_TURNS_MAX,
  FLASH_TURN_USD_ESTIMATE,
  OBSERVED_TURN_MIN_TURNS,
  OBSERVED_TURN_USD_FLOOR,
  observedTurnUsd,
  safeBudgetSizing,
} from '../../src/budget-sizing.mjs';
import { autoExtensionNotice, withAutoExtension } from '../../src/core.mjs';

const sizing = (extra = {}) => ({ maxTurns: 135, turnsSource: 'scaled', initialTurnsSource: 'scaled', turnPolicy: 'auto', ...extra });
const room = { currentMaxTurns: 135, costUsd: 0.07, maxUsd: 3, turnUsdEstimate: FLASH_TURN_USD_ESTIMATE };

test('the field case (135/135 Flash turns, $0.07 of $3.00) is extended by half the cap and recorded', () => {
  const out = autoExtendedTurns(sizing(), room);
  assert.equal(out.extraTurns, 67);
  assert.equal(out.maxTurns, 202);
  assert.deepEqual(out.budgetSizing.autoExtended, { extraTurns: 67, fromMaxTurns: 135, toMaxTurns: 202, spentUsd: 0.07, maxUsd: 3 });
  assert.equal(out.budgetSizing.maxTurns, 202);
  assert.match(out.budgetSizing.warnings[0], /auto-extended once by 67 \(135 -> 202\)/);
  // The record survives the public allowlist.
  assert.equal(safeBudgetSizing(out.budgetSizing).autoExtended.toMaxTurns, 202);
});

test('the extension is bounded by the USD the remaining budget covers and by the automatic ceiling', () => {
  // $0.31 left at $0.01 per turn covers 31 of the 50 asked.
  assert.equal(autoExtendedTurns(sizing({ maxTurns: 100 }), { ...room, currentMaxTurns: 100, costUsd: 0.29, maxUsd: 0.6 }).extraTurns, 31);
  // maxUsd $1 gives a ceiling of 200 turns: 150 + 50, though half the cap and the USD would allow more.
  assert.equal(autoExtendedTurns(sizing({ maxTurns: 150 }), { ...room, currentMaxTurns: 150, costUsd: 0.3, maxUsd: 1 }).extraTurns, 50);
  // A headroom-raised ceiling (maxUsd $3 -> 300) is honored too.
  assert.equal(autoExtendedTurns(sizing({ maxTurns: 280 }), { ...room, currentMaxTurns: 280, costUsd: 0.1 }).extraTurns, 20);
  // At the ceiling there is nothing left.
  assert.equal(autoExtendedTurns(sizing({ maxTurns: AUTO_TURNS_MAX }), { ...room, currentMaxTurns: AUTO_TURNS_MAX, maxUsd: 1 }), undefined);
});

test('the observed per-turn spend sizes the extension once enough turns ran, bounded by the estimate and a floor', () => {
  // Field job: $0.20 over 200 turns is $0.001/turn; twice that is $0.002.
  assert.equal(observedTurnUsd({ costUsd: 0.2, turns: 200, turnUsdEstimate: FLASH_TURN_USD_ESTIMATE }), 0.002);
  // Too few turns to trust, or nothing spent yet: the static estimate.
  assert.equal(
    observedTurnUsd({ costUsd: 0.01, turns: OBSERVED_TURN_MIN_TURNS - 1, turnUsdEstimate: FLASH_TURN_USD_ESTIMATE }),
    FLASH_TURN_USD_ESTIMATE,
  );
  assert.equal(observedTurnUsd({ costUsd: 0, turns: 200, turnUsdEstimate: FLASH_TURN_USD_ESTIMATE }), FLASH_TURN_USD_ESTIMATE);
  assert.equal(observedTurnUsd({ costUsd: 0.2, turnUsdEstimate: FLASH_TURN_USD_ESTIMATE }), FLASH_TURN_USD_ESTIMATE);
  // An expensive history never raises the per-turn figure above the estimate.
  assert.equal(observedTurnUsd({ costUsd: 5, turns: 100, turnUsdEstimate: FLASH_TURN_USD_ESTIMATE }), FLASH_TURN_USD_ESTIMATE);
  // A near-free history is floored.
  assert.equal(observedTurnUsd({ costUsd: 0.000001, turns: 500, turnUsdEstimate: FLASH_TURN_USD_ESTIMATE }), OBSERVED_TURN_USD_FLOOR);
  // No estimate (a non-Flash route): nothing to size by.
  assert.equal(observedTurnUsd({ costUsd: 0.2, turns: 200 }), undefined);
});

test('the field case (200/200 Flash turns, $0.20 of $2.00) is no longer stranded at the 200-turn ceiling', () => {
  const field = { currentMaxTurns: AUTO_TURNS_MAX, costUsd: 0.2, maxUsd: 2, turnUsdEstimate: FLASH_TURN_USD_ESTIMATE };
  // With the static $0.01 estimate alone, $2 covers exactly 200 turns: no room.
  assert.equal(autoExtendedTurns(sizing({ maxTurns: AUTO_TURNS_MAX }), field), undefined);
  // Sized by what the turns actually cost, it gets half the cap.
  const out = autoExtendedTurns(sizing({ maxTurns: AUTO_TURNS_MAX }), { ...field, turnsUsed: 199 });
  assert.equal(out.extraTurns, 100);
  assert.equal(out.maxTurns, 300);
  assert.equal(out.budgetSizing.autoExtended.turnUsd, 0.00201);
  assert.match(out.budgetSizing.warnings[0], /auto-extended once by 100 \(200 -> 300\)[^;]*twice the observed average/);
  assert.equal(safeBudgetSizing(out.budgetSizing).autoExtended.turnUsd, 0.00201, 'the per-turn basis survives the allowlist');
  // Still bounded by the hard headroom ceiling and by the ceiling maxUsd covers at the observed cost.
  const nearCeiling = autoExtendedTurns(sizing({ maxTurns: 580 }), { ...field, currentMaxTurns: 580, maxUsd: 20, turnsUsed: 579 });
  assert.equal(nearCeiling.maxTurns, AUTO_TURNS_HEADROOM_MAX);
  // $0.60 over 200 turns sizes at $0.006/turn: $1.30 covers 216 turns, so 16 fit past 200.
  const tight = autoExtendedTurns(sizing({ maxTurns: AUTO_TURNS_MAX }), { ...field, costUsd: 0.6, maxUsd: 1.3, turnsUsed: 200 });
  assert.equal(tight.extraTurns, 16);
});

test('no extension for a caller-fixed cap, a non-Flash route, a mostly spent budget, or a bad record', () => {
  assert.equal(autoExtendedTurns(sizing({ turnPolicy: 'fixed', turnsSource: 'caller', initialTurnsSource: 'caller' }), room), undefined);
  assert.equal(autoExtendedTurns(sizing({ turnsSource: 'caller', initialTurnsSource: 'caller' }), room), undefined);
  assert.equal(autoExtendedTurns(sizing(), { ...room, turnUsdEstimate: undefined }), undefined, 'only a route with a per-turn estimate');
  assert.equal(autoExtendedTurns(sizing(), { ...room, costUsd: 1.5 }), undefined, 'half of maxUsd spent');
  assert.ok(autoExtendedTurns(sizing(), { ...room, costUsd: 1.49 }));
  assert.equal(autoExtendedTurns(sizing(), { ...room, maxUsd: undefined }), undefined);
  assert.equal(autoExtendedTurns(undefined, room), undefined);
  assert.equal(autoExtendedTurns({ maxTurns: 'x' }, room), undefined);
});

test('the worker-side wrapper applies a durable extension to the loop and queues exactly one wrap-up notice', async () => {
  const calls = [];
  const loop = { extendTurns: (n) => calls.push(['extend', n]) };
  const context = {
    add: (message) => calls.push(['add', message]),
    flush: async () => calls.push(['flush']),
  };
  let answer;
  const progress = withAutoExtension(
    async () => answer,
    () => loop,
    context,
    true,
  );
  assert.equal(await progress({ action: 'provider_usage' }), undefined);
  answer = { extraTurns: 5 }; // a credit-hop raise is applied by the provider callback, not here
  assert.deepEqual(await progress({}), { extraTurns: 5 });
  assert.deepEqual(calls, []);
  answer = { extraTurns: 67, wrapUp: true };
  assert.deepEqual(await progress({ action: 'provider_request_pending', turn: 134 }), answer);
  assert.deepEqual(calls, [['extend', 67], ['add', { role: 'user', content: autoExtensionNotice(67, true) }], ['flush']]);
  assert.match(autoExtensionNotice(67, true), /extended by 67 turns[\s\S]*call finish[\s\S]*verifier/);
  assert.doesNotMatch(autoExtensionNotice(67, false), /verifier/);
  // An out-of-range increment from a custom manager is ignored.
  calls.length = 0;
  answer = { extraTurns: 5000, wrapUp: true };
  await progress({});
  assert.deepEqual(calls, []);
});
