/**
 * Files a worker created that look like its own working files, not deliverables.
 * A worker can stop on a budget before it cleans up, and anything in an owned
 * path integrates, so this reads the final file list, whatever the worker did.
 * It only warns. Only created files count, and whole path segments and suffixes
 * are matched, so `template/`, `attempt.js` and an edited `tmp/x.js` are not flagged.
 */
// `_tmp_edit` and `.tmp` are working directories; `temp-converter` may be a product.
const SCRATCH_DIRECTORY = /^(?:tmp|temp|scratch|[._](?:tmp|temp|scratch)(?:[-_.].*)?)$/i;
const SCRATCH_NAME = /(?:\.(?:tmp|bak|orig|rej|swp|swo)|~)$|^(?:tmp|scratch)[-_.]/i;
const MAX_LISTED = 20;

const looksLikeScratch = (path) => {
  const segments = path.split('/');
  return segments.slice(0, -1).some((segment) => SCRATCH_DIRECTORY.test(segment)) || SCRATCH_NAME.test(segments.at(-1));
};

/** `{ total, paths }` (at most 20 paths), or undefined when nothing is flagged. */
export function scratchFiles(job) {
  const files = Array.isArray(job?.allFiles) ? job.allFiles : Array.isArray(job?.files) ? job.files : [];
  const flagged = files.filter((file) => file?.status === 'A' && typeof file.path === 'string' && looksLikeScratch(file.path));
  return flagged.length ? { total: flagged.length, paths: flagged.slice(0, MAX_LISTED).map((file) => file.path) } : undefined;
}

export function scratchFilesLine(job, render = String) {
  const found = job?.mode === 'report' ? undefined : scratchFiles(job);
  if (!found) return '';
  const more = found.total - found.paths.length;
  return `possible worker scratch files created by this job (${found.total}): ${found.paths.map(render).join(', ')}${more ? ` (+${more} more)` : ''}; they integrate with the rest of the diff, so check them before offload_apply and delete any that are not deliverables (review evidence, not a verdict)`;
}
