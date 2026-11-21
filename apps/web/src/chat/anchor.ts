/**
 * The list holds its place where the browser doesn't.
 *
 * Rows off screen are drawn late (`content-visibility: auto`), so one above what the person reads can change height
 * after they scrolled past where it will be. Browsers with scroll anchoring move the list by as much, so nothing on
 * screen shifts. Where native anchoring is unavailable or unreliable, `anchorShift` moves the list, and the rows about to
 * come into view are drawn ahead (`draw-ahead.ts`): one skipped at its placeholder grows only after the frame's observers
 * ran, too late for `anchorShift` to hold that frame.
 */

/** A row whose height changed: its top now, in the list's content (0 = the content's top), and its height before and now. */
export interface RowResize {
  top: number;
  before: number;
  after: number;
}

export interface VisibleAnchor {
  row: Element;
  top: number;
}

export interface RestoredAnchor {
  row: Element;
  contentTop: number;
}

export interface SettleAnchorOptions {
  frame?: (callback: FrameRequestCallback) => number;
}

/** After layout settles: two frames in the same place end the correction. */
const SETTLE_STABLE_FRAMES = 2;
/** A page reveal is short; a reply that keeps moving the end has its own follow logic. */
const SETTLE_MAX_FRAMES = 60;

export function visibleAnchor(list: HTMLElement): VisibleAnchor | null {
  const box = list.getBoundingClientRect();
  let first: VisibleAnchor | null = null;
  for (const row of list.children) {
    if (row.classList.contains("channel__spacer")) continue;
    const rect = row.getBoundingClientRect();
    if (rect.bottom <= box.top || rect.top >= box.bottom) continue;
    const anchor = { row, top: rect.top - box.top };
    if (row.classList.contains("ac-msg")) return anchor;
    first ??= anchor;
  }
  return first;
}

export function restoreAnchorPosition(list: HTMLElement, anchor: VisibleAnchor): RestoredAnchor | null {
  if (!list.contains(anchor.row)) return null;
  const top = anchor.row.getBoundingClientRect().top - list.getBoundingClientRect().top;
  const scrollTop = list.scrollTop;
  if (top !== anchor.top) list.scrollTop = scrollTop + top - anchor.top;
  return { row: anchor.row, contentTop: top + scrollTop };
}

/**
 * Keeps a visible row where it was after layout moves the list under it. Runs for at most 60 frames, ends once
 * the row holds for two frames, and stops at once when the caller says the person took over.
 */
export function settleAnchor(
  list: HTMLElement,
  anchor: VisibleAnchor,
  write: (top: number) => void,
  { frame = requestAnimationFrame }: SettleAnchorOptions = {},
): () => void {
  let stopped = false;
  let stable = 0;
  let frames = 0;
  const stop = () => {
    stopped = true;
  };
  const reconcile = () => {
    if (stopped || !list.contains(anchor.row)) return;
    if (++frames > SETTLE_MAX_FRAMES) return;
    const top = anchor.row.getBoundingClientRect().top - list.getBoundingClientRect().top;
    if (Math.abs(top - anchor.top) <= 1) {
      stable += 1;
      if (stable >= SETTLE_STABLE_FRAMES) return;
    } else {
      stable = 0;
      write(list.scrollTop + top - anchor.top);
    }
    frame(reconcile);
  };
  frame(reconcile);
  return stop;
}

/**
 * How far to scroll so what is on screen stays where it was: the growth of every row that ended above the list's
 * top edge before it changed. A row crossing that edge, or below it, is what the person looks at: it grows in place.
 * `rows` in any order, each `top` as laid out after all of them changed.
 */
export function anchorShift(rows: readonly RowResize[], scrollTop: number): number {
  let shift = 0;
  for (const row of [...rows].sort((a, b) => a.top - b.top)) {
    // Where it ended before any of this: its top now, less what the rows above it grew by.
    const endedAt = row.top - shift + row.before;
    if (endedAt <= scrollTop) shift += row.after - row.before;
  }
  return shift;
}

/** The browser keeps the list's place itself (scroll anchoring). */
export const anchorsScroll = () =>
  typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("overflow-anchor", "auto");

/** Where `row` stands in `list`'s content (0 = its top): what scrolling never changes. */
export const topInList = (list: HTMLElement, row: HTMLElement) =>
  row.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop;
