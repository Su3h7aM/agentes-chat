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

/** A fetched older page waits for this long without the person moving the list. */
export const OLDER_ADMISSION_QUIET_MS = 120;
/** The page commits once this many consecutive frames hold the same position. */
export const OLDER_ADMISSION_STABLE_FRAMES = 2;
/** Scroll positions must hold within this much on two consecutive frames. */
export const OLDER_ADMISSION_MAX_DRIFT = 0.5;
/** Continuous motion still gets the page in after this long. */
export const OLDER_ADMISSION_FORCE_MS = 1500;

export interface OlderAdmission {
  /** When the fetched page first waited to be shown. */
  startedAt: number;
  /** The last user motion on the list. */
  quietAt: number;
  lastTop: number | null;
  stableFrames: number;
}

/** Starts waiting for a quiet list and two stable scroll positions. */
export function beginOlderAdmission(now: number, top: number): OlderAdmission {
  return { startedAt: now, quietAt: now, lastTop: top, stableFrames: 0 };
}

/** A wheel, touch, key or scrollbar motion: admission starts its quiet period again. */
export function noteOlderMotion(admission: OlderAdmission, now: number): void {
  admission.quietAt = now;
  admission.lastTop = null;
  admission.stableFrames = 0;
}

/**
 * Records one rendered frame. The page may be committed after the quiet period and two consecutive frames whose
 * scrollTop drifts by at most half a pixel. A bounded wait keeps a continuous gesture from holding it forever.
 */
export function advanceOlderAdmission(admission: OlderAdmission, now: number, top: number): "waiting" | "admit" {
  if (now - admission.startedAt >= OLDER_ADMISSION_FORCE_MS) return "admit";
  if (now - admission.quietAt < OLDER_ADMISSION_QUIET_MS) {
    admission.lastTop = top;
    admission.stableFrames = 0;
    return "waiting";
  }
  if (admission.lastTop !== null && Math.abs(top - admission.lastTop) <= OLDER_ADMISSION_MAX_DRIFT) {
    admission.stableFrames += 1;
  } else {
    admission.stableFrames = 0;
  }
  admission.lastTop = top;
  return admission.stableFrames >= OLDER_ADMISSION_STABLE_FRAMES ? "admit" : "waiting";
}
