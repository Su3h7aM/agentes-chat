import { describe, expect, test } from "bun:test";
import { anchorShift, settleAnchor, topInList } from "@/chat/anchor";

describe("the list holds its place without scroll anchoring", () => {
  test("a row above the top edge that grows from its placeholder moves the list by as much", () => {
    // Ended at 400 + 56 = 456, above scrollTop 1000: drawn at 320, everything under it went down 264.
    expect(anchorShift([{ top: 400, before: 56, after: 320 }], 1000)).toBe(264);
  });

  test("a row that shrinks above the edge pulls the list back", () => {
    expect(anchorShift([{ top: 400, before: 320, after: 56 }], 1000)).toBe(-264);
  });

  test("a row crossing the top edge, or under it, grows in place", () => {
    expect(anchorShift([{ top: 980, before: 56, after: 320 }], 1000)).toBe(0);
    expect(anchorShift([{ top: 1200, before: 56, after: 320 }], 1000)).toBe(0);
  });

  test("a row ending exactly at the edge counts as above it", () => {
    expect(anchorShift([{ top: 944, before: 56, after: 100 }], 1000)).toBe(44);
  });

  test("several at once, in any order: each is placed where it was before the rows above it grew", () => {
    // Before: A at 100 (56 tall), B at 900 (56 tall, ending at 956). A grew by 200, so B now sits at 1100.
    const rows = [
      { top: 1100, before: 56, after: 156 },
      { top: 100, before: 56, after: 256 },
    ];
    expect(anchorShift(rows, 1000)).toBe(300);
    // A third one that was under the edge stays out of it, even though it now reads as further down.
    expect(anchorShift([...rows, { top: 1400, before: 56, after: 500 }], 1000)).toBe(300);
  });

  test("nothing changed, nothing moves", () => {
    expect(anchorShift([], 1000)).toBe(0);
    expect(anchorShift([{ top: 10, before: 80, after: 80 }], 1000)).toBe(0);
  });
});
describe("where a row stands in its list", () => {
  test("its place in the content, whatever the list is scrolled to", () => {
    const box = (top: number) => ({ getBoundingClientRect: () => ({ top }) }) as unknown as HTMLElement;
    const list = Object.assign(box(100), { scrollTop: 900 });
    // On screen 40 px under the list's top edge, scrolled 900 down: 940 into its content.
    expect(topInList(list, box(140))).toBe(940);
  });

  test("a late layout shift after the gesture corrects to the row's last seen top", () => {
    let contentTop = 520; // The row sat 20 under the list's top after the gesture.
    const list = {
      scrollTop: 500,
      contains: () => true,
      getBoundingClientRect: () => ({ top: 0 }),
    } as unknown as HTMLElement;
    const row = {
      getBoundingClientRect: () => ({ top: contentTop - list.scrollTop }),
    } as unknown as Element;
    const frames = frameQueue();
    settleAnchor(list, { row, top: 20 }, (top) => (list.scrollTop = top), { frame: frames.frame });
    // Draw-ahead grows a row above it during the quiet gap: the person still expects it 20 under the edge.
    contentTop += 211;
    frames.run();
    expect(list.scrollTop).toBe(711);
    expect(row.getBoundingClientRect().top - (list.getBoundingClientRect() as DOMRect).top).toBe(20);
    frames.run();
    frames.run();
    expect(frames.pending()).toBe(0);
  });
});

