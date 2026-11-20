import { expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, render } from "@testing-library/react";
import { useLayoutEffect, useRef } from "react";
import { useOverflows } from "@/hooks/useOverflows";

test("skipped rows are measured only after becoming visible", async () => {
  const native = globalThis.ResizeObserver;
  let notify = () => {};
  let visible = false;
  let reads = 0;
  globalThis.ResizeObserver = class {
    constructor(callback: ResizeObserverCallback) {
      notify = () => callback([], this as unknown as ResizeObserver);
    }
    observe() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  function Message() {
    const ref = useRef<HTMLDivElement>(null);
    useLayoutEffect(() => {
      const el = ref.current;
      if (!el) return;
      el.checkVisibility = () => visible;
      Object.defineProperty(el, "scrollHeight", {
        get: () => {
          reads++;
          return 200;
        },
      });
    }, []);
    const cut = useOverflows(ref, true, 100);
    return <div ref={ref}>{cut ? "cut" : "whole"}</div>;
  }
  const result = render(<Message />);
  try {
    expect(reads).toBe(0);
    await act(notify);
    expect(reads).toBe(0);
    visible = true;
    await act(notify);
    expect(result.container.textContent).toBe("cut");
  } finally {
    result.unmount();
    globalThis.ResizeObserver = native;
  }
});

test("measures when checkVisibility is unavailable", () => {
  function Message() {
    const ref = useRef<HTMLDivElement>(null);
    useLayoutEffect(() => {
      const el = ref.current;
      if (!el) return;
      Object.defineProperty(el, "checkVisibility", { value: undefined });
      Object.defineProperty(el, "scrollHeight", { value: 200 });
    }, []);
    const cut = useOverflows(ref, true, 100);
    return <div ref={ref}>{cut ? "cut" : "whole"}</div>;
  }
  const result = render(<Message />);
  try {
    expect(result.container.textContent).toBe("cut");
  } finally {
    result.unmount();
  }
});
