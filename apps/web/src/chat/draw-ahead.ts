/**
 * Rows drawn before they come into view.
 *
 * A row off screen is skipped (`content-visibility: auto`) and stands at a 56px placeholder until the browser finds it
 * on screen. WebKitGTK finds it when its last pixels cross the list's top edge, after the frame's resize observers have
 * run: the row grows to its real height (several times that) in the very frame that is painted, every row the person
 * reads goes down with it, and the observer in `ChannelPage` can only move the list back a frame later. Scrolling up
 * through rows never drawn before did that on every one of them.
 *
 * `drawAhead` draws the rows within `margin` of what is on screen (`data-drawn`) from the scroll event of the frame
 * that reached them: they take their real height out of sight, where that observer holds the list in the same frame.
 * Rows beyond twice that margin are let go: a skipped row keeps the height it was last drawn at
 * (`contain-intrinsic-size: auto`), so nothing moves.
 */
export const DRAWN = "data-drawn";

/** `drawn`: the rows this left drawn, kept by the caller between calls. */
export function drawAhead(list: HTMLElement, margin: number, drawn: Set<Element>): void {
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
  // Reads first, writes after: a write makes the next read lay the list out again.
  for (const row of far) {
    row.removeAttribute(DRAWN);
    drawn.delete(row);
  }
  for (const row of near) {
    if (drawn.has(row)) continue;
    row.setAttribute(DRAWN, "");
    drawn.add(row);
  }
}
