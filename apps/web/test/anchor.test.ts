import { describe, expect, test } from "bun:test";
import {
  anchorShift,
  restoreAnchorPosition,
  settleAnchor,
  shiftScrollTop,
  topInList,
  visibleAnchor,
} from "@/chat/anchor";

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

  test("an unmeasured placeholder straddling or crossing the top edge on scroll-up is compensated", () => {
    // A 56px placeholder straddling scrollTop (980..1036 across 1000) expands to 320px.
    expect(anchorShift([{ top: 980, before: 56, after: 320, fromPlaceholder: true }], 1000)).toBe(264);
    // A 93px upward step (1000 -> 907) brings a 56px placeholder [940, 996] inside the top edge; anchorEdge=1000 holds
    // the visible conversation below it at +93px instead of jumping +292px.
    expect(anchorShift([{ top: 940, before: 56, after: 255, fromPlaceholder: true }], 907, 1000)).toBe(199);
    // Multiple placeholders expanding in one batch accumulate accurately.
    expect(
      anchorShift(
        [
          { top: 1140, before: 56, after: 255, fromPlaceholder: true },
          { top: 884, before: 56, after: 256, fromPlaceholder: true },
        ],
        907,
        1000,
      ),
    ).toBe(399);
    // Scrolling down into a placeholder at the bottom edge (1650..1706) never shifts scrollTop.
    expect(anchorShift([{ top: 1650, before: 56, after: 255, fromPlaceholder: true }], 1093, 1000)).toBe(0);
    // An already-drawn row straddling the top edge (e.g. clicking "Ver mais") still grows downward in place.
    expect(anchorShift([{ top: 980, before: 480, after: 1200, fromPlaceholder: false }], 1000)).toBe(0);
  });
});

describe("where a row stands in its list", () => {
  test("its place in the content, whatever the list is scrolled to", () => {
    const box = (top: number) => ({ getBoundingClientRect: () => ({ top }) }) as unknown as HTMLElement;
    const list = Object.assign(box(100), { scrollTop: 900 });
    // On screen 40 px under the list's top edge, scrolled 900 down: 940 into its content.
    expect(topInList(list, box(140))).toBe(940);
  });
});

describe("a visible row settles after layout moves it", () => {
  const frameQueue = () => {
    const pending: FrameRequestCallback[] = [];
    return {
      frame: (callback: FrameRequestCallback) => pending.push(callback),
      run() {
        const callback = pending.shift();
        callback?.(0);
      },
      pending: () => pending.length,
    };
  };

  test("a late disturbance is corrected until the row holds for two frames", () => {
    let contentTop = 520;
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

    // The row's content moved after the restore: the list no longer shows it where it was.
    contentTop += 35;
    frames.run();
    expect(list.scrollTop).toBe(535);
    expect(frames.pending()).toBe(1);
    // Two frames in the same place end the correction.
    frames.run();
    frames.run();
    expect(frames.pending()).toBe(0);
  });

  test("the person's input cancelling it leaves their scroll where they put it", () => {
    let contentTop = 520;
    const list = {
      scrollTop: 500,
      contains: () => true,
      getBoundingClientRect: () => ({ top: 0 }),
    } as unknown as HTMLElement;
    const row = {
      getBoundingClientRect: () => ({ top: contentTop - list.scrollTop }),
    } as unknown as Element;
    const frames = frameQueue();
    // Wheel, touch, key, and pointer handlers call this stop before the person's scroll arrives.
    const stop = settleAnchor(list, { row, top: 20 }, (top) => (list.scrollTop = top), { frame: frames.frame });
    frames.run();
    expect(frames.pending()).toBe(1);
    stop();

    contentTop += 35;
    list.scrollTop = 560;
    frames.run();
    expect(list.scrollTop).toBe(560);
    expect(frames.pending()).toBe(0);
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

  test("compositor smooth-scrolling without layout change stops settling instead of pulling the reader back", () => {
    const contentTop = 3198;
    const list = {
      scrollTop: 3148,
      contains: () => true,
      getBoundingClientRect: () => ({ top: 0 }),
    } as unknown as HTMLElement;
    const row = {
      getBoundingClientRect: () => ({ top: contentTop - list.scrollTop }),
    } as unknown as Element;
    const frames = frameQueue();
    let writes = 0;
    settleAnchor(
      list,
      { row, top: 50 },
      (top) => {
        writes += 1;
        list.scrollTop = top;
      },
      { frame: frames.frame },
    );

    // Compositor wheel momentum moves scrollTop up without a new DOM wheel event; layout did not move.
    list.scrollTop = 2971;
    frames.run();
    expect(writes).toBe(0);
    expect(list.scrollTop).toBe(2971);
    expect(frames.pending()).toBe(0);
  });

  test("if both compositor scroll and layout shift occur in the same frame, only the layout shift is compensated", () => {
    let contentTop = 3198;
    const list = {
      scrollTop: 3148,
      contains: () => true,
      getBoundingClientRect: () => ({ top: 0 }),
    } as unknown as HTMLElement;
    const row = {
      getBoundingClientRect: () => ({ top: contentTop - list.scrollTop }),
    } as unknown as Element;
    const frames = frameQueue();
    settleAnchor(list, { row, top: 50 }, (top) => (list.scrollTop = top), { frame: frames.frame });

    // Reader wheeled up 177px AND layout above grew 35px in the same frame.
    list.scrollTop = 2971;
    contentTop += 35;
    frames.run();
    expect(list.scrollTop).toBe(3006);
    expect(frames.pending()).toBe(0);
  });
});

describe("shiftScrollTop and restoreAnchorPosition handle rounding and compositor flushes", () => {
  test("rounds fractional targets instead of truncating downward across successive slices", () => {
    let st = 1000;
    const list = {
      scrollHeight: 10000,
      clientHeight: 500,
      get scrollTop() {
        return st;
      },
      set scrollTop(v: number) {
        st = Math.trunc(v);
      },
      contains: () => true,
      getBoundingClientRect: () => ({ top: 0 }),
    } as unknown as HTMLElement;
    const row = {
      getBoundingClientRect: () => ({ top: 50 + 1316.7 }),
    } as unknown as Element;
    const restored = restoreAnchorPosition(list, { row, top: 50 });
    expect(st).toBe(2317);
    expect(restored?.top).toBe(50);
  });

  test("recovers synchronously when WebKitGTK flushes an in-flight compositor scroll on the first write", () => {
    let st = 1407;
    let firstWrite = true;
    const list = {
      scrollHeight: 20000,
      clientHeight: 500,
      get scrollTop() {
        return st;
      },
      set scrollTop(v: number) {
        if (firstWrite) {
          // Engine flushes a pending -364px compositor wheel scroll and discards `v`.
          firstWrite = false;
          st = 1043;
        } else {
          st = Math.max(0, Math.min(Math.trunc(v), 19500));
        }
      },
      contains: () => true,
      getBoundingClientRect: () => ({ top: 0 }),
    } as unknown as HTMLElement;
    const row = {
      // Content grew +1509.2px above anchor.row (was at 50, now at 1559.2 while st is 1407).
      getBoundingClientRect: () => ({ top: 1559.2 }),
    } as unknown as Element;
    const restored = restoreAnchorPosition(list, { row, top: 50 });
    // Preserves the reader's -364px wheel motion AND compensates the +1509.2px growth synchronously.
    expect(st).toBe(2552);
    expect(restored?.contentTop).toBeCloseTo(2966.2, 1);
    expect(restored?.top).toBe(414);
  });

  test("does not retry when scrollTop lands at target (unclamped mock) or clamps at maxScroll", () => {
    let writes = 0;
    let st = 1000;
    const unclamped = {
      scrollHeight: 2000,
      clientHeight: 500,
      get scrollTop() {
        return st;
      },
      set scrollTop(v: number) {
        writes += 1;
        st = v;
      },
    } as unknown as HTMLElement;
    expect(shiftScrollTop(unclamped, 1000)).toBe(0);
    expect(st).toBe(2000);
    expect(writes).toBe(1);

    writes = 0;
    st = 1000;
    const clamped = {
      scrollHeight: 2000,
      clientHeight: 500,
      get scrollTop() {
        return st;
      },
      set scrollTop(v: number) {
        writes += 1;
        st = Math.min(v, 1500);
      },
    } as unknown as HTMLElement;
    expect(shiftScrollTop(clamped, 1000)).toBe(0);
    expect(st).toBe(1500);
    expect(writes).toBe(1);
  });

  test("ignores sub-pixel deltas even when scrollTop is fractional mid-smooth-wheel animation", () => {
    let writes = 0;
    let st = 7541.33;
    const list = {
      scrollHeight: 20000,
      clientHeight: 600,
      get scrollTop() {
        return st;
      },
      set scrollTop(v: number) {
        writes += 1;
        st = v;
      },
    } as unknown as HTMLElement;
    expect(shiftScrollTop(list, 0.2)).toBe(0);
    expect(shiftScrollTop(list, -0.4)).toBe(0);
    expect(writes).toBe(0);
    expect(st).toBe(7541.33);
  });
});

describe("the visible row is found without reading every row", () => {
  const row = (top: number, height = 60, classes: string[] = ["ac-msg"]) => {
    let reads = 0;
    return {
      reads: () => reads,
      element: {
        classList: { contains: (name: string) => classes.includes(name) },
        getBoundingClientRect: () => {
          reads += 1;
          return { top, bottom: top + height };
        },
      } as unknown as Element,
    };
  };
  const list = (tops: { top: number; height?: number; classes?: string[] }[], box = { top: 100, bottom: 500 }) => {
    const rows = tops.map((spec) => row(spec.top, spec.height ?? 60, spec.classes));
    return {
      rows,
      element: {
        getBoundingClientRect: () => box,
        children: rows.map((entry) => entry.element),
      } as unknown as HTMLElement,
    };
  };

  test("the first visible message wins, rows above and spacers are skipped", () => {
    const view = list([
      { top: -100 },
      { top: 0, classes: ["channel__spacer"] },
      { top: 40 },
      { top: 120 },
      { top: 200 },
    ]);
    const anchor = visibleAnchor(view.element);
    expect(anchor?.row).toBe(view.rows[3]?.element);
    expect(anchor?.top).toBe(20);
  });

  test("edges: ending exactly at the top edge, or starting at the bottom edge, is not visible", () => {
    const view = list([{ top: 40 }, { top: 500 }]);
    expect(visibleAnchor(view.element)).toBeNull();
  });

  test("a row crossing the top edge is visible, and a later message beats an earlier plain row", () => {
    const view = list([{ top: 80, classes: ["channel__date"] }, { top: 140 }]);
    const anchor = visibleAnchor(view.element);
    expect(anchor?.row).toBe(view.rows[1]?.element);
    expect(anchor?.top).toBe(40);
  });

  test("with no message visible the first plain row holds the place", () => {
    const view = list([{ top: 120, classes: ["channel__date"] }]);
    expect(visibleAnchor(view.element)?.row).toBe(view.rows[0]?.element);
  });

  test("nothing visible, or nothing at all, is null", () => {
    expect(visibleAnchor(list([{ top: 600 }]).element)).toBeNull();
    expect(visibleAnchor(list([]).element)).toBeNull();
  });

  test("a long list reads the search path and the window, not every row", () => {
    const specs = Array.from({ length: 600 }, (_, index) => ({ top: index * 60 }));
    const view = list(specs);
    const anchor = visibleAnchor(view.element);
    expect(anchor?.row).toBe(view.rows[1]?.element);
    const reads = view.rows.reduce((total, entry) => total + entry.reads(), 0);
    expect(reads).toBeLessThan(40);
  });

  test("a partially laid out list reads every row in order", () => {
    const specs: Spec[] = Array.from({ length: 600 }, () => ({ top: 0, height: 0, classes: ["ac-msg"], laid: false }));
    specs[451] = { top: 120, height: 60, classes: ["ac-msg"] };
    const view = layout(specs);
    const anchor = visibleAnchor(view.element);
    expect(anchor?.row).toBe(view.rows[451]?.element);
    expect(anchor?.top).toBe(20);
  });

  test("zero-height rows keep their place in the order", () => {
    const view = layout([
      { top: 80, height: 0, classes: ["channel__date"] },
      { top: 120, height: 0, classes: ["ac-msg"] },
      { top: 160, height: 0, classes: ["channel__spacer"] },
    ]);
    const anchor = visibleAnchor(view.element);
    expect(anchor?.row).toBe(view.rows[1]?.element);
    expect(anchor?.top).toBe(20);
  });

  test("rows out of order fall back to the first visible message", () => {
    const view = layout([
      { top: 600, height: 60, classes: ["ac-msg"] },
      { top: 300, height: 60, classes: ["ac-msg"] },
      { top: 120, height: 60, classes: ["ac-msg"] },
    ]);
    const anchor = visibleAnchor(view.element);
    expect(anchor?.row).toBe(view.rows[1]?.element);
    expect(anchor?.top).toBe(200);
  });

  test("skipClipped bypasses a top-clipped unmeasured row in favor of the next visible message", () => {
    const view = layout([
      { top: 70, height: 56, classes: ["ac-msg"] }, // clipped at top (box.top = 100)
      { top: 126, height: 120, classes: ["ac-msg"] }, // starts inside viewport
    ]);
    const clipped = view.rows[0]?.element;
    const anchor = visibleAnchor(view.element, { skipClipped: (row) => row === clipped });
    expect(anchor?.row).toBe(view.rows[1]?.element);
    expect(anchor?.top).toBe(26);
    // Falls back to the clipped row when it is the only visible message.
    const single = layout([{ top: 50, height: 500, classes: ["ac-msg"] }]);
    const only = visibleAnchor(single.element, { skipClipped: () => true });
    expect(only?.row).toBe(single.rows[0]?.element);
    expect(only?.top).toBe(-50);
  });
});

type Spec = { top: number; height: number; classes: string[]; laid?: boolean };

/** A row set with explicit rects, and optionally rows jsdom never laid out (`0,0,0,0`). */
const layout = (specs: Spec[], box = { top: 100, bottom: 500 }) => {
  const rows = specs.map((spec) => ({
    element: {
      classList: { contains: (name: string) => spec.classes.includes(name) },
      getBoundingClientRect: () =>
        spec.laid === false
          ? ({ top: 0, bottom: 0, width: 0, height: 0 } as DOMRect)
          : ({ top: spec.top, bottom: spec.top + spec.height, width: 100, height: spec.height } as DOMRect),
    } as unknown as Element,
  }));
  return {
    rows,
    element: {
      getBoundingClientRect: () => box as DOMRect,
      children: rows.map((entry) => entry.element),
    } as unknown as HTMLElement,
  };
};

/** The unchanged scan `visibleAnchor` must match in every layout. */
const reference = (element: HTMLElement) => {
  const box = element.getBoundingClientRect();
  let first: { row: Element; top: number } | null = null;
  for (const row of element.children) {
    if (row.classList.contains("channel__spacer")) continue;
    const rect = row.getBoundingClientRect();
    if (rect.bottom <= box.top || rect.top >= box.bottom) continue;
    const anchor = { row, top: rect.top - box.top };
    if (row.classList.contains("ac-msg")) return anchor;
    first ??= anchor;
  }
  return first;
};

describe("the search agrees with the linear scan in every layout", () => {
  let seed = 0x2f6e2b1;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const pick = <T>(values: T[]) => values[Math.floor(random() * values.length)] as T;
  const classes = () => {
    const roll = random();
    return roll < 0.12 ? ["channel__spacer"] : roll < 0.2 ? ["channel__date"] : ["ac-msg"];
  };

  test("monotonic, non-monotonic, and partially mocked rows match it", () => {
    for (let iteration = 0; iteration < 1500; iteration++) {
      const mode = iteration % 3;
      const count = 1 + Math.floor(random() * 30);
      const specs: Spec[] = [];
      if (mode === 0) {
        let top = -Math.floor(random() * 300);
        for (let i = 0; i < count; i++) {
          const height = pick([0, 20, 40, 56, 60, 120, 320]);
          specs.push({ top, height, classes: classes() });
          top += Math.max(0, height - pick([0, 0, 0, 8]));
        }
      } else if (mode === 1) {
        for (let i = 0; i < count; i++) {
          const height = pick([0, 20, 40, 56, 60, 120, 320]);
          specs.push({ top: -300 + Math.floor(random() * 1200), height, classes: classes() });
        }
      } else {
        let top = -Math.floor(random() * 300);
        for (let i = 0; i < count; i++) {
          const height = pick([0, 20, 40, 56, 60, 120, 320]);
          specs.push({ top, height, classes: classes(), laid: random() < 0.08 });
          top += Math.max(0, height - pick([0, 0, 0, 8]));
        }
      }
      const boxTop = Math.floor(random() * 600) - 100;
      const box = { top: boxTop, bottom: boxTop + 200 + Math.floor(random() * 400) };
      const view = layout(specs, box);
      const expected = reference(view.element);
      const actual = visibleAnchor(view.element);
      if (actual?.row !== expected?.row || actual?.top !== expected?.top) {
        const index = (row: Element | undefined) => view.rows.findIndex((entry) => entry.element === row);
        throw new Error(
          `mode ${mode} case ${iteration} disagreed: expected row ${index(expected?.row)} (${expected?.top}), ` +
            `got row ${index(actual?.row)} (${actual?.top}) for ${JSON.stringify({ specs, box })}`,
        );
      }
    }
  });
});
