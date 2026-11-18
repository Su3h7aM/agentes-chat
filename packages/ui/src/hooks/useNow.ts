import { useEffect, useState } from "react";

type SharedTicker = {
  listeners: Set<() => void>;
  intervalId: ReturnType<typeof setInterval>;
};

const tickers = new Map<number, SharedTicker>();

/**
 * One `setInterval` per distinct interval, shared by every subscriber. All
 * same-cadence consumers tick in a single timer callback, so React batches
 * their state updates into one render pass instead of N unaligned passes.
 */
function subscribeToSharedTick(intervalMs: number, listener: () => void): () => void {
  let ticker = tickers.get(intervalMs);
  if (!ticker) {
    const created: SharedTicker = {
      listeners: new Set(),
      intervalId: setInterval(() => {
        for (const tick of created.listeners) tick();
      }, intervalMs),
    };
    tickers.set(intervalMs, created);
    ticker = created;
  }
  ticker.listeners.add(listener);

  return () => {
    ticker.listeners.delete(listener);
    if (ticker.listeners.size === 0) {
      clearInterval(ticker.intervalId);
      tickers.delete(intervalMs);
    }
  };
}

const pageShown = () => typeof document === "undefined" || (!document.hidden && document.visibilityState !== "hidden");

/**
 * The time now, moving on every `every` ms (a countdown, the minutes a request has left); `false`: still. A
 * function picks the pace from the time it last read (a countdown repaints faster near its end). Paused while
 * the tab is hidden; snaps to the fresh time on return.
 */
export function useNow(every: number | false | ((now: number) => number | false)) {
  const [now, setNow] = useState(() => Date.now());
  const ms = typeof every === "function" ? every(now) : every;
  const [visible, setVisible] = useState(pageShown);
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onChange = () => {
      const shown = pageShown();
      if (shown) setNow(Date.now());
      setVisible(shown);
    };
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  useEffect(() => {
    if (ms === false || !visible) return;
    return subscribeToSharedTick(ms, () => setNow(Date.now()));
  }, [ms, visible]);
  return now;
}
