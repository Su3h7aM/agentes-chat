/**
 * The older messages a channel keeps loaded: at most this many, the ones nearest the present. Scrolling up loads
 * a page at a time, and every row stays mounted with its author, face and cards; a long read can pile thousands.
 * The caller releases the far ones only once the person is back at the bottom, so nothing they are reading moves.
 */
export const RETAINED_OLDER_MAX = 200;

/** The newest `max` of `messages`, or null while all of them fit (nothing to release). */
export function retainedOlderTail<T>(messages: readonly T[], max = RETAINED_OLDER_MAX): T[] | null {
  return messages.length <= max ? null : messages.slice(messages.length - max);
}

/**
 * Maximum older rows joined in one commit where manual anchoring draws them at real height.
 * Keeping each commit to ~13 rows (~1,500px, >2 screens above the reader) breaks a 50-row
 * mount/layout/paint/release spike into short slices with painted wheel frames in between,
 * while keeping the rendered timeline contiguous on every frame.
 */
export const OLDER_JOIN_CHUNK = 13;

/**
 * Splits a chronological older page (`oldest..newest`) into contiguous join slices ordered
 * newest-slice-first so each slice prepends directly above the rows already in the list.
 */
export function olderJoinChunks<T>(page: readonly T[], size = OLDER_JOIN_CHUNK): T[][] {
  if (page.length === 0) return [];
  if (size <= 0 || page.length <= size) return [[...page]];
  const chunks: T[][] = [];
  for (let end = page.length; end > 0; end -= size) {
    chunks.push(page.slice(Math.max(0, end - size), end));
  }
  return chunks;
}
