import { afterEach, describe, expect, test } from "bun:test";
import type { Message } from "@agenteschat/client";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent } from "@testing-library/react";
import { DRAWN } from "@/chat/draw-ahead";
import { createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

/** A history long enough to take several scroll-up pages, older than the seed's messages. */
const HISTORY = 320;

const withHistory = (count = HISTORY) => {
  const state = seedState();
  const start = Date.parse("2026-10-01T00:00:00Z");
  state.messages = [
    ...Array.from({ length: count }, (_, i) => ({
      id: `hist-${i}`,
      channelId: ENG_ID,
      threadId: null,
      author: { type: "person" as const, id: "u-joao" },
      body: `história ${i}`,
      mentionedAgentIds: [],
      agentRunId: null,
      createdAt: new Date(start + i * 60_000).toISOString(),
    })),
    ...state.messages,
  ];
  return state;
};

const open = async (api = createFakeApi(withHistory())) => {
  const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
  await settle(5);
  const socket = r.sockets.last();
  await act(async () => socket.open());
  await settle(2);
  return r;
};

describe("the older pages a channel keeps", () => {
  test("Linux desktop holds late resizes and does not restore a prepended page twice", async () => {
    const nativeObserver = globalThis.ResizeObserver;
    const supports = CSS.supports;
    const desktop = window as typeof window & { __agentesDesktop?: unknown };
    const observers: { callback: ResizeObserverCallback; targets: Set<Element> }[] = [];
    globalThis.ResizeObserver = class {
      private entry: (typeof observers)[number];
      constructor(callback: ResizeObserverCallback) {
        this.entry = { callback, targets: new Set() };
        observers.push(this.entry);
      }
      observe(target: Element) {
        this.entry.targets.add(target);
      }
      unobserve(target: Element) {
        this.entry.targets.delete(target);
      }
      disconnect() {
        this.entry.targets.clear();
      }
    } as unknown as typeof ResizeObserver;
    CSS.supports = () => true;
    desktop.__agentesDesktop = { platform: "linux" };
    try {
      const api = createFakeApi(withHistory());
      const read = api.chat.messages.bind(api.chat);
      let release = () => {};
      api.chat.messages = async (...args: Parameters<typeof read>) => {
        if (args[2]?.before)
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        return read(...args);
      };
      await open(api);
      const log = screen().getByRole("region", { name: "Mensagens" });
      expect(log.hasAttribute("data-manual-anchor")).toBe(true);
      const arrived = () => Boolean(screen().queryByText("história 200"));
      let height = 40;
      Object.defineProperty(log, "scrollHeight", {
        configurable: true,
        get: () => (arrived() ? 4500 + height - 60 : 4000),
      });
      Object.defineProperty(log, "clientHeight", { configurable: true, value: 500 });
      log.getBoundingClientRect = () => ({ top: 0, bottom: 500 }) as DOMRect;
      const row = screen().getByText("história 250").closest(".ac-msg") as HTMLElement;
      const above = screen().getByText("história 249").closest(".ac-msg") as HTMLElement;
      Object.defineProperty(above, "offsetHeight", { configurable: true, get: () => height });
      above.getBoundingClientRect = () => ({ top: 20 - log.scrollTop, bottom: 20 + height - log.scrollTop }) as DOMRect;
      row.getBoundingClientRect = () => {
        if (arrived() && height === 40) height = 60;
        const top = 140 + (arrived() ? 500 : 0) + height - 40 - log.scrollTop;
        return { top, bottom: top + 40 } as DOMRect;
      };
      const report = async () => {
        await act(async () => {
          for (const observer of observers.filter((o) => o.targets.has(log)))
            observer.callback([{ target: above } as unknown as ResizeObserverEntry], {} as ResizeObserver);
        });
      };
      await report();
      log.scrollTop = 120;
      await act(async () => {
        fireEvent.wheel(log, { deltaY: -40 });
        fireEvent.scroll(log);
      });
      // Both the page and an existing row change before the observer delivers its notification.
      await act(async () => release());
      await settle(3);
      expect(log.scrollTop).toBe(640);
      await report();
      expect(log.scrollTop).toBe(640);
      // Later growth above the viewport is compensated once.
      log.scrollTop = 800;
      height = 90;
      await report();
      expect(log.scrollTop).toBe(830);
      expect(log.scrollHeight - log.clientHeight - log.scrollTop).toBe(3200);
      // At the end, growth follows the end instead of applying a manual row shift.
      log.scrollTop = 4030;
      await act(async () => {
        fireEvent.wheel(log, { deltaY: 40 });
        fireEvent.scroll(log);
      });
      height = 110;
      await report();
      expect(log.scrollTop).toBe(4550);
    } finally {
      cleanup();
      delete desktop.__agentesDesktop;
      CSS.supports = supports;
      globalThis.ResizeObserver = nativeObserver;
    }
  }, 15_000);

  test("a page arriving preserves the row being read even when the end grows", async () => {
    const api = createFakeApi(withHistory());
    const read = api.chat.messages.bind(api.chat);
    let olderRequests = 0;
    let release = () => {};
    api.chat.messages = async (...args: Parameters<typeof read>) => {
      if (args[2]?.before) {
        olderRequests++;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return read(...args);
    };
    await open(api);
    const log = screen().getByRole("region", { name: "Mensagens" });
    const arrived = () => Boolean(screen().queryByText("história 200"));
    Object.defineProperty(log, "scrollHeight", { configurable: true, get: () => (arrived() ? 4800 : 4000) });
    Object.defineProperty(log, "clientHeight", { configurable: true, value: 500 });
    const row = screen().getByText("história 250").closest(".ac-msg") as HTMLElement;
    log.getBoundingClientRect = () => ({ top: 0, bottom: 500 }) as DOMRect;
    row.getBoundingClientRect = () => {
      const top = 140 + (arrived() ? 500 : 0) - log.scrollTop;
      return { top, bottom: top + 40 } as DOMRect;
    };
    log.scrollTop = 1600;
    await act(async () => {
      fireEvent.wheel(log, { deltaY: 40 });
      fireEvent.scroll(log);
    });
    expect(olderRequests).toBe(0);
    log.scrollTop = 1500;
    await act(async () => {
      fireEvent.wheel(log, { deltaY: -40 });
      fireEvent.scroll(log);
    });
    expect(olderRequests).toBe(1);
    expect(screen().getByRole("region", { name: "Mensagens" })).toBe(log);
    expect(log.scrollTop).toBe(1500);
    log.scrollTop = 80;
    await act(async () => fireEvent.scroll(log));
    expect(olderRequests).toBe(1);
    await act(async () => release());
    await settle(3);
    expect(log.scrollTop).toBe(580);
  }, 15_000);

  test("the row being read is sampled as the page lands, not from an earlier frame", async () => {
    const desktop = window as typeof window & { __agentesDesktop?: unknown };
    desktop.__agentesDesktop = { platform: "linux" };
    const api = createFakeApi(withHistory());
    const read = api.chat.messages.bind(api.chat);
    let olderRequests = 0;
    let release = () => {};
    api.chat.messages = async (...args: Parameters<typeof read>) => {
      if (args[2]?.before) {
        olderRequests++;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return read(...args);
    };
    try {
      await open(api);
      const log = screen().getByRole("region", { name: "Mensagens" });
      const arrived = () => Boolean(screen().queryByText("história 200"));
      Object.defineProperty(log, "scrollHeight", { configurable: true, get: () => (arrived() ? 4800 : 4000) });
      Object.defineProperty(log, "clientHeight", { configurable: true, value: 500 });
      const row = screen().getByText("história 250").closest(".ac-msg") as HTMLElement;
      let late = false;
      log.getBoundingClientRect = () => ({ top: 0, bottom: 500 }) as DOMRect;
      row.getBoundingClientRect = () => {
        const top = 1600 + (arrived() ? 500 : 0) + (late ? 211 : 0) - log.scrollTop;
        return { top, bottom: top + 40 } as DOMRect;
      };
      log.scrollTop = 1600;
      await act(async () => {
        fireEvent.wheel(log, { deltaY: -40 });
        log.scrollTop = 1500;
        fireEvent.scroll(log);
      });
      expect(olderRequests).toBe(1);
      // Layout moves the row after the gesture, before the page lands: it is read where it stands in that commit.
      late = true;
      await act(async () => release());
      await settle(3);
      // The prepended page adds 500 above it: the row stays where the commit found it (311), not where the gesture
      // left it (100).
      expect(log.scrollTop).toBe(2000);
      expect(row.getBoundingClientRect().top).toBe(311);
    } finally {
      cleanup();
      delete desktop.__agentesDesktop;
    }
  }, 15_000);

  /**
   * A fake layout and frame clock (happy-dom has neither): a row of a joining page stands at the 56px placeholder
   * while skipped, takes 150px while `data-drawn` is set, and only remembers 150px (`contain-intrinsic-size: auto`)
   * if `data-drawn` is still set after a frame's animation callbacks finish rendering.
   */
  const pageLayout = (log: HTMLElement, joins: (row: Element) => boolean) => {
    const remembered = new WeakSet<Element>();
    const counts = { placeholders: 0 };
    const heightOf = (row: Element) => {
      if (!row.classList.contains("ac-msg")) return 0;
      if (!joins(row)) return 56;
      if (row.hasAttribute(DRAWN) || remembered.has(row)) return 150;
      counts.placeholders++;
      return 56;
    };
    const totalHeight = () => {
      let sum = 0;
      for (const child of Array.from(log.children)) sum += heightOf(child);
      return sum;
    };
    let ids = 0;
    const queued = new Map<number, FrameRequestCallback>();
    const realFrames = {
      requestAnimationFrame: globalThis.requestAnimationFrame,
      cancelAnimationFrame: globalThis.cancelAnimationFrame,
    };
    const flushFrame = () => {
      const callbacks = [...queued.values()];
      queued.clear();
      for (const cb of callbacks) cb(performance.now());
      // Step 11 of update-the-rendering: `contain-intrinsic-size: auto` records the last remembered size of rows
      // that are not skipping their contents after animation callbacks have finished.
      for (const row of Array.from(log.children)) {
        if (joins(row) && row.hasAttribute(DRAWN)) remembered.add(row);
      }
    };
    Object.assign(globalThis, {
      requestAnimationFrame: (cb: FrameRequestCallback) => {
        if (queued.size === 0) setTimeout(flushFrame, 0);
        const id = ++ids;
        queued.set(id, cb);
        return id;
      },
      cancelAnimationFrame: (id: number) => queued.delete(id),
    });
    const native = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      if (this === log) return { top: 0, bottom: 500, height: 500, width: 600, left: 0, right: 600 } as DOMRect;
      if (this.parentElement !== log) return native.call(this);
      let top = 0;
      for (const sibling of Array.from(log.children)) {
        if (sibling === this) break;
        top += heightOf(sibling);
      }
      const height = heightOf(this);
      const at = top - log.scrollTop;
      return { top: at, bottom: at + height, height, width: 600, left: 0, right: 600 } as DOMRect;
    };
    // The scroller's scrollTop, with every write the code under test makes counted: the person's own scroll is not one.
    let scrollTop = 0;
    const writes: number[] = [];
    // Whether the whole page stood drawn when each write was made, and the list's total height at that write.
    const drawnAtWrite: boolean[] = [];
    const heightsAtWrite: number[] = [];
    Object.defineProperty(log, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        writes.push(value);
        drawnAtWrite.push(
          Array.from(log.children)
            .filter(joins)
            .every((row) => row.hasAttribute(DRAWN)),
        );
        heightsAtWrite.push(totalHeight());
        scrollTop = value;
      },
    });
    Object.defineProperty(log, "scrollHeight", { configurable: true, get: totalHeight });
    Object.defineProperty(log, "clientHeight", { configurable: true, value: 500 });
    return {
      counts,
      writes,
      drawnAtWrite,
      heightsAtWrite,
      scrollTo: (top: number) => {
        scrollTop = top;
      },
      restore: () => {
        queued.clear();
        HTMLElement.prototype.getBoundingClientRect = native;
        Object.assign(globalThis, realFrames);
      },
    };
  };

  const historyNumber = (row: Element) => Number(/^hist-(\d+)$/.exec(row.getAttribute("data-message-id") ?? "")?.[1]);
  /** The rows older than the oldest one shown now: the page that joins when the person reaches the top. */
  const joinsBeforeShown = (log: HTMLElement) => {
    const shown = Math.min(...Array.from(log.querySelectorAll(".ac-msg"), historyNumber).filter((n) => n >= 0));
    return (row: Element) => historyNumber(row) < shown;
  };

  const heldPages = () => {
    const api = createFakeApi(withHistory());
    const read = api.chat.messages.bind(api.chat);
    const held = { release: () => {} };
    api.chat.messages = async (...args: Parameters<typeof read>) => {
      if (args[2]?.before)
        await new Promise<void>((resolve) => {
          held.release = resolve;
        });
      return read(...args);
    };
    return { api, held };
  };

  const wheelUp = async (log: HTMLElement) =>
    act(async () => {
      fireEvent.wheel(log, { deltaY: -40 });
      fireEvent.scroll(log);
    });

  test("a page joins the moment it arrives, however the person keeps scrolling", async () => {
    const { api, held } = heldPages();
    await open(api);
    const log = screen().getByRole("region", { name: "Mensagens" });
    const layout = pageLayout(log, joinsBeforeShown(log));
    try {
      layout.scrollTo(120);
      await wheelUp(log);
      expect(screen().queryByText("história 200")).toBeNull();
      // The response lands while wheel and scroll events keep coming at the top: nothing waits for them to stop.
      await act(async () => {
        held.release();
        for (let i = 0; i < 6; i++) {
          fireEvent.wheel(log, { deltaY: -40 });
          fireEvent.scroll(log);
        }
      });
      await settle(2);
      for (let n = 200; n < 250; n++) expect(screen().queryByText(`história ${n}`)).toBeTruthy();
    } finally {
      layout.restore();
    }
  }, 15_000);

  test("the page is drawn at its real height before it can move anything", async () => {
    const { api, held } = heldPages();
    await open(api);
    const log = screen().getByRole("region", { name: "Mensagens" });
    const layout = pageLayout(log, joinsBeforeShown(log));
    try {
      layout.scrollTo(120);
      await wheelUp(log);
      const rows = () => Array.from(log.querySelectorAll<HTMLElement>(".ac-msg"));
      const reading = rows().find((row) => {
        const rect = row.getBoundingClientRect();
        return rect.bottom > 0 && rect.top < 500;
      }) as HTMLElement;
      const before = reading.getBoundingClientRect().top;
      const beforeHeight = log.scrollHeight;
      const joins = joinsBeforeShown(log);
      layout.counts.placeholders = 0;
      layout.writes.length = 0;
      layout.drawnAtWrite.length = 0;
      layout.heightsAtWrite.length = 0;
      await act(async () => held.release());
      await settle(4);
      const joinedRows = rows().filter(joins);
      expect(joinedRows).toHaveLength(50);
      // Every row of the page was drawn when the list was put back, so the scrollbar grew once to its real height.
      expect(layout.drawnAtWrite).toEqual([true]);
      expect(layout.heightsAtWrite).toEqual([beforeHeight + 50 * 150]);
      // Far rows were released after the frame finished recording their real heights, so scrollHeight never shrinks.
      expect(joinedRows.some((row) => !row.hasAttribute(DRAWN))).toBe(true);
      expect(log.scrollHeight).toBe(beforeHeight + 50 * 150);
      // Fifty rows at their real 150px, not at the 56px they would have taken undrawn.
      expect(log.scrollTop).toBe(120 + 50 * 150);
      expect(reading.getBoundingClientRect().top).toBe(before);
      expect(layout.counts.placeholders).toBe(0);
    } finally {
      layout.restore();
    }
  }, 15_000);

  test("one correction when the page joins, none while scrolling up through it", async () => {
    const { api, held } = heldPages();
    await open(api);
    const log = screen().getByRole("region", { name: "Mensagens" });
    const layout = pageLayout(log, joinsBeforeShown(log));
    try {
      const beforeHeight = log.scrollHeight;
      layout.scrollTo(120);
      await wheelUp(log);
      await act(async () => held.release());
      await settle(4);
      expect(layout.writes).toEqual([120 + 50 * 150]);
      expect(log.scrollHeight).toBe(beforeHeight + 50 * 150);
      // Up through the page, past the 600px a scroll must move before rows are drawn or let go again.
      for (let top = 120 + 50 * 150; top > 0; top = Math.max(0, top - 700)) {
        layout.scrollTo(top);
        await wheelUp(log);
        await settle(1);
        expect(log.scrollHeight).toBe(beforeHeight + 50 * 150);
      }
      expect(layout.writes).toEqual([120 + 50 * 150]);
      expect(layout.counts.placeholders).toBe(0);
    } finally {
      layout.restore();
    }
  }, 15_000);

  test("with native scroll anchoring, a joining page draws through paint and releases every data-drawn row", async () => {
    const supports = CSS.supports;
    const desktop = window as typeof window & { __agentesDesktop?: unknown };
    delete desktop.__agentesDesktop;
    CSS.supports = () => true;
    try {
      const { api, held } = heldPages();
      await open(api);
      const log = screen().getByRole("region", { name: "Mensagens" });
      expect(log.hasAttribute("data-manual-anchor")).toBe(false);
      const layout = pageLayout(log, joinsBeforeShown(log));
      try {
        const beforeHeight = log.scrollHeight;
        layout.scrollTo(120);
        await wheelUp(log);
        layout.counts.placeholders = 0;
        layout.writes.length = 0;
        layout.drawnAtWrite.length = 0;
        await act(async () => held.release());
        await settle(4);
        expect(layout.drawnAtWrite).toEqual([true]);
        expect(log.scrollTop).toBe(120 + 50 * 150);
        // No scroll listener runs `drawAhead` on native anchoring: every row drops `data-drawn` after paint while
        // keeping its remembered real height.
        expect(log.querySelectorAll(`[${DRAWN}]`).length).toBe(0);
        expect(log.scrollHeight).toBe(beforeHeight + 50 * 150);
        expect(layout.counts.placeholders).toBe(0);
      } finally {
        layout.restore();
      }
    } finally {
      CSS.supports = supports;
    }
  }, 15_000);

  test("two older pages arriving back to back keep both drawn through their own paint frames", async () => {
    const api = createFakeApi(withHistory());
    const read = api.chat.messages.bind(api.chat);
    const releases: (() => void)[] = [];
    api.chat.messages = async (...args: Parameters<typeof read>) => {
      if (args[2]?.before)
        await new Promise<void>((resolve) => {
          releases.push(resolve);
        });
      return read(...args);
    };
    await open(api);
    const log = screen().getByRole("region", { name: "Mensagens" });
    const layout = pageLayout(log, joinsBeforeShown(log));
    try {
      const beforeHeight = log.scrollHeight;
      layout.scrollTo(120);
      await wheelUp(log);
      expect(releases).toHaveLength(1);
      // Resolve page 1, then immediately ask for and resolve page 2 before page 1's post-paint release runs.
      await act(async () => releases[0]?.());
      await act(async () => {
        layout.scrollTo(120);
        fireEvent.wheel(log, { deltaY: -40 });
        fireEvent.scroll(log);
      });
      expect(releases).toHaveLength(2);
      await act(async () => releases[1]?.());
      await settle(5);
      // Both pages (100 rows) remembered their 150px height; page 1's release did not strip page 2 early.
      expect(log.scrollHeight).toBe(beforeHeight + 100 * 150);
      expect(layout.counts.placeholders).toBe(0);
      expect(layout.writes).toEqual([120 + 50 * 150, 120 + 50 * 150]);
    } finally {
      layout.restore();
    }
  }, 15_000);

  test("pinned to the end when an in-flight older page joins, the end stays pinned on that commit", async () => {
    const { api, held } = heldPages();
    await open(api);
    const log = screen().getByRole("region", { name: "Mensagens" });
    const layout = pageLayout(log, joinsBeforeShown(log));
    try {
      layout.scrollTo(120);
      await wheelUp(log);
      // Person returns to the bottom before the older page answers.
      layout.scrollTo(log.scrollHeight);
      await act(async () => {
        fireEvent.wheel(log, { deltaY: 40 });
        fireEvent.scroll(log);
      });
      layout.writes.length = 0;
      await act(async () => held.release());
      // Kept at the end in the commit itself, before any animation frame runs (without drawing off-screen rows).
      expect(layout.writes.length).toBeGreaterThan(0);
      expect(layout.writes.every((w) => w === log.scrollHeight)).toBe(true);
      expect(log.scrollTop).toBe(log.scrollHeight);
      await settle(2);
      expect(log.scrollTop).toBe(log.scrollHeight);
      expect(log.querySelectorAll(`[${DRAWN}]`).length).toBe(0);
    } finally {
      layout.restore();
    }
  }, 15_000);

  test("where the list holds its own place, rows near the screen are drawn as it scrolls", async () => {
    const nativeObserver = globalThis.ResizeObserver;
    const desktop = window as typeof window & { __agentesDesktop?: unknown };
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    const drawn = (log: HTMLElement) => log.querySelectorAll(`.ac-msg[${DRAWN}]`).length;
    try {
      desktop.__agentesDesktop = { platform: "linux" };
      await open();
      const log = screen().getByRole("region", { name: "Mensagens" });
      Object.defineProperty(log, "scrollHeight", { configurable: true, value: 4000 });
      Object.defineProperty(log, "clientHeight", { configurable: true, value: 500 });
      expect(drawn(log)).toBe(0);
      await act(async () => {
        fireEvent.wheel(log, { deltaY: -40 });
        log.scrollTop = 600; // Past the 600px scroll throttle.
        fireEvent.scroll(log);
      });
      expect(drawn(log)).toBeGreaterThan(0);
      cleanup();
      expect(drawn(log)).toBe(0);
      // Another platform: the browser's own scroll anchoring holds the place, and rows stay skipped until seen.
      delete desktop.__agentesDesktop;
      const supports = CSS.supports;
      CSS.supports = () => true;
      try {
        await open();
        const other = screen().getByRole("region", { name: "Mensagens" });
        await act(async () => fireEvent.scroll(other));
        expect(drawn(other)).toBe(0);
      } finally {
        CSS.supports = supports;
      }
    } finally {
      cleanup();
      delete desktop.__agentesDesktop;
      globalThis.ResizeObserver = nativeObserver;
    }
  }, 15_000);

  test("a scroll between a page arriving and its rows being put in is not undone", async () => {
    const api = createFakeApi(withHistory());
    const read = api.chat.messages.bind(api.chat);
    let release = () => {};
    api.chat.messages = async (...args: Parameters<typeof read>) => {
      if (args[2]?.before)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      return read(...args);
    };
    await open(api);
    const log = screen().getByRole("region", { name: "Mensagens" });
    const arrived = () => Boolean(screen().queryByText("história 200"));
    Object.defineProperty(log, "scrollHeight", { configurable: true, get: () => (arrived() ? 4800 : 4000) });
    Object.defineProperty(log, "clientHeight", { configurable: true, value: 500 });
    const row = screen().getByText("história 250").closest(".ac-msg") as HTMLElement;
    log.getBoundingClientRect = () => ({ top: 0, bottom: 500 }) as DOMRect;
    row.getBoundingClientRect = () => {
      const top = 140 + (arrived() ? 500 : 0) - log.scrollTop;
      return { top, bottom: top + 40 } as DOMRect;
    };
    log.scrollTop = 120;
    await act(async () => {
      fireEvent.wheel(log, { deltaY: -40 });
      fireEvent.scroll(log);
    });
    // The response is handled and the page waits to be drawn; the person keeps scrolling (their scroll event is yet to
    // come). The row they read stays where it is on screen, 40px lower than the page's arrival found it.
    await act(async () => {
      release();
      await new Promise((resolve) => setTimeout(resolve, 0));
      log.scrollTop = 80;
    });
    await settle(3);
    expect(log.scrollTop).toBe(580);
  }, 15_000);

  test("back at the bottom the far pages are released, and scrolling up reads them again", async () => {
    await open();
    const log = screen().getByRole("region", { name: "Mensagens" });
    // happy-dom has no layout: fake a tall scroll area.
    Object.defineProperty(log, "scrollHeight", { configurable: true, value: 4000 });
    Object.defineProperty(log, "clientHeight", { configurable: true, value: 500 });

    const articles = () => screen().queryAllByRole("article");
    const said = (text: string) => articles().filter((row) => row.textContent?.includes(text));
    const historyRows = () => articles().filter((row) => /história \d+/.test(row.textContent ?? ""));
    const loadPage = async () => {
      log.scrollTop = 0;
      await act(async () => {
        fireEvent.wheel(log, { deltaY: -40 });
        fireEvent.scroll(log);
      });
      await settle(3);
    };

    // Five pages of scroll-up read the whole history.
    for (let i = 0; i < 5; i++) await loadPage();
    expect(said("história 0")).toHaveLength(1);
    const all = historyRows().length;

    // Back at the bottom: the far pages are let go, and the newest stay.
    log.scrollTop = 3900;
    await act(async () => {
      fireEvent.wheel(log, { deltaY: 40 });
      fireEvent.scroll(log);
    });
    await settle(3);
    expect(said("história 0")).toHaveLength(0);
    expect(said(`história ${HISTORY - 1}`)).toHaveLength(1);
    expect(historyRows().length).toBeLessThan(all);

    // Scrolling up again reads what was let go from the server.
    await loadPage();
    expect(said("história 0")).toHaveLength(1);
  }, 15_000);

  test("a duplicate page ends loading and keeps the existing rows once", async () => {
    const api = createFakeApi(withHistory());
    const read = api.chat.messages.bind(api.chat);
    let firstOlder: Message[] = [];
    let olderRequests = 0;
    let hold: Promise<void> | null = null;
    let release = () => {};
    api.chat.messages = async (...args: Parameters<typeof read>) => {
      const page = await read(...args);
      if (!args[2]?.before) return page;
      olderRequests++;
      if (hold) await hold;
      if (olderRequests === 1) {
        firstOlder = page;
        return page;
      }
      // The same page again: the server made no progress toward older messages.
      return firstOlder ?? page;
    };
    await open(api);
    const log = screen().getByRole("region", { name: "Mensagens" });
    Object.defineProperty(log, "scrollHeight", { configurable: true, value: 4000 });
    Object.defineProperty(log, "clientHeight", { configurable: true, value: 500 });
    const olderStatus = () => log.querySelector(".channel__older")?.textContent ?? "";
    const said = (text: string) =>
      screen()
        .queryAllByRole("article")
        .filter((row) => row.textContent?.includes(text));
    const loadPage = async () => {
      log.scrollTop = 0;
      await act(async () => {
        fireEvent.wheel(log, { deltaY: -40 });
        fireEvent.scroll(log);
      });
      await settle(3);
    };

    await loadPage();
    expect(olderStatus()).toBe("");
    const first = firstOlder;
    if (first.length === 0) throw new Error("the first older page never arrived");
    for (const message of first) expect(said(message.body)).toHaveLength(1);

    hold = new Promise((resolve) => {
      release = resolve;
    });
    await loadPage();
    expect(olderStatus()).toContain("Carregando mensagens anteriores");
    hold = null;
    await act(async () => release());
    await settle(2);
    expect(olderStatus()).toBe("");
    expect(olderRequests).toBe(2);
    for (const message of first) expect(said(message.body)).toHaveLength(1);
  }, 15_000);

  test("an empty page ends loading", async () => {
    const api = createFakeApi(withHistory());
    const read = api.chat.messages.bind(api.chat);
    let olderRequests = 0;
    let release = () => {};
    api.chat.messages = async (...args: Parameters<typeof read>) => {
      if (!args[2]?.before) return read(...args);
      olderRequests++;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return [];
    };
    await open(api);
    const log = screen().getByRole("region", { name: "Mensagens" });
    Object.defineProperty(log, "scrollHeight", { configurable: true, value: 4000 });
    Object.defineProperty(log, "clientHeight", { configurable: true, value: 500 });
    const olderStatus = () => log.querySelector(".channel__older")?.textContent ?? "";
    log.scrollTop = 0;
    await act(async () => {
      fireEvent.wheel(log, { deltaY: -40 });
      fireEvent.scroll(log);
    });
    await settle(3);
    expect(olderStatus()).toContain("Carregando mensagens anteriores");
    await act(async () => release());
    await settle(2);
    expect(olderRequests).toBe(1);
    expect(olderStatus()).toBe("");
  }, 15_000);

  test("a page still loading when the person gets back down is kept, with no gap before it", async () => {
    const api = createFakeApi(withHistory(600));
    const read = api.chat.messages.bind(api.chat);
    let gate: Promise<void> | null = null;
    api.chat.messages = async (...args: Parameters<typeof read>) => {
      if (gate) await gate;
      return read(...args);
    };
    await open(api);
    const log = screen().getByRole("region", { name: "Mensagens" });
    Object.defineProperty(log, "scrollHeight", { configurable: true, value: 4000 });
    Object.defineProperty(log, "clientHeight", { configurable: true, value: 500 });
    const scrollTo = async (top: number, deltaY: number) => {
      log.scrollTop = top;
      await act(async () => {
        fireEvent.wheel(log, { deltaY });
        fireEvent.scroll(log);
      });
      await settle(3);
    };
    const shown = () =>
      screen()
        .queryAllByRole("article")
        .map((row) => /história (\d+)/.exec(row.textContent ?? "")?.[1])
        .filter((n): n is string => n !== undefined)
        .map(Number);

    for (let i = 0; i < 5; i++) {
      await scrollTo(0, -40);
      await settle(2);
    }
    // One more page asked for, still on its way when the person goes back down.
    let open_ = () => {};
    gate = new Promise((resolve) => {
      open_ = resolve;
    });
    await scrollTo(0, -40);
    await scrollTo(3900, 40);
    gate = null;
    await act(async () => open_());
    await settle(3);

    const numbers = shown();
    expect(numbers.length).toBeGreaterThan(250);
    const unique = [...new Set(numbers)].sort((a, b) => a - b);
    // The page on its way (203-252) is kept. The far loaded page (253-302) is let go: one gap, before 303.
    expect(unique[0]).toBe(203);
    const gaps = unique.slice(1).flatMap((number, i) => {
      const before = unique[i];
      return before !== undefined && number - before > 1 ? [{ at: number, missing: number - before - 1 }] : [];
    });
    expect(gaps).toEqual([{ at: 303, missing: 50 }]);
  }, 15_000);

  /**
   * Simulates WebKit2GTK's real scroll/layout engine on manual anchoring:
   * - Rows without `data-drawn` offscreen use explicit `contain-intrinsic-block-size` if set, otherwise
   *   revert to `placeholder` (reproducing WebKit2GTK losing `contain-intrinsic-size: auto` on release).
   * - Rows intersecting `[0, viewHeight]` expand automatically (simulating `content-visibility: auto`),
   *   notifying ResizeObserver on the next microtask/frame.
   * - `smoothWheelUp(distance)` animates `scrollTop` across `frames` frames, firing `scroll` each frame and
   *   `scrollend` when complete; any programmatic write to `scrollTop` mid-animation aborts the remaining
   *   wheel delta (exact WebKit2GTK `ScrollAnimationSmooth` cancellation behavior).
   */
  const webkitScrollHarness = (
    log: HTMLElement,
    observers: { callback: ResizeObserverCallback; targets: Set<Element> }[],
    { viewHeight = 600, placeholder = 64 }: { viewHeight?: number; placeholder?: number } = {},
  ) => {
    const REAL_HEIGHTS = [32, 55, 220, 260, 420, 55, 32, 195, 340, 55];
    const realHeightOf = (row: Element) => {
      if (!row.classList.contains("ac-msg")) return 0;
      const num = historyNumber(row);
      if (Number.isFinite(num) && num >= 0) return REAL_HEIGHTS[num % REAL_HEIGHTS.length] ?? 120;
      return 72;
    };
    const lockedHeightOf = (row: Element): number | null => {
      if (!(row instanceof HTMLElement)) return null;
      const raw = row.style.getPropertyValue("contain-intrinsic-block-size").trim();
      if (!raw) return null;
      const match = /^(\d+(?:\.\d+)?)px$/.exec(raw);
      return match ? Number(match[1]) : null;
    };

    let scrollTop = 0;
    const inViewExpanded = new WeakSet<Element>();
    const lastReported = new WeakMap<Element, number>();
    let activeGlide: { cancel: () => void } | null = null;
    let cancelledGlides = 0;
    let scrollHeightShrinks = 0;
    let maxScrollHeight = 0;

    const rowHeight = (row: Element): number => {
      if (!row.classList.contains("ac-msg")) return 0;
      if (row.hasAttribute(DRAWN) || inViewExpanded.has(row)) return realHeightOf(row);
      const locked = lockedHeightOf(row);
      if (locked !== null) return locked;
      return placeholder;
    };

    const totalHeight = () => {
      let sum = 0;
      for (const child of Array.from(log.children)) sum += rowHeight(child);
      return sum;
    };

    const recordHeightMonotonic = () => {
      const h = totalHeight();
      if (maxScrollHeight > 0 && h < maxScrollHeight - 1) scrollHeightShrinks += 1;
      if (h > maxScrollHeight) maxScrollHeight = h;
    };

    const syncViewportVisibility = () => {
      let top = 0;
      const changed: Element[] = [];
      for (const child of Array.from(log.children)) {
        const h = rowHeight(child);
        const visTop = top - scrollTop;
        const visBottom = visTop + h;
        if (child.classList.contains("ac-msg")) {
          const onScreen = visBottom > 0 && visTop < viewHeight;
          if (onScreen && !inViewExpanded.has(child)) {
            inViewExpanded.add(child);
          } else if (!onScreen && inViewExpanded.has(child)) {
            inViewExpanded.delete(child);
          }
        }
        const afterH = rowHeight(child);
        const prev = lastReported.get(child);
        if (prev !== undefined && prev !== afterH) changed.push(child);
        lastReported.set(child, afterH);
        top += afterH;
      }
      recordHeightMonotonic();
      return changed;
    };

    const deliverResizes = (rows: Element[]) => {
      if (rows.length === 0) return;
      const entries = rows.map((target) => ({ target }) as unknown as ResizeObserverEntry);
      for (const observer of observers) {
        const matched = entries.filter((e) => observer.targets.has(e.target));
        if (matched.length > 0) observer.callback(matched, {} as ResizeObserver);
      }
    };

    const nativeRect = HTMLElement.prototype.getBoundingClientRect;
    const offsetHeightDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      if (this === log)
        return { top: 0, bottom: viewHeight, height: viewHeight, width: 800, left: 0, right: 800 } as DOMRect;
      if (this.parentElement !== log) return nativeRect.call(this);
      let top = 0;
      for (const sibling of Array.from(log.children)) {
        if (sibling === this) break;
        top += rowHeight(sibling);
      }
      const height = rowHeight(this);
      const at = top - scrollTop;
      return { top: at, bottom: at + height, height, width: 800, left: 0, right: 800 } as DOMRect;
    };
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get(this: HTMLElement) {
        if (this.parentElement === log) return rowHeight(this);
        return offsetHeightDesc?.get?.call(this) ?? 0;
      },
    });
    Object.defineProperty(log, "clientHeight", { configurable: true, value: viewHeight });
    Object.defineProperty(log, "clientWidth", { configurable: true, value: 800 });
    Object.defineProperty(log, "scrollHeight", { configurable: true, get: totalHeight });
    Object.defineProperty(log, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        // Any programmatic write to scrollTop during an active WebKit2GTK smooth-wheel glide aborts it.
        if (activeGlide) {
          cancelledGlides += 1;
          activeGlide.cancel();
          activeGlide = null;
        }
        const max = Math.max(0, totalHeight() - viewHeight);
        scrollTop = Math.max(0, Math.min(value, max));
        recordHeightMonotonic();
      },
    });

    // Seed initial height table and place reader at bottom (and deliver initial layout ResizeObserver as real browsers do).
    scrollTop = Math.max(0, totalHeight() - viewHeight);
    maxScrollHeight = totalHeight();
    for (const child of Array.from(log.children)) lastReported.set(child, rowHeight(child));
    syncViewportVisibility();
    deliverResizes([log]);

    const pickVisibleRef = () => {
      for (const child of Array.from(log.children)) {
        if (!child.classList.contains("ac-msg")) continue;
        const rect = child.getBoundingClientRect();
        if (rect.top >= 10 && rect.top < viewHeight - 100) return { row: child, top: rect.top };
      }
      return null;
    };

    const smoothWheelUp = async (distance: number, glideFrames = 6) => {
      const ref = pickVisibleRef();
      let cancelled = false;
      const perFrame = distance / glideFrames;
      await act(async () => {
        fireEvent.wheel(log, { deltaY: -distance });
      });
      activeGlide = {
        cancel: () => {
          cancelled = true;
        },
      };
      for (let f = 0; f < glideFrames; f++) {
        if (cancelled) break;
        scrollTop = Math.max(0, scrollTop - perFrame);
        await act(async () => {
          fireEvent.scroll(log);
          const changed = syncViewportVisibility();
          deliverResizes(changed);
          await new Promise((r) => setTimeout(r, 16));
        });
      }
      if (!cancelled) {
        activeGlide = null;
        await act(async () => {
          log.dispatchEvent(new Event("scrollend"));
          await new Promise((r) => setTimeout(r, 20));
        });
      }
      await act(async () => {
        // Let any deferred idle draw/release/resize settle cleanly.
        for (let i = 0; i < 4; i++) {
          const changed = syncViewportVisibility();
          deliverResizes(changed);
          await new Promise((r) => setTimeout(r, 20));
        }
      });
      const visDelta = ref ? Math.round((ref.row.getBoundingClientRect().top - ref.top) * 10) / 10 : null;
      return { visDelta, cancelled, scrollTop, scrollHeight: totalHeight() };
    };

    return {
      smoothWheelUp,
      resetMonotonic: () => {
        scrollHeightShrinks = 0;
        maxScrollHeight = totalHeight();
      },
      stats: () => ({ cancelledGlides, scrollHeightShrinks }),
      restore: () => {
        HTMLElement.prototype.getBoundingClientRect = nativeRect;
        if (offsetHeightDesc) Object.defineProperty(HTMLElement.prototype, "offsetHeight", offsetHeightDesc);
      },
    };
  };

  test("WebKitGTK smooth-wheel: 232px steps across 600px thresholds never brake or cancel glides", async () => {
    const nativeObserver = globalThis.ResizeObserver;
    const supports = CSS.supports;
    const desktop = window as typeof window & { __agentesDesktop?: unknown };
    const observers: { callback: ResizeObserverCallback; targets: Set<Element> }[] = [];
    globalThis.ResizeObserver = class {
      private entry: (typeof observers)[number];
      constructor(callback: ResizeObserverCallback) {
        this.entry = { callback, targets: new Set() };
        observers.push(this.entry);
      }
      observe(target: Element) {
        this.entry.targets.add(target);
      }
      unobserve(target: Element) {
        this.entry.targets.delete(target);
      }
      disconnect() {
        this.entry.targets.clear();
      }
    } as unknown as typeof ResizeObserver;
    CSS.supports = () => true;
    desktop.__agentesDesktop = { platform: "linux" };
    let harness: ReturnType<typeof webkitScrollHarness> | null = null;
    try {
      const api = createFakeApi(withHistory(220));
      await open(api);
      const log = screen().getByRole("region", { name: "Mensagens" });
      harness = webkitScrollHarness(log, observers, { viewHeight: 600, placeholder: 64 });
      await settle(4);
      harness.resetMonotonic();

      const deltas: number[] = [];
      for (let step = 0; step < 14; step++) {
        const res = await harness.smoothWheelUp(232, 6);
        if (res.visDelta !== null) deltas.push(res.visDelta);
        if (res.scrollTop <= 2) break;
      }
      expect(deltas.length).toBeGreaterThanOrEqual(10);
      // Every 232px wheel step must achieve the full 232px displacement (no -68..-96px brake at 600px boundaries).
      expect(deltas.map((d) => (Math.abs(d - 232) <= 2 ? 0 : Math.round(d - 232)))).toEqual(deltas.map(() => 0));
      expect(harness.stats().cancelledGlides).toBe(0);
      expect(harness.stats().scrollHeightShrinks).toBe(0);
    } finally {
      harness?.restore();
      cleanup();
      delete desktop.__agentesDesktop;
      CSS.supports = supports;
      globalThis.ResizeObserver = nativeObserver;
    }
  }, 20_000);

  test("WebKitGTK slow first scroll-up: 93px steps never jump and scrollHeight stays monotonic on release", async () => {
    const nativeObserver = globalThis.ResizeObserver;
    const supports = CSS.supports;
    const desktop = window as typeof window & { __agentesDesktop?: unknown };
    const observers: { callback: ResizeObserverCallback; targets: Set<Element> }[] = [];
    globalThis.ResizeObserver = class {
      private entry: (typeof observers)[number];
      constructor(callback: ResizeObserverCallback) {
        this.entry = { callback, targets: new Set() };
        observers.push(this.entry);
      }
      observe(target: Element) {
        this.entry.targets.add(target);
      }
      unobserve(target: Element) {
        this.entry.targets.delete(target);
      }
      disconnect() {
        this.entry.targets.clear();
      }
    } as unknown as typeof ResizeObserver;
    CSS.supports = () => true;
    desktop.__agentesDesktop = { platform: "linux" };
    let harness: ReturnType<typeof webkitScrollHarness> | null = null;
    try {
      const api = createFakeApi(withHistory(220));
      await open(api);
      const log = screen().getByRole("region", { name: "Mensagens" });
      // Use placeholder=32 (matching `contain-intrinsic-size: auto 24px` + 8px padding) AND test that released
      // rows retain their exact height via explicit `contain-intrinsic-block-size` without shrinking back.
      harness = webkitScrollHarness(log, observers, { viewHeight: 600, placeholder: 32 });
      await settle(4);
      harness.resetMonotonic();

      const deltas: number[] = [];
      for (let step = 0; step < 26; step++) {
        const res = await harness.smoothWheelUp(93, 4);
        if (res.visDelta !== null) deltas.push(res.visDelta);
        if (res.scrollTop <= 2) break;
      }
      expect(deltas.length).toBeGreaterThanOrEqual(20);
      // Every 93px slow step moves visible content by exactly 93px (no +165/+199/+367/>600px placeholder jumps).
      expect(deltas.map((d) => (Math.abs(d - 93) <= 2 ? 0 : Math.round(d - 93)))).toEqual(deltas.map(() => 0));
      // Released rows never revert to placeholder, so scrollHeight is strictly monotonic while reading up.
      expect(harness.stats().scrollHeightShrinks).toBe(0);
    } finally {
      harness?.restore();
      cleanup();
      delete desktop.__agentesDesktop;
      CSS.supports = supports;
      globalThis.ResizeObserver = nativeObserver;
    }
  }, 20_000);

  test("WebKitGTK regression: older page arriving mid-smooth-wheel glide defers slice commit until scrollend", async () => {
    const nativeObserver = globalThis.ResizeObserver;
    const supports = CSS.supports;
    const desktop = window as typeof window & { __agentesDesktop?: unknown };
    const observers: { callback: ResizeObserverCallback; targets: Set<Element> }[] = [];
    globalThis.ResizeObserver = class {
      private entry: (typeof observers)[number];
      constructor(callback: ResizeObserverCallback) {
        this.entry = { callback, targets: new Set() };
        observers.push(this.entry);
      }
      observe(target: Element) {
        this.entry.targets.add(target);
      }
      unobserve(target: Element) {
        this.entry.targets.delete(target);
      }
      disconnect() {
        this.entry.targets.clear();
      }
    } as unknown as typeof ResizeObserver;
    CSS.supports = () => true;
    desktop.__agentesDesktop = { platform: "linux" };
    let harness: ReturnType<typeof webkitScrollHarness> | null = null;
    try {
      const api = createFakeApi(withHistory(220));
      const read = api.chat.messages.bind(api.chat);
      let olderArrivedCount = 0;
      api.chat.messages = async (...args: Parameters<typeof read>) => {
        const res = await read(...args);
        if (args[2]?.before) {
          olderArrivedCount += 1;
          // Resolve right in the middle of a smooth-wheel glide (~40ms).
          await new Promise((r) => setTimeout(r, 40));
        }
        return res;
      };
      await open(api);
      const log = screen().getByRole("region", { name: "Mensagens" });
      harness = webkitScrollHarness(log, observers, { viewHeight: 600, placeholder: 32 });
      await settle(4);
      // Position ~700px above the `4 * clientHeight` (2400px) loadOlder threshold so step 4 triggers an older-page
      // fetch that resolves mid-glide, then continue scrolling up through the newly joined & released slices.
      await act(async () => {
        fireEvent.wheel(log, { deltaY: -10 });
        log.scrollTop = 3100;
        fireEvent.scroll(log);
        log.dispatchEvent(new Event("scrollend"));
      });
      await settle(4);
      harness.resetMonotonic();

      const deltas: number[] = [];
      for (let step = 0; step < 18; step++) {
        const res = await harness.smoothWheelUp(232, 6);
        if (res.visDelta !== null) deltas.push(res.visDelta);
        if (res.scrollTop <= 2) break;
      }
      expect(olderArrivedCount).toBeGreaterThanOrEqual(1);
      expect(deltas.map((d) => (Math.abs(d - 232) <= 2 ? 0 : Math.round(d - 232)))).toEqual(deltas.map(() => 0));
      expect(harness.stats().cancelledGlides).toBe(0);
      expect(harness.stats().scrollHeightShrinks).toBe(0);
    } finally {
      harness?.restore();
      cleanup();
      delete desktop.__agentesDesktop;
      CSS.supports = supports;
      globalThis.ResizeObserver = nativeObserver;
    }
  }, 25_000);
});
