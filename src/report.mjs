import { redactText } from './redact.mjs';
import { APPLY_ELIGIBLE_STATUSES, continuableFailure, failedApplyRefusal, safeFailureKind, safeToolFailure } from './failure.mjs';
import { formatDuration, sanitizeTiming, timingTotals } from './timing.mjs';

const terminal = new Set([
  'DONE_VERIFIED',
  'DONE_UNVERIFIED',
  'VERIFY_FAILED',
  'VERIFY_ENV_FAILED',
  'FAILED',
  'TIMEOUT',
  'BUDGET',
  'CANCELLED',
]);
export { terminal as terminalStatuses };
const VERIFY_ENV_KINDS = new Set(['missing-package', 'command-not-found', 'permission-denied', 'temp-dir-denied']);
const APPLY_ELIGIBLE = new Set(APPLY_ELIGIBLE_STATUSES);
/**
 * `detail: 'full'` is the durable report.md. `detail: 'compact'` is what a
 * primary session reads again and again over a job's life, so it carries the
 * decision-relevant lines only: status, cost, scope, a one-line verify result
 * with a short failure tail, and the next actions.
 */
export function compactReport(job, { detail = 'full', stall, spend } = {}) {
  const lean = detail === 'compact';
  job = job && typeof job === 'object' && !Array.isArray(job) ? job : {};
  const finishedAt = parseTimestamp(job.finishedAt),
    startedAt = parseTimestamp(job.createdAt || job.startedAt || job.finishedAt);
  const elapsed = Number.isFinite(finishedAt) && Number.isFinite(startedAt) ? Math.max(0, finishedAt - startedAt) : 0;
  const minutes = Math.floor(elapsed / 60000),
    seconds = Math.floor(elapsed / 1000) % 60;
  const line1 = `JOB ${scalar(job.id)}  ${scalar(job.status || 'QUEUED')}`;
  const reportMode = job.mode === 'report';
  const usage =
    job.usage &&
    typeof job.usage === 'object' &&
    !Array.isArray(job.usage) &&
    `in ${scalar(job.usage.inputTokens ?? 0)} (cache hit ${scalar(job.usage.cacheHitTokens ?? 0)}) out ${scalar(job.usage.outputTokens ?? 0)}`;
  const configured = job.configuredModel || job.model;
  const responseModel = job.responseModel && job.responseModel !== configured ? `response ${scalar(job.responseModel)}` : '';
  const cost =
    typeof job.costUsd === 'number' && Number.isFinite(job.costUsd) && job.costUsd >= 0
      ? `$${job.costUsd.toFixed(2)}`
      : job.costUsd != null
        ? 'cost unavailable'
        : '';
  const meta = [
    job.profile && `profile ${scalar(job.profile)}${configured ? ` (${scalar(configured)})` : ''}`,
    responseModel,
    job.rounds != null && `${scalar(job.rounds)} rounds`,
    elapsed && `${minutes}m${seconds}s`,
    job.turns != null && `${scalar(job.turns)} turns`,
    !lean && usage,
    cost,
  ]
    .filter(Boolean)
    .join(' · ');
  // Only for a session with more than one job: with one, the meta line already
  // carries that job's cumulative cost. Each job counts its whole cost, which
  // can include rounds from before this session, so the label says "touched". Built from numbers alone, so job data
  // cannot forge it.
  const spendLine =
    spend &&
    Number.isSafeInteger(spend.jobs) &&
    spend.jobs > 1 &&
    typeof spend.costUsd === 'number' &&
    Number.isFinite(spend.costUsd) &&
    spend.costUsd >= 0
      ? `spend across ${spend.jobs} jobs touched this session: $${spend.costUsd.toFixed(spend.costUsd < 1 ? 3 : 2)} (each job's cumulative cost)${Number.isSafeInteger(spend.unknown) && spend.unknown > 0 ? ` (${spend.unknown} with unknown cost)` : ''}`
      : '';
  const pricing =
    job.pricingId && !lean
      ? `pricing: ${scalar(job.pricingId)}${job.pricingFetchedAt ? ` (fetched ${scalar(job.pricingFetchedAt)})` : ''}`
      : '';
  const branchState =
    job.branchChangedAfterIntegration === true ? ' (CHANGED AFTER INTEGRATION)' : job.branchChanged ? ' (CHANGED)' : ' (unchanged)';
  const branch =
    job.branch && (!lean || job.branchChanged || job.branchChangedAfterIntegration)
      ? `branch ${scalar(job.branch)}${job.head ? ` @ ${scalar(job.head)}` : ''}${branchState}`
      : '';
  const files = Array.isArray(job.files) ? job.files.slice(0, 2_000) : [];
  const changes = files
    .slice(0, lean ? 8 : files.length)
    .map((file) => {
      const f = file && typeof file === 'object' ? file : {};
      return `${scalar(f.status || 'M')} ${scalar(f.path || '')}${f.added != null ? ` (+${scalar(f.added)}/-${scalar(f.removed || 0)})` : ''}`;
    })
    .join(' · ')
    .concat(lean && files.length > 8 ? ` · +${files.length - 8} more` : '');
  const violations = Array.isArray(job.scopeViolations) ? job.scopeViolations.slice(0, 2_000) : [];
  const scope = violations.length ? `scope: VIOLATIONS: ${violations.map(scalar).join(', ')}` : 'scope: ok';
  const isolation = reportMode
    ? 'isolation: private read-only worktree · never integrated into primary'
    : job.workspacePath
      ? `isolation: private worktree · ${job.revertUncertain ? 'reverse outcome uncertain; inspect primary' : job.revertedAt ? 'applied patch reverted' : job.integrationUncertain ? 'integration outcome uncertain; inspect primary' : job.applied === true ? 'applied to primary' : job.integrationConflict ? 'primary conflict; not applied' : 'not applied'}${job.noChanges ? ' (no owned changes)' : ''}`
      : '';
  const discarded =
    Array.isArray(job.discardedEphemeralOutputs) && job.discardedEphemeralOutputs.length
      ? `discarded ephemeral outputs: ${job.discardedEphemeralOutputs.slice(0, 200).map(scalar).join(', ')}`
      : '';
  const verifierDiagnostic = job.verify?.result?.stderr || job.verify?.result?.stdout;
  // A passing run's output is noise to a reviewer; a failing run's tail is the
  // evidence. The compact view keeps only the failure tail, and keeps it short.
  const showDiagnostic = verifierDiagnostic && (!lean || job.verify?.verdict !== 'PASS');
  const baseline = job.verify?.baseline && typeof job.verify.baseline === 'object' ? job.verify.baseline : undefined;
  // A PASS reached by the baseline-diff verifier means "no new failures", not a
  // green suite: the result's own non-zero exit stays visible beside it.
  const viaBaseline =
    baseline?.status === 'compared' && job.verify?.verdict === 'PASS'
      ? ` via baseline-diff: ${scalar(baseline.preexisting ?? 0)} pre-existing failure(s) tolerated, ${scalar(baseline.newFailureCount ?? 0)} new`
      : '';
  const verify = job.verify
    ? `verify: \`${scalar(job.verify.command || '')}\` ${scalar(job.verify.verdict || 'UNVERIFIED')}${job.verify.result?.code != null ? ` (exit ${scalar(job.verify.result.code)})` : ''}${viaBaseline}${job.verify.result?.sandbox ? ` · sandbox: ${scalar(job.verify.result.sandbox)}` : ''}${showDiagnostic ? `\n${verifierOutput(verifierDiagnostic, lean ? 20 : 40)}` : ''}`
    : 'verify: not run';
  const baselineDiff = !reportMode && baseline ? baselineLines(baseline, lean) : '';
  // The command is still running (or being reverted): the diff is in the
  // primary but nothing has decided whether it stays, so it is not yet a
  // revert candidate.
  const applyRunning = job.applyVerifyIntent === true;
  // An environmental failure is not a verdict on the worker's code: the
  // verifier could not run because of something the worker cannot supply
  // (it has no network and cannot write outside its scope). The server did not
  // spend a repair round on it and never retries automatically.
  const environment =
    !reportMode && VERIFY_ENV_KINDS.has(job.verifyEnvironment?.kind)
      ? `verifier environment: ${scalar(job.verifyEnvironment.detail || job.verifyEnvironment.kind)}. This is not a repair-able code failure; no repair round was spent and none will be started automatically.${
          job.verifyEnvironment.kind === 'missing-package'
            ? job.workspaceDependencies && job.workspaceDependencies !== 'linked'
              ? ` The primary checkout's node_modules was not linked (${scalar(job.workspaceDependencies)}): install dependencies there.`
              : ' Either it is not installed in the primary checkout, it lives in a nested/workspace package outside the linked root node_modules, or the worker imported a package that does not exist (check the diff).'
            : job.verifyEnvironment.kind === 'temp-dir-denied'
              ? ' Hard-coded /tmp is not writable in the verifier; tests must use os.tmpdir()/$TMPDIR and forward the environment to child processes. For a suite with such pre-existing failures, start with verifierMode "baseline-diff".'
              : ''
        }${
          // An applyThenVerify run is already acting on this very advice.
          applyRunning
            ? ''
            : ' Review the diff, then use offload_apply to integrate it: applyThenVerify "<your check>" applies it, runs the check in the primary checkout and reverts it if the check fails (or pass verifiedBy for a check you ran yourself), or start a fresh job.'
        }`
      : '';
  const appliedUnverified =
    job.appliedUnverified && typeof job.appliedUnverified === 'object'
      ? `applied WITHOUT server verification (was ${scalar(job.appliedUnverified.previousStatus || 'unknown')}${originalFailure(job.appliedUnverified.failure)}); primary's own check: ${scalar(job.appliedUnverified.verifiedBy || (job.appliedUnverified.applyThenVerify ? 'applyThenVerify (below)' : 'not recorded')).slice(0, 400)}`
      : '';
  const applyVerify = !reportMode ? applyVerifyLines(job.applyVerify, lean) : '';
  const summary = job.summary ? `worker summary: ${scalar(job.summary).slice(0, lean ? 300 : 1500)}` : '';
  const concerns =
    Array.isArray(job.concerns) && job.concerns.length
      ? `concerns: ${scalar(job.concerns.slice(0, 100).map(String).join('; ')).slice(0, lean ? 400 : 1500)}`
      : '';
  const error = job.error ? `error: ${scalar(job.error).slice(0, 1500)}` : '';
  const providerFailure = providerFailureLine(job.providerFailure);
  const providerFinishReason = providerFinishReasonLine(job.providerFinishReason);
  const budgetReservation = budgetReservationLine(job.budgetReservation);
  const budgetStop = job.status === 'BUDGET' ? budgetStopLine(job.budgetStop) : '';
  // A cap stop happens before the normal post-finish verifier phase. Keep the
  // command private, but make the safe path explicit: continuing lets the
  // configured verifier run; a reviewed late apply should use its
  // applyThenVerify counterpart rather than silently rely on a hand-written
  // evidence string.
  const skippedConfiguredVerifier =
    !reportMode && job.status === 'BUDGET' && typeof job.testCommand === 'string' && job.testCommand.trim() && !job.verify
      ? 'configured verifier: not run because the worker reached its cap before finish. Continue to let the server run it; if you apply the reviewed diff instead, use applyThenVerify with the same focused check.'
      : '';
  // Only a turn-cap stop is explained by the cap, and only while the record
  // still describes the cap the job has (a continuation raises it).
  const turnBudget =
    job.status === 'BUDGET' &&
    job.budgetStop?.cap === 'turns' &&
    (!Number.isSafeInteger(job.budget?.maxTurns) || job.budgetSizing?.maxTurns === job.budget.maxTurns)
      ? budgetSizingLine(job.budgetSizing)
      : '';
  // Why a provider stopped matters when a job did not finish; it is noise on success.
  const failureDiagnostics = !String(job.status || '').startsWith('DONE');
  const limitation =
    job.sandboxMode === 'policy-only' || job.verify?.result?.sandbox === 'policy-only'
      ? 'sandbox: policy-only (OS isolation unavailable)'
      : '';
  const unsafeVerifier = job.unsafePolicyOnlyVerifier === true ? 'verifier consent: unsafe policy-only fallback authorized by caller' : '';
  const workspaceCleanup =
    job.workspaceCleanupRequired === true
      ? `workspace cleanup: MANUAL REQUIRED${job.workspaceCleanupError ? ` — ${scalar(job.workspaceCleanupError)}` : ''}`
      : job.workspaceCleanupError
        ? `workspace cleanup: RETRYABLE ERROR — ${scalar(job.workspaceCleanupError)}`
        : '';
  const nextActions = reportMode ? ['read reportResult'] : [`offload_job {jobId:${JSON.stringify(scalar(job.id))}, include:"diff"}`];
  if (!reportMode && !violations.length && job.applied === true && !job.revertedAt && !job.revertUncertain && !applyRunning)
    nextActions.push('revert');
  const mutationSettled =
    !job.integrationIntent &&
    !job.revertIntent &&
    !applyRunning &&
    !job.integrationUncertain &&
    !job.revertUncertain &&
    job.applied !== true;
  // The same gates JobManager.repair() enforces, so a report never advertises
  // a next action the server will refuse.
  const roundAvailable =
    (job.rounds || 0) < (job.maxRepairRounds ?? 2) &&
    job.budgetFinishRecovery === undefined &&
    job.cappedFinishRecovery !== 'queued' &&
    job.cappedFinishRecovery !== 'consumed' &&
    // An inconclusive baseline comparison is a failure no repair round can address.
    baseline?.status !== 'inconclusive' &&
    (!job.verify || job.verify?.result?.sandbox === 'macos');
  // The cumulative caps bind a repair (it is no way around a spent cap) but not
  // a continuation, which raises them.
  const budgetSpent =
    (job.budget?.maxTurns != null && (job.turns || 0) >= job.budget.maxTurns) ||
    (job.budget?.maxUsd != null && (job.costUsd || 0) >= job.budget.maxUsd);
  if (
    !reportMode &&
    !violations.length &&
    mutationSettled &&
    job.status !== 'DONE_VERIFIED' &&
    job.status !== 'DONE_UNVERIFIED' &&
    job.status !== 'VERIFY_ENV_FAILED' &&
    roundAvailable &&
    !budgetSpent
  )
    nextActions.push('repair');
  // A cap stop is not a failure of the work: keep it and let the primary
  // raise the cap. A FAILED round the worker itself ended (loop, no finish,
  // output cap) is resumable too, by the same gate the server enforces.
  // Offered only when there is in-scope work worth keeping.
  const capStop = job.status === 'BUDGET' || job.status === 'TIMEOUT';
  if (!reportMode && !violations.length && mutationSettled && (capStop || continuableFailure(job)) && files.length && roundAvailable) {
    nextActions.push(!capStop && budgetSpent ? 'continue (extraTurns/extraUsd needed: the cumulative budget is spent)' : 'continue');
  }
  // A FAILED job only through the gate offload_apply enforces on its retained diff.
  const appliable = APPLY_ELIGIBLE.has(job.status) || (job.status === 'FAILED' && !failedApplyRefusal(job));
  if (!reportMode && !violations.length && mutationSettled && appliable && files.length) nextActions.push('apply (after your own check)');
  const raw = [
    line1,
    meta,
    spendLine,
    ...timingLines(job, { lean, elapsed }),
    stallLine(stall),
    pricing,
    branch,
    changes && `worker changes: ${changes}`,
    scope,
    isolation,
    discarded,
    verify,
    baselineDiff,
    environment,
    appliedUnverified,
    applyVerify,
    limitation,
    unsafeVerifier,
    workspaceCleanup,
    summary,
    concerns,
    providerFailure,
    (!lean || failureDiagnostics) && providerFinishReason,
    (!lean || failureDiagnostics) && budgetReservation,
    failureDiagnostics && turnBudget,
    failureDiagnostics && budgetStop,
    skippedConfiguredVerifier,
    // Directly before `error:`, which it explains.
    failureDiagnostics && failingCallLine(job.toolFailure),
    error,
    `next: ${nextActions.join(' · ')}`,
  ]
    .filter(Boolean)
    .join('\n');
  return redactText(raw);
}
/** What a FAILED job's worker did wrong, kept on a diff the primary applied from it. */
function originalFailure(failure) {
  if (!failure || typeof failure !== 'object' || Array.isArray(failure) || typeof failure.reason !== 'string') return '';
  const kind = safeFailureKind(failure.kind);
  return `; original failure: ${kind ? `${kind}: ` : ''}${scalar(failure.reason).slice(0, 300)}`;
}
const TIME_PARTS = [
  ['queue', 'queueMs'],
  ['setup', 'setupMs'],
  ['startup', 'startupMs'],
  ['provider', 'providerMs'],
  ['tools', 'toolMs'],
  ['verify', 'verifyMs'],
  ['finalize', 'finalizeMs'],
  ['other', 'otherMs'],
];
// Queue, setup and startup are noise below this; their time is folded into "other".
const SMALL_PART_MS = 5_000;
/**
 * Where the wall clock went: `time:` is the whole job (all rounds), and the
 * full report adds one line per round and the primary's own idle time between
 * rounds. Built only from the closed shape sanitizeTiming returns.
 */
function timingLines(job, { lean, elapsed }) {
  const timing = sanitizeTiming(job.timing);
  if (!timing) return [];
  const totals = timingTotals(timing);
  const total = totals.queueMs + totals.setupMs + totals.activeMs;
  if (lean && total < 5_000) return [];
  const finished = terminal.has(job.status);
  const folded = ['queueMs', 'setupMs', 'startupMs'].filter((key) => totals[key] < SMALL_PART_MS);
  const parts = TIME_PARTS.map(([name, key]) => ({
    name,
    ms:
      key === 'otherMs' ? totals.otherMs + folded.reduce((sum, hidden) => sum + totals[hidden], 0) : folded.includes(key) ? 0 : totals[key],
  })).filter((part) => part.ms >= 1_000);
  const detailFor = {
    provider: totals.providerCalls
      ? ` (${totals.providerCalls} call${totals.providerCalls === 1 ? '' : 's'}${totals.providerMaxMs ? `, max ${formatDuration(totals.providerMaxMs)}` : ''})`
      : '',
    tools: totals.toolMaxName && totals.toolMaxMs ? ` (max ${totals.toolMaxName} ${formatDuration(totals.toolMaxMs)})` : '',
  };
  const equation = parts.map((part) => `${part.name} ${formatDuration(part.ms)}${detailFor[part.name] ?? ''}`).join(' + ');
  const major = parts.filter((part) => part.name !== 'other').sort((a, b) => b.ms - a.ms)[0];
  const share = major && total ? major.ms / total : 0;
  const dominant =
    major && (['TIMEOUT', 'BUDGET'].includes(job.status) || (total >= 300_000 && share >= 0.6))
      ? ` - dominant: ${major.name} ${Math.round(share * 100)}%`
      : '';
  const lines = [`${finished ? 'time' : 'time (so far)'}: ${formatDuration(total)}${equation ? ` = ${equation}` : ''}${dominant}`];
  if (!lean) {
    for (const round of timing.rounds) {
      const shown = TIME_PARTS.filter(([, key]) => key !== 'otherMs' || round.otherMs > 0)
        .map(([name, key]) => [name, round[key]])
        .filter(([, ms]) => ms > 0)
        .map(([name, ms]) => `${name} ${formatDuration(ms)}`);
      lines.push(`timing round ${round.round} (${round.reason}): ${shown.join(' · ') || 'no time recorded'}`);
    }
    // The job's own clock minus everything a round accounts for: the primary's
    // think time before it repaired or continued, not a fault of the job.
    const accounted = timing.rounds.reduce(
      (sum, round) => sum + (round.queueMs ?? 0) + round.activeMs + (round.round > 0 ? (round.setupMs ?? 0) : 0),
      0,
    );
    const idle = elapsed - accounted;
    if (timing.rounds.length > 1 && finished && idle >= 30_000 && idle >= elapsed * 0.1)
      lines.push(`timing idle between rounds: ${formatDuration(idle)} (time before a repair or continue was requested)`);
  }
  return lines;
}
/** The advisory stall warning of a running job, rebuilt from its closed fields. */
function stallLine(value) {
  if (!value || typeof value !== 'object' || ![1, 2].includes(value.level) || typeof value.message !== 'string') return '';
  return `stall: ${scalar(value.message).slice(0, 400)}`;
}
/**
 * One line per applyThenVerify state, then the command's output tail nested like
 * any verifier output. A pass is the primary's own check run by the server after
 * applying: it is never described as server-verified.
 */
function applyVerifyLines(record, lean) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return '';
  const command = `\`${scalar(record.command || '').slice(0, 300)}\``;
  const seconds = Number.isFinite(record.durationMs) ? `${Math.round(record.durationMs / 100) / 10}s` : undefined;
  const ran = record.ranUnder ? `sandbox: ${scalar(record.ranUnder)}` : undefined;
  // The label states what actually ran: consent only permits an unsandboxed
  // run, and a host that can sandbox still sandboxes it.
  const unsandboxed =
    record.sandbox !== 'policy-only-authorized'
      ? ''
      : record.ranUnder === 'macos'
        ? ' Policy-only consent was given but the command ran sandboxed.'
        : ' UNSANDBOXED (policy-only authorized by the caller).';
  const tail = (lines) => (record.outputTail ? `\n${verifierOutput(record.outputTail, lines)}` : '');
  const outcome = scalar(record.outcome || 'unknown');
  if (['applying', 'verifying', 'reverting'].includes(record.phase))
    return `applyThenVerify RUNNING (${scalar(record.phase)}) since ${scalar(record.startedAt || 'unknown')}: ${command} — the diff is applied and will be reverted automatically if this fails`;
  if (record.outcome === 'PASSED') {
    const others = Array.isArray(record.primaryChangedDuringVerify) && record.primaryChangedDuringVerify.length;
    return `applyThenVerify PASSED (${[`exit ${scalar(record.exitCode ?? 0)}`, seconds, ran].filter(Boolean).join(', ')}): ${command} — the primary's own check, run by the server after applying; the job is DONE_UNVERIFIED, not server-verified.${unsandboxed}${others ? ` Other primary files changed meanwhile: ${record.primaryChangedDuringVerify.slice(0, 20).map(scalar).join(', ')}.` : ''}${tail(lean ? 10 : 40)}`;
  }
  if (record.outcome === 'INTERRUPTED')
    return `applyThenVerify INTERRUPTED: the server stopped before a result was recorded; the diff ${record.reverted ? 'was restored' : 'is STILL APPLIED'}; treat it as UNVERIFIED${record.autoRevertError ? ` (${scalar(record.autoRevertError)})` : ''}`;
  if (record.outcome === 'PRIMARY_CHANGED')
    return `applyThenVerify ${scalar(record.commandOutcome || 'finished')} but the primary changed during verification, so the AUTO-REVERT DID NOT COMPLETE (${scalar(record.autoRevertError || 'job-owned paths changed')}) — the diff is STILL APPLIED; inspect the primary, then run offload_revert (dry run first)${tail(lean ? 20 : 40)}`;
  if (record.reverted !== true)
    return `applyThenVerify ${outcome}: VERIFICATION DID NOT PASS and the AUTO-REVERT DID NOT COMPLETE (${scalar(record.autoRevertError || 'unknown')}) — the diff is STILL APPLIED; run offload_revert (dry run first)${tail(lean ? 20 : 40)}`;
  const exit =
    record.exitCode !== undefined ? `exit ${scalar(record.exitCode)}` : record.error ? scalar(record.error).slice(0, 160) : undefined;
  return `applyThenVerify ${outcome}${exit || seconds ? ` (${[exit, seconds, ran].filter(Boolean).join(', ')})` : ''}: ${command} — the diff was REVERTED; the primary's job-owned paths are verified identical to before${record.primaryRestoredExactly === false ? ' (other primary files changed during verification and were left alone)' : ''}. Fix the cause and call offload_apply again${tail(lean ? 20 : 40)}`;
}
const BASELINE_HINTS = {
  'unparseable-output': 'Use a runner with node:test/TAP/jest/pytest/go/cargo output so failing tests can be named.',
  'baseline-timed-out': 'The untouched-snapshot run timed out: raise verifierTimeoutSec.',
  'result-timed-out': 'Raise verifierTimeoutSec.',
  'incomplete-output': 'The run ended without a test summary (crash or kill), so missing failures cannot be ruled out.',
  'stopped-early':
    "The runner stopped before running every test (pytest -x/--maxfail or a collection error, cargo without --no-fail-fast, go -failfast, --bail), so the worker's new tests may never have run: drop the flag, or pass --no-fail-fast / --continue-on-collection-errors.",
  'failure-list-truncated': 'Too many distinct failures to compare.',
  'count-increase-without-new-names': 'More tests fail than in the snapshot but under the same names (the same test in another file?).',
  'unparsed-failures': 'The summary reports more failures than could be named.',
  'baseline-unavailable': 'The untouched snapshot could not be run.',
  'baseline-cancelled': 'The job was cancelled during the snapshot run.',
};
/** Nested, single-line names: a failing test's name is untrusted text and must not forge a report field. */
function baselineLines(baseline, lean) {
  const seconds = (ms) => `${Math.round((Number.isFinite(ms) ? ms : 0) / 100) / 10}s`;
  const names = Array.isArray(baseline.newFailures) ? baseline.newFailures.slice(0, 50) : [];
  const shown = names.slice(0, lean ? 8 : names.length).map((name) => `  | ${scalar(name)}`);
  const hidden = Math.max(0, (Number.isFinite(baseline.newFailureCount) ? baseline.newFailureCount : names.length) - shown.length);
  const list = [...shown, ...(hidden ? [`  | (+${scalar(hidden)} more)`] : [])];
  if (baseline.status === 'compared' && baseline.regression)
    return [
      `baseline-diff: the untouched snapshot passed but the result failed (exit ${scalar(baseline.result?.code ?? '?')}) · ${scalar(baseline.newFailureCount ?? 0)} failing test(s) parsed`,
      ...list,
    ].join('\n');
  if (baseline.status === 'compared')
    return [
      `baseline-diff: ${scalar(baseline.result?.failures ?? 0)} failing now vs ${scalar(baseline.baseline?.failures ?? 0)} in the untouched snapshot · ${scalar(baseline.newFailureCount ?? 0)} new, ${scalar(baseline.preexisting ?? 0)} pre-existing, ${scalar(baseline.fixed ?? 0)} fixed · snapshot run ${seconds(baseline.baseline?.durationMs)}, result run ${seconds(baseline.result?.durationMs)}`,
      ...list,
    ].join('\n');
  if (baseline.status === 'inconclusive')
    return `baseline-diff: INCONCLUSIVE (${scalar(baseline.reason || 'unknown')}) - treated as a failure; no repair round was spent. ${BASELINE_HINTS[baseline.reason] || ''}`.trimEnd();
  if (baseline.status === 'skipped' && baseline.reason === 'result-timed-out')
    return `baseline-diff: skipped (the result run timed out). ${BASELINE_HINTS['result-timed-out']}`;
  if (baseline.status === 'skipped' && baseline.reason === 'sandbox-unavailable')
    return 'baseline-diff: skipped (the verifier did not run under the macOS sandbox)';
  return '';
}
/**
 * The call the loop guard stopped on, as one line a stray newline in an argument cannot split.
 * safeToolFailure already strips controls, newlines and secrets; scalar() is a second layer
 * so a future change to that sanitizer cannot let a field split or forge a report line.
 */
function failingCallLine(value) {
  const failure = safeToolFailure(value);
  if (!failure) return '';
  const call = [scalar(failure.tool), failure.args && scalar(failure.args)].filter(Boolean).join(' ');
  return `last failing tool call: ${call} (turn ${failure.turn}, failed ${failure.repeats}x)${failure.error ? ` -- ${scalar(failure.error)}` : ''}`;
}
function providerFinishReasonLine(value) {
  const reasons = new Set(['stop', 'length', 'tool_calls', 'function_call', 'content_filter', 'other']);
  return reasons.has(value) ? `provider finish reason: ${value}` : '';
}
const BUDGET_STOP_CAPS = new Set(['turns', 'usd', 'reservation', 'other']);
const money = (value) => (value === 0 || value >= 0.01 ? value.toFixed(2) : value.toFixed(4));
/** Which cap ended a BUDGET round, with the spend against it, so the primary raises the right one. */
function budgetStopLine(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !BUDGET_STOP_CAPS.has(value.cap)) return '';
  const { turns, maxTurns, costUsd, maxUsd } = value;
  if (![turns, maxTurns].every((n) => Number.isSafeInteger(n) && n >= 0) || ![costUsd, maxUsd].every((n) => Number.isFinite(n) && n >= 0))
    return '';
  const used = `${turns}/${maxTurns} turns`;
  const spent = `$${money(costUsd)} of $${money(maxUsd)}`;
  const left = `$${money(Math.max(0, maxUsd - costUsd))}`;
  switch (value.cap) {
    case 'turns':
      return `budget stop: TURN cap reached (${used}; ${spent} spent, ${left} left). Turns, not USD, stopped it: offload_continue with extraTurns only.`;
    case 'usd':
      return `budget stop: USD cap reached (${spent}; ${used} used). Continue with extraUsd.`;
    case 'reservation':
      return `budget stop: the remaining ${left} cannot fund the next request (${used}, ${spent}); continue with extraUsd.`;
    default:
      return `budget stop: ${used}, ${spent}.`;
  }
}
const TURN_SOURCES = new Set(['default', 'scaled', 'caller', 'raised']);
/** Shown only when the server flagged the cap (it is below its own recommendation). */
function budgetSizingLine(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !TURN_SOURCES.has(value.turnsSource)) return '';
  const warnings = Array.isArray(value.warnings) ? value.warnings.filter((w) => typeof w === 'string' && w).slice(0, 4) : [];
  if (!warnings.length || !Number.isSafeInteger(value.maxTurns)) return '';
  const recommended = Number.isSafeInteger(value.recommendedTurns) ? `; recommended ${value.recommendedTurns}` : '';
  return `turn budget: ${value.maxTurns} (${scalar(value.turnsSource)}${recommended}) - ${warnings.map((w) => scalar(w).slice(0, 400)).join(' ')}`;
}
function budgetReservationLine(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const projections = new Set(['raw', 'tool-elision', 'deep-tool-elision']);
  const numeric = [
    'conservativeInputTokens',
    'conservativeInputUsd',
    'minOutputTokens',
    'minOutputUsd',
    'remainingUsd',
    'requiredUsd',
    'shortfallUsd',
    'elidedToolResults',
  ];
  if (
    !projections.has(value.projection) ||
    value.minOutputTokens !== 16 ||
    numeric.some((key) => !Number.isFinite(value[key]) || value[key] < 0)
  )
    return '';
  return `budget reservation: ${value.projection}; input ${value.conservativeInputTokens} tokens/$${value.conservativeInputUsd}; minimum output ${value.minOutputTokens} tokens/$${value.minOutputUsd}; remaining $${value.remainingUsd}; required $${value.requiredUsd}; shortfall $${value.shortfallUsd}; elided tool results ${value.elidedToolResults}`;
}
function providerFailureLine(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const kinds = new Set(['request', 'http', 'transport', 'attempt_timeout', 'redirect', 'sse_protocol', 'sse_limit']);
  if (!kinds.has(value.kind)) return '';
  const attempt =
    Number.isSafeInteger(value.attempts) && value.attempts > 0 && value.attempts <= 16
      ? ` after ${value.attempts} attempt${value.attempts === 1 ? '' : 's'}`
      : '';
  const status =
    value.kind === 'http' && Number.isSafeInteger(value.status) && value.status >= 100 && value.status <= 599
      ? ` HTTP ${value.status}`
      : '';
  const timeout =
    value.kind === 'attempt_timeout' && Number.isSafeInteger(value.timeoutMs) && value.timeoutMs >= 30_000 && value.timeoutMs <= 600_000
      ? ` (${Math.floor(value.timeoutMs / 1000)}s limit)`
      : '';
  return `provider failure: ${scalar(value.kind)}${status}${attempt}${timeout}`;
}
function parseTimestamp(value) {
  return typeof value === 'string' || value instanceof Date ? Date.parse(value) : NaN;
}
function stripTerminalEscapes(value) {
  const input = String(value);
  let output = '';
  for (let index = 0; index < input.length; index += 1) {
    if (input.charCodeAt(index) !== 0x1b) {
      output += input[index];
      continue;
    }
    const kind = input.charCodeAt(index + 1);
    if (kind === 0x5b) {
      // CSI: consume through its final byte (0x40–0x7e).
      index += 2;
      while (index < input.length && (input.charCodeAt(index) < 0x40 || input.charCodeAt(index) > 0x7e)) index += 1;
      continue;
    }
    if (kind === 0x5d) {
      // OSC: terminate at BEL or ST (ESC \\). This bounded linear scan avoids
      // a backtracking expression over untrusted verifier output.
      index += 2;
      while (index < input.length) {
        if (input.charCodeAt(index) === 0x07) break;
        if (input.charCodeAt(index) === 0x1b && input.charCodeAt(index + 1) === 0x5c) {
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }
  }
  return output;
}
function stripControls(value) {
  return stripTerminalEscapes(value)
    .replace(/\t/g, '↹')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '');
}
function scalar(value) {
  // Strip an entire terminal sequence before clipping. Clipping first could
  // leave an unterminated OSC sequence whose legitimate suffix is discarded.
  return redactText(
    stripControls(String(value))
      .slice(0, 4_096)
      .replace(/[\r\n]/g, '↩'),
  );
}
function verifierOutput(text, lines) {
  // Verifier output is deliberately multiline, but it is always visually
  // nested so a test cannot forge report fields such as `scope:` or `JOB`.
  return redactText(
    stripControls(String(text))
      .split(/\r?\n/)
      .slice(-lines)
      .map((line) => `  | ${line}`)
      .join('\n'),
  );
}
