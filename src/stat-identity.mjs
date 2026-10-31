// File identity comparison shared by every module that re-checks a descriptor
// or pathname for replacement between two stats. Leaf module: no imports.

/** Equality that tolerates a BigInt stat compared with a Number stat. */
export function sameStatValue(first, second) {
  if (first === second) return true;
  if (typeof first === 'bigint' && Number.isSafeInteger(second)) return first === BigInt(second);
  if (typeof second === 'bigint' && Number.isSafeInteger(first)) return BigInt(first) === second;
  return false;
}

/** The most precise timestamp a stat carries: BigInt ns, else Number ms, else Date. */
export function statTimestamp(details, name) {
  const nanoseconds = details?.[`${name}Ns`];
  if (typeof nanoseconds === 'bigint') return nanoseconds;
  const milliseconds = details?.[`${name}Ms`];
  if (typeof milliseconds === 'number' && Number.isFinite(milliseconds)) return milliseconds;
  const date = details?.[name];
  return date instanceof Date && Number.isFinite(date.getTime()) ? date.getTime() : undefined;
}

export function sameTimestamp(first, second, name) {
  const left = statTimestamp(first, name),
    right = statTimestamp(second, name);
  return left !== undefined && right !== undefined && sameStatValue(left, right);
}

/** Same named fields plus the same modification and change times. */
export function sameStatFields(first, second, fields) {
  return (
    fields.every((name) => sameStatValue(first?.[name], second?.[name])) &&
    sameTimestamp(first, second, 'mtime') &&
    sameTimestamp(first, second, 'ctime')
  );
}

/** dev and ino only: whether two stats name the same filesystem object. */
export function sameFileIdentity(first, second) {
  return sameStatValue(first?.dev, second?.dev) && sameStatValue(first?.ino, second?.ino);
}

/** Strict BigInt-stat identity: a missing or non-BigInt field never matches. */
export function sameBigintFileStat(first, second) {
  return ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every((key) => typeof first?.[key] === 'bigint' && first[key] === second?.[key]);
}
