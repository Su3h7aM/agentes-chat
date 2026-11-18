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
