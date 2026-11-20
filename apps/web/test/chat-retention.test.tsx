import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent } from "@testing-library/react";
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
