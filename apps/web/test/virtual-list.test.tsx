import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { useVirtualList } from "@/hooks/useVirtualList";

interface Entry {
  id: string;
  text: string;
  height: number;
}

let headerHeight = 100;
const observers: { callback: ResizeObserverCallback; disconnect: () => void }[] = [];
const nativeResizeObserver = globalThis.ResizeObserver;
const nativeRect = HTMLElement.prototype.getBoundingClientRect;

class TestResizeObserver {
  constructor(callback: ResizeObserverCallback) {
    observers.push({ callback, disconnect: () => {} });
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}

function installGeometry() {
  globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;
  HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.classList.contains("shell__main")) {
      return new DOMRect(0, 0, 500, 220);
    }
    if (this.classList.contains("virtual-list")) {
      const scroller = this.closest<HTMLElement>(".shell__main");
      return new DOMRect(0, headerHeight - (scroller?.scrollTop ?? 0), 500, 5000);
    }
    if (this.dataset.virtualHeight) {
      return new DOMRect(0, 0, 500, Number(this.dataset.virtualHeight));
    }
    return nativeRect.call(this);
  };
}

function Harness({ entries: initial }: { entries: Entry[] }) {
  const [entries, setEntries] = useState(initial);
  const { virtual, virtualRows, connectList } = useVirtualList({
    items: entries,
    key: (entry) => entry.id,
    estimate: () => 68,
    findable: (entry) => entry.text,
  });
  instances.push(virtual);
  return (
    <main className="shell__main" style={{ overflowY: "auto" }}>
      <section className="members-page">
        <header>
          <button
            type="button"
            onClick={() => setEntries(entries.map((entry) => ({ ...entry, text: `${entry.text} updated` })))}
          >
            Update rows
          </button>
        </header>
        <ul className="virtual-list" ref={connectList} style={{ position: "relative", height: virtual.size() }}>
          {virtualRows.map((item) => {
            const entry = entries[item.index];
            if (!entry) return null;
            return (
              <li
                key={item.key}
                data-virtual-id={entry.id}
                data-virtual-height={entry.height}
                style={{ position: "absolute", top: item.start, height: entry.height }}
                ref={(element) => virtual.measure(item.index, element)}
              >
                {entry.text}
              </li>
            );
          })}
        </ul>
      </section>
    </main>
  );
}

let instances: ReturnType<typeof useVirtualList<Entry>>["virtual"][] = [];

function currentVirtualizer() {
  const virtual = instances.at(-1);
  if (!virtual) throw new Error("virtual list did not render");
  return virtual;
}

afterEach(() => {
  cleanup();
  globalThis.ResizeObserver = nativeResizeObserver;
  HTMLElement.prototype.getBoundingClientRect = nativeRect;
  headerHeight = 100;
  observers.length = 0;
  instances = [];
});

const entries = (): Entry[] =>
  Array.from({ length: 48 }, (_, index) => ({ id: `row-${index}`, text: `row ${index}`, height: 80 }));

describe("virtual lists", () => {
  test("keep measured heights and the same instance when row data changes", async () => {
    installGeometry();
    const { getByRole, container } = render(<Harness entries={entries()} />);
    const scroller = container.querySelector(".shell__main") as HTMLElement;
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 220 });
    await act(async () => fireEvent.scroll(scroller));

    const before = currentVirtualizer();
    const sizeBefore = before.size();
    const rowBefore = container.querySelector<HTMLElement>('[data-virtual-id="row-4"]')?.style.top;
    await act(async () => fireEvent.click(getByRole("button", { name: "Update rows" })));

    expect(instances.every((instance) => instance === before)).toBe(true);
    expect(before.size()).toBe(sizeBefore);
    expect(container.textContent).toContain("row 4 updated");
    expect(rowBefore).toBe("320px");
    expect(container.querySelector('[data-virtual-id="row-4"]')?.textContent).toContain("updated");
  });

  test("recomputes the visible range when the header grows", async () => {
    installGeometry();
    const { container } = render(<Harness entries={entries()} />);
    const scroller = container.querySelector(".shell__main") as HTMLElement;
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 220 });
    Object.defineProperty(scroller, "scrollTop", { configurable: true, writable: true, value: 1000 });
    await act(async () => fireEvent.scroll(scroller));
    const virtual = currentVirtualizer();
    expect(virtual.items()[0]?.index).toBeGreaterThan(0);

    headerHeight = 800;
    await act(async () => {
      for (const observer of observers) observer.callback([], {} as ResizeObserver);
    });

    expect(virtual.items()[0]?.index).toBe(0);
  });

  test("draws each member separator on its row box so windowing cannot flip it", async () => {
    const css = await Bun.file(
      new URL("../../../packages/ui/src/styles/components.css", import.meta.url).pathname,
    ).text();
    expect(css).toMatch(/\.ac-list__row \{[^}]*border-top: 1px solid var\(--line\);/s);
    expect(css).not.toMatch(/\.ac-list__row \+ \.ac-list__row/);
    expect(css).toMatch(/\.ac-list__row\.members-person\[data-member-index="0"\]/);
  });
});
