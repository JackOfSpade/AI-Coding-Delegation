import { redactText } from './redact.mjs';

const terminal = new Set(['DONE_VERIFIED', 'DONE_UNVERIFIED', 'VERIFY_FAILED', 'FAILED', 'TIMEOUT', 'BUDGET', 'CANCELLED']);
export { terminal as terminalStatuses };
export function compactReport(job) {
  job = job && typeof job === 'object' && !Array.isArray(job) ? job : {};
  const finishedAt = parseTimestamp(job.finishedAt),
    startedAt = parseTimestamp(job.createdAt || job.startedAt || job.finishedAt);
  const elapsed = Number.isFinite(finishedAt) && Number.isFinite(startedAt) ? Math.max(0, finishedAt - startedAt) : 0;
  const minutes = Math.floor(elapsed / 60000),
    seconds = Math.floor(elapsed / 1000) % 60;
  const line1 = `JOB ${scalar(job.id)}  ${scalar(job.status || 'QUEUED')}`;
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
    usage,
    cost,
  ]
    .filter(Boolean)
    .join(' · ');
  const pricing = job.pricingId
    ? `pricing: ${scalar(job.pricingId)}${job.pricingFetchedAt ? ` (fetched ${scalar(job.pricingFetchedAt)})` : ''}`
    : '';
  const branchState =
    job.branchChangedAfterIntegration === true ? ' (CHANGED AFTER INTEGRATION)' : job.branchChanged ? ' (CHANGED)' : ' (unchanged)';
  const branch = job.branch ? `branch ${scalar(job.branch)}${job.head ? ` @ ${scalar(job.head)}` : ''}${branchState}` : '';
  const files = Array.isArray(job.files) ? job.files.slice(0, 2_000) : [];
  const changes = files
    .map((file) => {
      const f = file && typeof file === 'object' ? file : {};
      return `${scalar(f.status || 'M')} ${scalar(f.path || '')}${f.added != null ? ` (+${scalar(f.added)}/-${scalar(f.removed || 0)})` : ''}`;
    })
    .join(' · ');
  const violations = Array.isArray(job.scopeViolations) ? job.scopeViolations.slice(0, 2_000) : [];
  const scope = violations.length ? `scope: VIOLATIONS: ${violations.map(scalar).join(', ')}` : 'scope: ok';
  const isolation = job.workspacePath
    ? `isolation: private worktree · ${job.revertUncertain ? 'reverse outcome uncertain; inspect primary' : job.revertedAt ? 'applied patch reverted' : job.integrationUncertain ? 'integration outcome uncertain; inspect primary' : job.applied === true ? 'applied to primary' : job.integrationConflict ? 'primary conflict; not applied' : 'not applied'}${job.noChanges ? ' (no owned changes)' : ''}`
    : '';
  const discarded =
    Array.isArray(job.discardedEphemeralOutputs) && job.discardedEphemeralOutputs.length
      ? `discarded ephemeral outputs: ${job.discardedEphemeralOutputs.slice(0, 200).map(scalar).join(', ')}`
      : '';
  const verifierDiagnostic = job.verify?.result?.stderr || job.verify?.result?.stdout;
  const verify = job.verify
    ? `verify: \`${scalar(job.verify.command || '')}\` ${scalar(job.verify.verdict || 'UNVERIFIED')}${job.verify.result?.code != null ? ` (exit ${scalar(job.verify.result.code)})` : ''}${job.verify.result?.sandbox ? ` · sandbox: ${scalar(job.verify.result.sandbox)}` : ''}${verifierDiagnostic ? `\n${verifierOutput(verifierDiagnostic, 40)}` : ''}`
    : 'verify: not run';
  const summary = job.summary ? `worker summary: ${scalar(job.summary).slice(0, 1500)}` : '';
  const concerns =
    Array.isArray(job.concerns) && job.concerns.length
      ? `concerns: ${scalar(job.concerns.slice(0, 100).map(String).join('; ')).slice(0, 1500)}`
      : '';
  const error = job.error ? `error: ${scalar(job.error).slice(0, 1500)}` : '';
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
  const nextActions = [`offload_job {jobId:${JSON.stringify(scalar(job.id))}, include:"diff"}`];
  if (!violations.length && job.applied === true && !job.revertedAt && !job.revertUncertain) nextActions.push('revert');
  if (
    !violations.length &&
    job.applied !== true &&
    !job.integrationIntent &&
    !job.revertIntent &&
    !job.integrationUncertain &&
    !job.revertUncertain &&
    job.status !== 'DONE_VERIFIED' &&
    job.status !== 'DONE_UNVERIFIED' &&
    (!job.verify || job.verify?.result?.sandbox === 'macos')
  )
    nextActions.push('repair');
  const raw = [
    line1,
    meta,
    pricing,
    branch,
    changes && `worker changes: ${changes}`,
    scope,
    isolation,
    discarded,
    verify,
    limitation,
    unsafeVerifier,
    workspaceCleanup,
    summary,
    concerns,
    error,
    `next: ${nextActions.join(' · ')}`,
  ]
    .filter(Boolean)
    .join('\n');
  return redactText(raw);
}
function parseTimestamp(value) {
  return typeof value === 'string' || value instanceof Date ? Date.parse(value) : NaN;
}
function stripControls(value) {
  return String(value)
    .replace(/\x1B(?:\[[0-?]*[ -\/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g, '')
    .replace(/\t/g, '↹')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}
function scalar(value) {
  return redactText(stripControls(String(value).slice(0, 4_096)).replace(/[\r\n]/g, '↩'));
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
