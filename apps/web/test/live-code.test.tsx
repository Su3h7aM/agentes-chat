import { afterEach, describe, expect, test } from "bun:test";
import { domWindow, setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { Run, RunStep } from "@agenteschat/client";
import { appendOutput, applyChannelEvent, emptyStreams, runsInChannel } from "@agenteschat/client";
import { workFromSteps } from "@agenteschat/client/lib/work";
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { OutputView, tokenizeCode } from "@/components/LiveCode";
import { ADA_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const click = (el: Element) => act(async () => fireEvent.click(el));

/** The screen reader's region the finished output is announced in (see `announce`). */
const announced = () => document.querySelector('[data-ui-sdk-announcer][role="status"]') as HTMLElement | null;

/** `announce` writes its words a tick after the call, so the screen reader notices the region exists first. */
const announcedBy = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 150));
  });
  return announced()?.textContent ?? "";
};

/** The measurements of a scroller, which happy-dom has none of: the output's follow reads them. */
function measure(el: HTMLElement, height: number, view: number) {
  const box = { height, view };
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => box.height });
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => box.view });
  return box;
}

/**
 * happy-dom never resizes anything, so the output's ResizeObserver gets one callback per connect and never fires:
 * this keeps them, and `grow` is a test saying the content changed size.
 */
function sizeChanges() {
  const callbacks: ResizeObserverCallback[] = [];
  const win = domWindow() as unknown as { ResizeObserver: unknown };
  const before = win.ResizeObserver;
  win.ResizeObserver = class {
    constructor(callback: ResizeObserverCallback) {
      callbacks.push(callback);
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  return {
    grow() {
      for (const callback of callbacks) callback([], {} as ResizeObserver);
    },
    restore() {
      win.ResizeObserver = before;
    },
  };
}

describe("code the agent runs", () => {
  test("light tokens: comments, strings, numbers, keywords", () => {
    const src = ["import csv  # lê", 'print("oi", 42)'].join("\n");
    expect(tokenizeCode(src).map((t) => [t.kind, t.text])).toEqual([
      ["keyword", "import"],
      ["text", " csv  "],
      ["comment", "# lê"],
      ["text", "\nprint("],
      ["string", '"oi"'],
      ["text", ", "],
      ["number", "42"],
      ["text", ")"],
    ]);
    const loop = ['x = "a"', "for i in range(3): pass"].join("\n");
    expect(
      tokenizeCode(loop)
        .filter((t) => t.kind !== "text")
        .map((t) => t.text),
    ).toEqual(['"a"', "for", "in", "3", "pass"]);
  });

  test("output: same stream merges; the newest characters stay under the limit", () => {
    let out = appendOutput([], { stream: "stdout", text: "a" });
    out = appendOutput(out, { stream: "stdout", text: "b" });
    out = appendOutput(out, { stream: "stderr", text: "erro" });
    expect(out).toEqual([
      { stream: "stdout", text: "ab" },
      { stream: "stderr", text: "erro" },
    ]);
    expect(appendOutput(out, { stream: "stderr", text: "!!" }, 4)).toEqual([{ stream: "stderr", text: "ro!!" }]);
    // A chunk with no words adds nothing, and hands back the very list it was given: a run and its call read one.
    expect(appendOutput(out, { stream: "stdout", text: "" })).toBe(out);
    expect(appendOutput(out, { stream: "stderr", text: "" })).toBe(out);
    // On an empty output it is still the one entry there is: an output of empty chunks is an output, not none at all.
    expect(appendOutput([], { stream: "stdout", text: "" })).toEqual([{ stream: "stdout", text: "" }]);
    expect(appendOutput([], { stream: "stderr", text: "" })).toEqual([{ stream: "stderr", text: "" }]);
  });

  test("agent.tool carries the code; agent.tool.output streams into the run; a new call starts fresh", () => {
    const base = { channelId: "c", threadId: "t", agentId: "theo", runId: "r" };
    let s = applyChannelEvent(emptyStreams, {
      type: "agent.tool",
      ...base,
      tool: "run_code",
      code: { language: "python", source: "print(1)" },
    });
    s = applyChannelEvent(s, { type: "agent.tool.output", ...base, stream: "stdout", text: "1\n" });
    expect(runsInChannel(s, "c")[0]?.code?.source).toBe("print(1)");
    expect(runsInChannel(s, "c")[0]?.output).toEqual([{ stream: "stdout", text: "1\n" }]);
    // The call's list and its run's are one: a chunk's words are appended once, both reading them.
    const live = runsInChannel(s, "c")[0];
    const call = live?.work?.[0];
    expect(call?.kind === "call" ? call.output : null).toBe(live?.output ?? null);
    s = applyChannelEvent(s, { type: "agent.tool", ...base, tool: null });
    expect(runsInChannel(s, "c")[0]?.code?.source).toBe("print(1)");
    s = applyChannelEvent(s, { type: "agent.tool", ...base, tool: "create_issue" });
    expect(runsInChannel(s, "c")[0]?.code).toBeNull();
    expect(runsInChannel(s, "c")[0]?.output).toEqual([]);
  });

  test("the working row: See code opens the code and the live output (stderr in the danger tone)", async () => {
    const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(seedState()) });
    await settle(5);
    const socket = r.sockets.last();
    await act(async () => socket.open());
    const ev = (event: Record<string, unknown>) =>
      act(async () => socket.push({ type: "event", channelId: ENG_ID, event: { channelId: ENG_ID, ...event } }));
    const run = { threadId: null, runId: "r-code", agentId: ADA_ID };
    await ev({ type: "agent.run", ...run, status: "running" });
    await ev({ type: "agent.tool", ...run, tool: "run_code", code: { language: "python", source: "import csv" } });
    await ev({ type: "agent.tool.output", ...run, stream: "stdout", text: "lendo 48 linhas\n" });
    await ev({ type: "agent.tool.output", ...run, stream: "stderr", text: "aviso: coluna vazia" });
    await settle(3);
    expect(document.querySelector(".ac-typing__text")?.textContent).toStartWith("Ada ");
    await click(screen().getByRole("button", { name: "Ver código" }));
    const panel = document.querySelector(".working-tail .live-code") as HTMLElement;
    expect(within(panel).getByLabelText("Código (python)").textContent).toBe("import csv");
    const out = within(panel).getByLabelText("Saída");
    expect(out.querySelector(".live-code__stdout")?.textContent).toBe("lendo 48 linhas\n");
    expect(out.querySelector(".live-code__stderr")?.textContent).toBe("aviso: coluna vazia");
    expect(within(panel).getByRole("button", { name: "Copiar" })).toBeTruthy();
    // Nothing of it over the composer.
    expect(document.querySelector(".channel__composer .live-code")).toBeNull();
  });

  test("between two commands See code stays, open, with the last command; the next one shows its own", async () => {
    const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(seedState()) });
    await settle(5);
    const socket = r.sockets.last();
    await act(async () => socket.open());
    const ev = (event: Record<string, unknown>) =>
      act(async () => socket.push({ type: "event", channelId: ENG_ID, event: { channelId: ENG_ID, ...event } }));
    const run = { threadId: null, runId: "r-code", agentId: ADA_ID };
    await ev({ type: "agent.run", ...run, status: "running" });
    await ev({ type: "agent.tool", ...run, tool: "run_code", code: { language: "bash", source: "ls dados" } });
    await ev({ type: "agent.tool.output", ...run, stream: "stdout", text: "vendas.csv\n" });
    await settle(3);
    await click(screen().getByRole("button", { name: "Ver código" }));
    // The command ends and it thinks: the same button, still open, with that command and its output.
    await ev({ type: "agent.tool", ...run, tool: null });
    await settle(3);
    const hide = screen().getByRole("button", { name: "Esconder código" });
    expect(hide.getAttribute("aria-expanded")).toBe("true");
    const panel = () => document.querySelector(".working-tail .live-code") as HTMLElement;
    expect(within(panel()).getByLabelText("Código (bash)").textContent).toBe("ls dados");
    expect(panel().querySelector(".live-code__stdout")?.textContent).toBe("vendas.csv\n");
    // The next command: its own code, waiting for its output.
    await ev({
      type: "agent.tool",
      ...run,
      tool: "run_code",
      code: { language: "bash", source: "wc -l dados/vendas.csv" },
    });
    await settle(3);
    expect(within(panel()).getByLabelText("Código (bash)").textContent).toBe("wc -l dados/vendas.csv");
    expect(panel().querySelector(".live-code__empty")?.textContent).toBe("Esperando a saída…");
    // Hidden again, it stays hidden.
    await click(screen().getByRole("button", { name: "Esconder código" }));
    expect(panel()).toBeNull();
    expect(screen().getByRole("button", { name: "Ver código" }).getAttribute("aria-expanded")).toBe("false");
  });

  test("the output grows in its line's text node: a chunk appends, and the words read the same", () => {
    const { rerender } = render(<OutputView output={[{ stream: "stdout", text: "a\n" }]} live />);
    const line = document.querySelector(".live-code__stdout") as HTMLElement;
    expect(line.textContent).toBe("a\n");
    const node = line.firstChild as Text;
    const append = node.appendData.bind(node);
    let appends = 0;
    node.appendData = (data: string) => {
      appends++;
      append(data);
    };
    rerender(<OutputView output={[{ stream: "stdout", text: "a\nb\n" }]} live />);
    // Its end grown, not its words written again: the browser shapes the new line alone.
    expect(appends).toBe(1);
    expect(line.textContent).toBe("a\nb\n");
    // At the output's limit the oldest words go too: the line is written again.
    rerender(<OutputView output={[{ stream: "stdout", text: "b\nc\n" }]} live />);
    expect(line.textContent).toBe("b\nc\n");
    rerender(
      <OutputView
        output={[
          { stream: "stdout", text: "b\nc\n" },
          { stream: "stderr", text: "!" },
        ]}
        live
      />,
    );
    expect(line.textContent).toBe("b\nc\n");
    expect(document.querySelector(".live-code__stderr")?.textContent).toBe("!");
  });

  test("the output follows its end, lets go while someone reads further up, and takes it up again at the end", () => {
    const sizes = sizeChanges();
    try {
      const { rerender, unmount } = render(<OutputView output={[{ stream: "stdout", text: "1\n" }]} live />);
      const pre = document.querySelector(".live-code__out") as HTMLElement;
      // Connected: the browser's own anchoring is off, since the follow replaces it.
      expect(pre.style.getPropertyValue("overflow-anchor")).toBe("none");
      const box = measure(pre, 400, 100);
      // A chunk grows the line inside: the end comes into view.
      sizes.grow();
      expect(pre.scrollTop).toBe(300);
      box.height = 500;
      sizes.grow();
      expect(pre.scrollTop).toBe(400);
      // The reader scrolls up: new words no longer pull them along.
      fireEvent.wheel(pre, { deltaY: -1 });
      box.height = 600;
      sizes.grow();
      expect(pre.scrollTop).toBe(400);
      rerender(<OutputView output={[{ stream: "stdout", text: "1\n2\n" }]} live />);
      expect(pre.scrollTop).toBe(400);
      // Back at the end: it follows again.
      pre.scrollTop = 500;
      fireEvent.scroll(pre);
      box.height = 700;
      sizes.grow();
      expect(pre.scrollTop).toBe(600);
      unmount();
      // Gone with its element: no listener of a closed panel moves anything.
      box.height = 900;
      sizes.grow();
      expect(pre.scrollTop).toBe(600);
    } finally {
      sizes.restore();
    }
  });

  test("the end of a run is announced once, and the streaming output is never a live region", async () => {
    // A test before this one may have ended its run a moment ago: let its words land, then start clean.
    await announcedBy();
    announced()?.replaceChildren();
    const output = [{ stream: "stdout" as const, text: "1\n" }];
    const { rerender } = render(<OutputView output={output} live />);
    // The words grow, four times a second: nothing is read out as they land.
    rerender(<OutputView output={[{ stream: "stdout", text: "1\n2\n" }]} live />);
    expect(document.querySelector(".live-code__out")?.parentElement?.getAttribute("aria-live")).toBeNull();
    expect(await announcedBy()).toBe("");
    // Its end is news, said once: a live region added to words already on screen would read nothing at all.
    rerender(<OutputView output={[{ stream: "stdout", text: "1\n2\n" }]} />);
    expect(await announcedBy()).toBe("Saída concluída.");
    // An output that ended empty is finished too.
    rerender(<OutputView output={[{ stream: "stdout", text: "1\n2\n" }]} live />);
    rerender(<OutputView output={[]} />);
    expect(await announcedBy()).toBe("Saída concluída.");
    // An output that was already over when it appeared (a call opened later) is something read, not news.
    announced()?.replaceChildren();
    cleanup();
    render(<OutputView output={output} />);
    expect(await announcedBy()).toBe("");
  });

  test("the work summary shows the code and output after the fact", () => {
    const at = (s: number) => new Date(Date.UTC(2026, 9, 15, 22, 9, s)).toISOString();
    const steps: RunStep[] = [
      {
        seq: 1,
        kind: "tool_call",
        data: { toolUseId: "t1", name: "run_code", input: { code: "print(2)" } },
        createdAt: at(0),
      },
      { seq: 2, kind: "tool_result", data: { toolUseId: "t1", isError: false, content: "2\n" }, createdAt: at(2) },
    ];
    const w = workFromSteps(steps, { createdAt: at(0), finishedAt: at(3) } as Pick<Run, "createdAt" | "finishedAt">);
    expect(w.steps[0]?.code).toEqual({ language: "python", source: "print(2)" });
    expect(w.steps[0]?.output).toEqual([{ stream: "stdout", text: "2\n" }]);
  });
});
