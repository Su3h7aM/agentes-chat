import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { cleanup } from "@testing-library/react";
import {
  clearLockedRowHeights,
  DRAWN,
  drawAhead,
  hasDrawnRunwayAbove,
  isRowHeightLocked,
  lockRowHeights,
} from "@/chat/draw-ahead";

afterEach(() => cleanup());

/** A list of rows `height` tall, the top of the list at 0, scrolled to `scroll`: happy-dom has no layout. */
const list = (count: number, height: number, view: number) => {
  const el = document.createElement("section");
  const rows = Array.from({ length: count }, (_, i) => {
    const row = document.createElement("article");
    row.getBoundingClientRect = () =>
      ({ top: i * height - scroll.top, bottom: (i + 1) * height - scroll.top, height }) as DOMRect;
    el.append(row);
    return row;
  });
  const scroll = { top: 0 };
  el.getBoundingClientRect = () => ({ top: 0, bottom: view, height: view }) as DOMRect;
  document.body.append(el);
  return { el, rows, scroll };
};

const drawnRows = (rows: Element[]) => rows.flatMap((row, i) => (row.hasAttribute(DRAWN) ? [i] : []));

describe("rows are drawn before they come into view", () => {
  test("the rows on screen and within the margin above and under them are drawn, the rest are not", () => {
    const { el, rows, scroll } = list(100, 100, 500);
    scroll.top = 5000; // rows 50 to 54 on screen
    drawAhead(el, 300, new Set());
    expect(drawnRows(rows)).toEqual([47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57]);
    el.remove();
  });

  test("scrolling up draws the rows that come next before they reach the edge", () => {
    const { el, rows, scroll } = list(100, 100, 500);
    const drawn = new Set<Element>();
    scroll.top = 5000;
    const initial = drawAhead(el, 300, drawn);
    expect(initial.added).toHaveLength(11);
    expect(initial.removed).toHaveLength(0);
    scroll.top = 4960;
    const next = drawAhead(el, 300, drawn);
    expect(next.added).toEqual([rows[46] as Element]);
    expect(next.removed).toEqual([]);
    expect(rows[46]?.hasAttribute(DRAWN)).toBe(true);
    // A row that stood in the margin before stays drawn: nothing it was drawn at changes.
    expect(rows[47]?.hasAttribute(DRAWN)).toBe(true);
    el.remove();
  });

  test("rows far from the screen are let go, and only those", () => {
    const { el, rows, scroll } = list(100, 100, 500);
    const drawn = new Set<Element>();
    scroll.top = 5000;
    drawAhead(el, 300, drawn);
    scroll.top = 7000; // rows 70 to 74 on screen
    const moved = drawAhead(el, 300, drawn);
    // 47 to 57 ended more than a margin beyond the drawn band: let go; what the new band covers is drawn.
    expect(moved.removed).toHaveLength(11);
    expect(moved.added).toHaveLength(11);
    expect(drawnRows(rows)).toEqual([67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77]);
    expect([...drawn]).toHaveLength(11);
    el.remove();
  });

  test("a row that left the page is forgotten", () => {
    const { el, rows, scroll } = list(20, 100, 500);
    const drawn = new Set<Element>();
    drawAhead(el, 300, drawn);
    const gone = rows[0] as Element;
    gone.remove();
    scroll.top = 0;
    drawAhead(el, 300, drawn);
    expect(drawn.has(gone)).toBe(false);
    el.remove();
  });

  test("an empty list draws nothing", () => {
    const { el } = list(0, 100, 500);
    drawAhead(el, 300, new Set());
    expect(el.querySelector(`[${DRAWN}]`)).toBeNull();
    el.remove();
  });

  test("lockRowHeights locks content-box height before release and clearLockedRowHeights resets it", () => {
    const { el, rows, scroll } = list(40, 100, 500);
    for (const row of rows) {
      row.classList.add("ac-msg");
      (row as HTMLElement).style.paddingTop = "4px";
      (row as HTMLElement).style.paddingBottom = "4px";
    }
    const drawn = new Set<Element>();
    scroll.top = 1500;
    drawAhead(el, 300, drawn, { lockHeights: true });
    expect(isRowHeightLocked(rows[12] as Element)).toBe(false);

    // Move far enough that rows 12..22 are released: each released row locks its content-box height (100 - 8 = 92px).
    scroll.top = 3200;
    const moved = drawAhead(el, 300, drawn, { lockHeights: true });
    expect(moved.removed.length).toBeGreaterThan(0);
    for (const row of moved.removed) {
      expect(row.hasAttribute(DRAWN)).toBe(false);
      expect(isRowHeightLocked(row)).toBe(true);
      expect((row as HTMLElement).style.getPropertyValue("contain-intrinsic-block-size")).toBe("92px");
    }

    clearLockedRowHeights(el);
    for (const row of moved.removed) expect(isRowHeightLocked(row)).toBe(false);
    // Standalone lockRowHeights locks arbitrary laid-out message rows.
    expect(lockRowHeights([rows[0] as Element, rows[1] as Element])).toBe(2);
    expect(isRowHeightLocked(rows[0] as Element)).toBe(true);
    el.remove();
  });

  test("hasDrawnRunwayAbove verifies contiguous drawn rows above the viewport", () => {
    const { el, rows, scroll } = list(40, 100, 500);
    for (const row of rows) row.classList.add("ac-msg");
    const drawn = new Set<Element>();
    scroll.top = 2000;
    expect(hasDrawnRunwayAbove(el, drawn, 300)).toBe(false);
    drawAhead(el, 500, drawn);
    expect(hasDrawnRunwayAbove(el, drawn, 300)).toBe(true);
    // Scrolling 300px up leaves only 200px of drawn runway above the top edge (< 300px).
    scroll.top = 1700;
    expect(hasDrawnRunwayAbove(el, drawn, 300)).toBe(false);
    // Reaching the top of the list counts as full runway (no undrawn rows remain above).
    scroll.top = 100;
    drawAhead(el, 500, drawn);
    expect(hasDrawnRunwayAbove(el, drawn, 800)).toBe(true);
    el.remove();
  });
});
