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
  /** True when the row expanded from an unmeasured `content-visibility: auto` placeholder rather than an already-drawn row. */
  fromPlaceholder?: boolean;
}

export interface VisibleAnchor {
  row: Element;
  top: number;
}

export interface VisibleAnchorOptions {
  /**
   * When provided, a top-clipped message row (`rect.top < box.top`) for which this returns `true` (e.g. an
   * unmeasured placeholder about to expand) is skipped in favor of the next visible message row starting inside
   * the viewport, falling back to the clipped row only if no other message is visible.
   */
  skipClipped?: (row: Element) => boolean;
}

export interface RestoredAnchor {
  row: Element;
  contentTop: number;
  /** The row's visual top after restore (`anchor.top`, adjusted if the engine flushed a user scroll during the write). */
  top: number;
}

export interface SettleAnchorOptions {
  frame?: (callback: FrameRequestCallback) => number;
}

/** After layout settles: two frames in the same place end the correction. */
const SETTLE_STABLE_FRAMES = 2;
/** A page reveal is short; a reply that keeps moving the end has its own follow logic. */
const SETTLE_MAX_FRAMES = 60;

export function visibleAnchor(list: HTMLElement, options?: VisibleAnchorOptions): VisibleAnchor | null {
  const skipClipped = options?.skipClipped;
  const box = list.getBoundingClientRect();
  const rows = list.children;
  const rects = new Map<number, DOMRect>();
  const rectAt = (index: number) => {
    let rect = rects.get(index);
    if (!rect) {
      const row = rows[index];
      if (!row) throw new Error(`row ${index} is outside the list`);
      rect = row.getBoundingClientRect();
      rects.set(index, rect);
    }
    return rect;
  };
  const probes: { index: number; top: number; bottom: number }[] = [];
  let ordered = true;
  let low = 0;
  let high = rows.length;
  // Rows are laid out in DOM order: binary-search the first one ending below the top edge, then read only the rows
  // in the visible window. A partially mocked or still unlaid list answers `0,0,0,0`, and rows may cross each other
  // when heights change; either breaks the order the search relies on, so the probes below double as a check.
  while (low < high) {
    const middle = (low + high) >> 1;
    const rect = rectAt(middle);
    if (!placed(rect)) {
      ordered = false;
      break;
    }
    probes.push({ index: middle, top: rect.top, bottom: rect.bottom });
    if (rect.bottom > box.top) high = middle;
    else low = middle + 1;
  }
  // A handful of evenly spaced rows certifies that the binary search saw the list's real order, not a shuffled or
  // partly laid out one. The binary-search probes alone can step over a single inversion.
  if (ordered && rows.length > 1) {
    const step = Math.max(1, Math.floor(rows.length / 12));
    for (let i = 0; i < rows.length; i += step) {
      const rect = rectAt(i);
      if (!placed(rect)) {
        ordered = false;
        break;
      }
      probes.push({ index: i, top: rect.top, bottom: rect.bottom });
    }
    if (ordered) {
      const last = rectAt(rows.length - 1);
      if (!placed(last)) ordered = false;
      else probes.push({ index: rows.length - 1, top: last.top, bottom: last.bottom });
    }
  }
  if (ordered) {
    probes.sort((a, b) => a.index - b.index);
    for (let i = 1; i < probes.length; i++) {
      const previous = probes[i - 1];
      const current = probes[i];
      if (previous && current && (current.top < previous.top || current.bottom < previous.bottom)) {
        ordered = false;
        break;
      }
    }
  }
  if (ordered && low > 0) {
    const before = rectAt(low - 1);
    const after = low < rows.length ? rectAt(low) : null;
    if (
      !placed(before) ||
      before.bottom > box.top ||
      (after !== null && (!placed(after) || before.top > after.top || before.bottom > after.bottom))
    ) {
      ordered = false;
    }
  }

  const found = visibleFrom(rows, box, ordered ? low : 0, ordered, skipClipped);
  if (!found) return null;
  if (ordered && found.index > 0) {
    const before = rows[found.index - 1];
    if (!before) return found.anchor;
    const rect = before.getBoundingClientRect();
    // A message above the one the search found is visible too: the search read a gap, not the front of the window.
    const skipped = rect.top < box.top && Boolean(skipClipped?.(before));
    if (before.classList.contains("ac-msg") && visible(rect, box) && !skipped)
      return visibleFrom(rows, box, 0, false, skipClipped)?.anchor ?? null;
  }
  return found.anchor;
}

/** A rect the list is still laying out, or jsdom never placed, cannot order the rows. */
function placed(rect: DOMRect): boolean {
  return (
    Number.isFinite(rect.top) &&
    Number.isFinite(rect.bottom) &&
    rect.bottom >= rect.top &&
    !(rect.top === 0 && rect.bottom === 0 && !rect.width && !rect.height)
  );
}

/** The equality edges: a row ending exactly at the top edge, or starting at the bottom edge, is not visible. */
function visible(rect: DOMRect, box: DOMRect): boolean {
  return rect.bottom > box.top && rect.top < box.bottom;
}

function visibleFrom(
  rows: HTMLCollection,
  box: DOMRect,
  from: number,
  ordered: boolean,
  skipClipped?: (row: Element) => boolean,
): { anchor: VisibleAnchor; index: number } | null {
  let first: VisibleAnchor | null = null;
  let firstIndex = -1;
  let clippedMsg: { anchor: VisibleAnchor; index: number } | null = null;
  for (let i = from; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    if (row.classList.contains("channel__spacer")) continue;
    const rect = row.getBoundingClientRect();
    if (!visible(rect, box)) {
      if (ordered && rect.top >= box.bottom) break;
      continue;
    }
    const anchor = { row, top: rect.top - box.top };
    if (row.classList.contains("ac-msg")) {
      if (rect.top < box.top && skipClipped?.(row)) {
        clippedMsg ??= { anchor, index: i };
        continue;
      }
      return { anchor, index: i };
    }
    if (!first) {
      first = anchor;
      firstIndex = i;
    }
  }
  return clippedMsg ?? (first ? { anchor: first, index: firstIndex } : null);
}

/**
 * Shifts `list.scrollTop` by `delta` pixels immediately.
 *
 * WebKit2GTK's composited scrolling thread can flush an in-flight wheel update during the first
 * `scrollTop` write and discard the programmatic target, leaving the list displaced by `delta` for
 * one frame until a later frame snaps it back. Checking immediately after the write detects that
 * flush; applying `delta` on top of the flushed position preserves both the reader's wheel scroll
 * and content anchoring in the same frame before paint.
 *
 * Returns the compositor scroll delta flushed during the write (`0` in the normal case).
 */
export function shiftScrollTop(list: HTMLElement, delta: number): number {
  if (Math.abs(delta) < 0.5) return 0;
  const before = list.scrollTop;
  const target = Math.max(0, Math.round(before + delta));
  if (Math.abs(target - before) < 0.5) return 0;
  list.scrollTop = target;
  const after = list.scrollTop;
  const maxScroll = Math.max(0, list.scrollHeight - list.clientHeight);
  const clamped = Number.isFinite(maxScroll) && maxScroll > 0 ? Math.min(target, maxScroll) : target;
  if (Math.abs(after - target) > 1 && Math.abs(after - clamped) > 1) {
    list.scrollTop = Math.max(0, Math.round(after + delta));
    return after - before;
  }
  return 0;
}

export function restoreAnchorPosition(list: HTMLElement, anchor: VisibleAnchor): RestoredAnchor | null {
  if (!list.contains(anchor.row)) return null;
  const top = anchor.row.getBoundingClientRect().top - list.getBoundingClientRect().top;
  const scrollTop = list.scrollTop;
  const flushed = shiftScrollTop(list, top - anchor.top);
  return { row: anchor.row, contentTop: top + scrollTop, top: anchor.top - flushed };
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
  let expectedScrollTop = list.scrollTop;
  let expectedContentTop = anchor.top + expectedScrollTop;
  const stop = () => {
    stopped = true;
  };
  const reconcile = () => {
    if (stopped || !list.contains(anchor.row)) return;
    if (++frames > SETTLE_MAX_FRAMES) return;
    const scrollTop = list.scrollTop;
    const top = anchor.row.getBoundingClientRect().top - list.getBoundingClientRect().top;
    const contentTop = top + scrollTop;
    if (Math.abs(top - anchor.top) <= 1) {
      expectedScrollTop = scrollTop;
      expectedContentTop = contentTop;
      stable += 1;
      if (stable >= SETTLE_STABLE_FRAMES) return;
    } else if (Math.abs(scrollTop - expectedScrollTop) > 1) {
      // The scroll position moved without our write (compositor smooth-wheel or momentum):
      // never yank the person back; only compensate if layout itself shifted in the same frame.
      const layoutShift = contentTop - expectedContentTop;
      if (Math.abs(layoutShift) > 1) write(Math.max(0, Math.round(scrollTop + layoutShift)));
      return;
    } else {
      stable = 0;
      const target = Math.max(0, Math.round(scrollTop + top - anchor.top));
      write(target);
      expectedScrollTop = list.scrollTop;
      expectedContentTop = contentTop;
      if (Math.abs(expectedScrollTop - target) > 1) return;
    }
    frame(reconcile);
  };
  frame(reconcile);
  return stop;
}

/**
 * How far to scroll so what is on screen stays where it was: the growth of every row that ended above the list's
 * top edge before it changed, plus any unmeasured placeholder row (`fromPlaceholder`) that started above the top
 * edge or crossed into the top of the viewport during an upward scroll (`anchorEdge`). An already-drawn row crossing
 * that edge, or any row below it, is what the person looks at: it grows in place.
 * `rows` in any order, each `top` as laid out after all of them changed.
 */
export function anchorShift(rows: readonly RowResize[], scrollTop: number, anchorEdge = scrollTop): number {
  let shift = 0;
  const cutoff = Math.max(scrollTop, anchorEdge);
  for (const row of [...rows].sort((a, b) => a.top - b.top)) {
    // Where it started and ended before any of this: its top now, less what the rows above it grew by.
    const startedAt = row.top - shift;
    const endedAt = startedAt + row.before;
    if (endedAt <= scrollTop || (row.fromPlaceholder && (startedAt < scrollTop || endedAt <= cutoff))) {
      shift += row.after - row.before;
    }
  }
  return shift;
}

/** The browser keeps the list's place itself (scroll anchoring). */
export const anchorsScroll = () =>
  typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("overflow-anchor", "auto");

/** Where `row` stands in `list`'s content (0 = its top): what scrolling never changes. */
export const topInList = (list: HTMLElement, row: HTMLElement) =>
  row.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop;
