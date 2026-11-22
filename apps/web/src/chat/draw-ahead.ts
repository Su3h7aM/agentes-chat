/**
 * Rows drawn before they come into view, with explicit height locking on release.
 *
 * A row off screen is skipped (`content-visibility: auto`) and stands at its intrinsic placeholder until laid out.
 * WebKitGTK finds a skipped row when its pixels cross the list's top edge, after the frame's resize observers have
 * run: if the row was never measured (or lost WebKit's `contain-intrinsic-size: auto` remembered height on release),
 * it grows to its real height in the very frame that paints and pushes the visible conversation down.
 *
 * `drawAhead` draws rows within `margin` of what is on screen (`data-drawn`) and locks each released row's exact
 * content-box height into `contain-intrinsic-block-size` before removing `data-drawn`, so releasing far rows never
 * shrinks `scrollHeight` and re-drawing them later produces zero layout shift.
 */
export const DRAWN = "data-drawn";
const INTRINSIC_PROP = "contain-intrinsic-block-size";

export interface DrawAheadOptions {
  /** Lock each released `.ac-msg` row's real content-box height in `contain-intrinsic-block-size` before dropping `data-drawn`. */
  lockHeights?: boolean;
}

export interface DrawAheadChange {
  added: Element[];
  removed: Element[];
}

export function isRowHeightLocked(row: Element): boolean {
  return row instanceof HTMLElement && row.style.getPropertyValue(INTRINSIC_PROP) !== "";
}

function measureContentHeight(row: HTMLElement): string | null {
  const rect = row.getBoundingClientRect();
  if (!Number.isFinite(rect.height) || rect.height <= 0) return null;
  const cs = typeof getComputedStyle === "function" ? getComputedStyle(row) : null;
  const chrome = cs
    ? (Number.parseFloat(cs.paddingTop) || 0) +
      (Number.parseFloat(cs.paddingBottom) || 0) +
      (Number.parseFloat(cs.borderTopWidth) || 0) +
      (Number.parseFloat(cs.borderBottomWidth) || 0)
    : 0;
  const contentHeight = Math.max(0, Math.round((rect.height - chrome) * 100) / 100);
  return `${contentHeight}px`;
}

/**
 * Records each laid-out `.ac-msg` row's real content-box height into explicit `contain-intrinsic-block-size` in one
 * read-then-write batch. Explicit pixel `contain-intrinsic-block-size` applies only while `content-visibility: auto`
 * skips the row, so visible/drawn rows keep dynamic layout while released offscreen rows never revert to placeholder.
 */
export function lockRowHeights(rows: Iterable<Element>): number {
  const measured: [HTMLElement, string][] = [];
  for (const row of rows) {
    if (!(row instanceof HTMLElement) || !row.isConnected || !row.classList.contains("ac-msg")) continue;
    const value = measureContentHeight(row);
    if (value !== null) measured.push([row, value]);
  }
  for (const [row, value] of measured) {
    if (row.style.getPropertyValue(INTRINSIC_PROP) !== value) {
      row.style.setProperty(INTRINSIC_PROP, value);
    }
  }
  return measured.length;
}

/** Clears locked intrinsic heights on all message rows (called when container width changes and lines re-wrap). */
export function clearLockedRowHeights(list: HTMLElement): void {
  for (const child of list.children) {
    if (child instanceof HTMLElement && child.style.getPropertyValue(INTRINSIC_PROP) !== "") {
      child.style.removeProperty(INTRINSIC_PROP);
    }
  }
}

/**
 * Checks whether every `.ac-msg` row within `minRunway` pixels above the list's top edge is already drawn
 * (`data-drawn`), or whether the top of the list has been reached. Used to defer `drawNear` during an active
 * WebKitGTK smooth-wheel animation while safe drawn runway remains above the reader.
 */
export function hasDrawnRunwayAbove(list: HTMLElement, drawn: ReadonlySet<Element>, minRunway: number): boolean {
  const rows = list.children;
  if (rows.length === 0 || drawn.size === 0) return false;
  const box = list.getBoundingClientRect();
  if (!Number.isFinite(box.height) || box.height <= 0) return false;
  const rectOf = (i: number) => (rows[i] as Element).getBoundingClientRect();
  // Binary search the first row ending below the viewport's top edge.
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (rectOf(middle).bottom > box.top) high = middle;
    else low = middle + 1;
  }
  const limit = box.top - minRunway;
  // Walk upward from the top edge (including the row crossing `box.top` if any) for at most `minRunway` px.
  const start = Math.min(rows.length - 1, low);
  for (let i = start; i >= 0; i--) {
    const row = rows[i] as Element;
    const rect = rectOf(i);
    if (rect.bottom <= limit) return true;
    if (row.classList.contains("ac-msg") && !drawn.has(row) && !row.hasAttribute(DRAWN)) return false;
  }
  return true;
}

/** `drawn`: the rows this left drawn, kept by the caller between calls. */
export function drawAhead(
  list: HTMLElement,
  margin: number,
  drawn: Set<Element>,
  options?: DrawAheadOptions,
): DrawAheadChange {
  const rows = list.children;
  const rectOf = (i: number) => (rows[i] as Element).getBoundingClientRect();
  const box = list.getBoundingClientRect();
  const from = box.top - margin;
  const to = box.bottom + margin;
  // The first row that ends under `from` (rows are laid out in order), then on to the last one that starts above `to`.
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (rectOf(middle).bottom > from) high = middle;
    else low = middle + 1;
  }
  const near: Element[] = [];
  for (let i = low; i < rows.length; i++) {
    if (rectOf(i).top >= to) break;
    near.push(rows[i] as Element);
  }
  const far: Element[] = [];
  for (const row of drawn) {
    if (!row.isConnected) {
      drawn.delete(row);
      continue;
    }
    const rect = row.getBoundingClientRect();
    if (rect.bottom < from - margin || rect.top > to + margin) far.push(row);
  }
  // Reads first, writes after: lock each released row's real content-box height while it is still drawn,
  // before any attribute write invalidates layout.
  const lockedFar: [HTMLElement, string][] = [];
  if (options?.lockHeights && far.length > 0) {
    for (const row of far) {
      if (!(row instanceof HTMLElement) || !row.classList.contains("ac-msg")) continue;
      const value = measureContentHeight(row);
      if (value !== null) lockedFar.push([row, value]);
    }
  }
  for (const [row, value] of lockedFar) {
    if (row.style.getPropertyValue(INTRINSIC_PROP) !== value) {
      row.style.setProperty(INTRINSIC_PROP, value);
    }
  }
  for (const row of far) {
    row.removeAttribute(DRAWN);
    drawn.delete(row);
  }
  const added: Element[] = [];
  for (const row of near) {
    if (drawn.has(row)) continue;
    row.setAttribute(DRAWN, "");
    drawn.add(row);
    added.push(row);
  }
  return { added, removed: far };
}
