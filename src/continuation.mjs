/** Closed diagnoses shared by reports and the pre-mutation repair gate.
 * Never discard provider reasoning or replay an ambiguously billed request. */
export function continuationBlocker(job) {
  if (job.budgetFinishRecovery !== undefined)
    return 'job has an unresolved budget finish recovery; a terminal provider request may already have been billed and cannot be safely replayed; start a fresh job';
  if (job.cappedFinishRecovery === 'queued' || job.cappedFinishRecovery === 'consumed')
    return 'job has an unresolved capped implementation recovery; its constrained provider request cannot be safely reopened; start a fresh job';
  if (job.transcriptReplayable === false)
    return 'durable transcript reasoning is unavailable for safe provider replay because credential redaction changed provider protocol state; start a fresh job';
  return undefined;
}

export function promptCacheSummary(usage) {
  if (
    !usage ||
    !Number.isSafeInteger(usage.inputTokens) ||
    usage.inputTokens <= 0 ||
    !Number.isSafeInteger(usage.cacheHitTokens) ||
    usage.cacheHitTokens < 0 ||
    usage.cacheHitTokens > usage.inputTokens ||
    !Number.isSafeInteger(usage.cacheWriteTokens ?? 0) ||
    (usage.cacheWriteTokens ?? 0) < 0 ||
    (usage.cacheWriteTokens ?? 0) > usage.inputTokens - usage.cacheHitTokens
  )
    return undefined;
  return {
    inputTokens: usage.inputTokens,
    cacheHitTokens: usage.cacheHitTokens,
    cacheWriteTokens: usage.cacheWriteTokens ?? 0,
    hitRate: usage.cacheHitTokens / usage.inputTokens,
  };
}
