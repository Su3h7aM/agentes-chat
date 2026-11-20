import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { cleanup } from "@testing-library/react";
import { DRAWN, drawAhead } from "@/chat/draw-ahead";

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
    drawAhead(el, 300, drawn);
    scroll.top = 4960;
    drawAhead(el, 300, drawn);
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
    drawAhead(el, 300, drawn);
    // 47 to 57 ended more than a margin beyond the drawn band: let go; what the new band covers is drawn.
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
});
