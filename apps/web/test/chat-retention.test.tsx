import { afterEach, describe, expect, test } from "bun:test";
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
    expect(screen().getByRole("region", { name: "Mensagens" })).toBe(log);
    expect(log.scrollTop).toBe(120);
    log.scrollTop = 80;
    await act(async () => fireEvent.scroll(log));
    await act(async () => release());
    await settle(3);
    expect(log.scrollTop).toBe(580);
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
      expect(drawn(log)).toBe(0);
      await act(async () => {
        fireEvent.wheel(log, { deltaY: -40 });
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

    for (let i = 0; i < 5; i++) await scrollTo(0, -40);
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
    // Every message between the oldest shown and the newest is there.
    const oldest = Math.min(...numbers);
    expect(new Set(numbers).size).toBe(599 - oldest + 1);
  }, 15_000);
});
