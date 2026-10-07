import { join } from 'node:path';
import { createDiagnosticLog, defaultLogDir } from './diagnostics.mjs';
import { readRegularFileSync } from './regular-file.mjs';
import { aggregateSignals, parseStoredRecord, storedRecord } from './retrospective.mjs';

/**
 * Local history of retrospective digests, beside the diagnostic log and under the same rules: one bounded
 * file that rotates once (so disk use is at most twice `maxBytes`), mode 0600, written without following a
 * symlink, never throwing, off with OFFLOAD_LOG=off, and never sent anywhere. It holds the redacted digest
 * only (no skeleton, no brief text), so `list` can show which signals keep coming back across sessions.
 */
export const RETROSPECTIVE_FILE = 'retrospectives.jsonl';
export const RETROSPECTIVE_LOG_LIMITS = Object.freeze({
  maxBytes: 192 * 1024,
  maxLineBytes: 8 * 1024,
  maxStackChars: 0,
  maxMessageChars: 0,
});
const MAX_READ_BYTES = 2 * RETROSPECTIVE_LOG_LIMITS.maxBytes;

export function createRetrospectiveLog({ dir = defaultLogDir(), env = process.env, now, limits = RETROSPECTIVE_LOG_LIMITS } = {}) {
  const log = createDiagnosticLog({ dir, env, file: RETROSPECTIVE_FILE, header: '', limits, ...(now ? { now } : {}) });
  return {
    path: log.path,
    /** Append one retrospective result (the skeleton and brief text are dropped). Never throws. */
    append: (result) => log.record(storedRecord(result)),
    /** The newest `limit` stored records, oldest first, and their signal counts. Unreadable or foreign lines are skipped. */
    history({ limit = 100 } = {}) {
      const records = [];
      for (const name of [`${RETROSPECTIVE_FILE}.1`, RETROSPECTIVE_FILE]) {
        let text;
        try {
          text = readRegularFileSync(join(dir, name), MAX_READ_BYTES).toString('utf8');
        } catch {
          continue;
        }
        for (const line of text.split('\n')) {
          const record = line.trim() ? parseStoredRecord(line) : undefined;
          if (record) records.push(record);
        }
      }
      const recent = records.slice(-Math.max(1, limit));
      return { path: log.path, records: recent, aggregate: aggregateSignals(recent) };
    },
  };
}
