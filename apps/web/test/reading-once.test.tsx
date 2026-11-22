import { afterEach, describe, expect, test } from "bun:test";
import type { Message } from "@agenteschat/client";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent } from "@testing-library/react";
import { ADA_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

/**
 * Where a long answer lands is decided once per answer: a resize frame while it streams is a plain end-write, and
 * only another answer (or the same one once its words are posted) is measured again (`follow` in `ChannelPage`).
 */
describe("the landing is decided once per answer", () => {
  const answer = (id: string, run: string, body: string): Message =>
    ({
      id,
      channelId: ENG_ID,
      threadId: null,
      author: { type: "agent", id: ADA_ID },
      body,
      mentionedAgentIds: [],
      agentRunId: run,
      createdAt: new Date().toISOString(),
    }) as Message;

  test("a streaming answer is measured once; a new answer is measured again and lands at its start", async () => {
    const nativeObserver = globalThis.ResizeObserver;
    const nativeBox = HTMLElement.prototype.getBoundingClientRect;
    const observers: ResizeObserverCallback[] = [];
    // How many times an answer's own box was read to compare it with the list: the price of the landing.
    const boxes = new Map<Element, number>();
    // No layout here: the boxes the test gives the list and each answer (`top` in the list's content).
    const boxesById = new Map<string, { top: number; height: number }>();
    globalThis.ResizeObserver = class {
      constructor(cb: ResizeObserverCallback) {
        observers.push(cb);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    try {
      const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(seedState()) });
      await settle(5);
      await act(async () => r.sockets.last().open());
      await settle(2);
      const ev = (event: Record<string, unknown>) =>
        act(async () =>
          r.sockets.last().push({ type: "event", channelId: ENG_ID, event: { channelId: ENG_ID, ...event } }),
        );
      const log = screen().getByRole("region", { name: "Mensagens" });
      Object.defineProperty(log, "scrollHeight", { configurable: true, value: 2000 });
      Object.defineProperty(log, "clientHeight", { configurable: true, value: 500 });
      HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
        boxes.set(this, (boxes.get(this) ?? 0) + 1);
        const place = this === log ? { top: 0, height: 500 } : boxesById.get(this.dataset.readId ?? "");
        if (!place) return nativeBox.call(this);
        // The list's top is the viewport's; a row's is its place in the content moved by the scroll.
        const top = this === log ? 0 : place.top - log.scrollTop;
        return {
          top,
          bottom: top + place.height,
          height: place.height,
          left: 0,
          right: 800,
          width: 800,
          x: 0,
          y: top,
          toJSON: () => ({}),
        } as DOMRect;
      };
      const measuredTimes = (el: Element) => boxes.get(el) ?? 0;
      log.scrollTop = 1500;
      // Past the conversation opening: rows from then on are read as they arrive.
      await act(() => new Promise((resolve) => setTimeout(resolve, 1600)));
      const frame = () =>
        act(async () => {
          for (const cb of observers) cb([], {} as ResizeObserver);
        });
      const row = (id: string) => {
        const el = document.querySelector<HTMLElement>(`article[data-message-id="${id}"]`);
        if (!el) throw new Error(`no row ${id}`);
        return el;
      };

      // A short answer arrives and is followed to the end: that is where the list already is.
      boxesById.set("r-a1", { top: 1000, height: 200 });
      await ev({ type: "message.created", messageId: "m-a1", message: answer("m-a1", "r-a1", "curta") });
      await settle(3);
      const short = row("m-a1");
      // Measured once, when it arrived; a resize frame after that writes the end and asks nothing again.
      const afterArrival = measuredTimes(short);
      for (let i = 0; i < 6; i++) await frame();
      expect(measuredTimes(short)).toBe(afterArrival);
      expect(afterArrival).toBe(1);
      // The end, as this browser writes it (it clamps nothing): the list followed the answer.
      expect(log.scrollTop).toBe(2000);

      // Another answer is another identity: measured on its own, taller than the list, so it lands at its start.
      boxesById.set("r-a2", { top: 1200, height: 1200 });
      await ev({ type: "message.created", messageId: "m-a2", message: answer("m-a2", "r-a2", "longa") });
      await settle(3);
      const tall = row("m-a2");
      expect(measuredTimes(tall)).toBe(1);
      expect(log.scrollTop).toBe(1188);
      expect(screen().getByRole("button", { name: /Fim da resposta/ })).toBeTruthy();
      // Held there: the frames after it move nothing and measure nothing again.
      for (let i = 0; i < 3; i++) await frame();
      expect(measuredTimes(tall)).toBe(1);
      expect(log.scrollTop).toBe(1188);

      // An answer at work is short (its words come once posted) and is measured once like that: each frame follows
      // the end. Posted, the same answer shows its words, and its own identity is measured again then.
      await act(async () => fireEvent.click(screen().getByRole("button", { name: /Fim da resposta/ })));
      const run = { threadId: null, runId: "r-a3", agentId: ADA_ID };
      boxesById.set("r-a3", { top: 1000, height: 120 });
      await ev({ type: "agent.thinking", ...run });
      await ev({ type: "agent.tool", ...run, tool: "browser_open" });
      await settle(3);
      const working = document.querySelector<HTMLElement>('article[data-run-id="r-a3"]');
      if (!working) throw new Error("no live row");
      expect(working.dataset.messageId).toBeUndefined();
      // Its own decision, taken once: a frame makes it, and the ones after only follow the end.
      await frame();
      const workingReads = measuredTimes(working);
      for (let i = 0; i < 6; i++) await frame();
      expect(measuredTimes(working)).toBe(workingReads);
      expect(log.scrollTop).toBe(2000);
      // Its words: taller than the list, so it lands at the start of the reply.
      boxesById.set("r-a3", { top: 1200, height: 1200 });
      await ev({ type: "message.created", messageId: "m-a3", message: answer("m-a3", "r-a3", "longa") });
      await settle(3);
      // The block goes as its run ends: the answer is the last row now, with its words, and is measured again.
      await ev({ type: "run.finished", ...run, status: "done" });
      await settle(3);
      const posted = row("m-a3");
      expect(log.scrollTop).toBe(1188);
      expect(screen().getByRole("button", { name: /Fim da resposta/ })).toBeTruthy();
      const decided = measuredTimes(posted);
      for (let i = 0; i < 3; i++) await frame();
      expect(measuredTimes(posted)).toBe(decided);
      expect(log.scrollTop).toBe(1188);
    } finally {
      globalThis.ResizeObserver = nativeObserver;
      HTMLElement.prototype.getBoundingClientRect = nativeBox;
    }
  }, 15_000);
});
