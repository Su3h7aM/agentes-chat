import { createVirtualizer, type VirtualizerOptions } from "@ui-sdk/core";
import { useCallback, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";

interface VirtualListConfig<Item> {
  items: readonly Item[];
  key: (item: Item, index: number) => string;
  estimate: (index: number) => number;
  findable?: (item: Item, index: number) => string;
  keep?: () => readonly number[];
  refreshKey?: unknown;
}

/** A list keeps its measured rows while its data, filter, or copy changes. */
export function useVirtualList<Item>(config: VirtualListConfig<Item>) {
  const configRef = useRef(config);
  const options = useMemo<VirtualizerOptions>(
    () => ({
      count: () => configRef.current.items.length,
      key: (index) => {
        const item = configRef.current.items[index];
        return item === undefined ? "" : configRef.current.key(item, index);
      },
      estimate: (index) => configRef.current.estimate(index),
      overscan: 5,
      scrollMargin: 0,
      findable: (index) => {
        const item = configRef.current.items[index];
        return item === undefined ? "" : (configRef.current.findable?.(item, index) ?? "");
      },
      keep: () => configRef.current.keep?.() ?? [],
    }),
    [],
  );
  const virtual = useMemo(() => createVirtualizer(options), [options]);
  const virtualRows = useSyncExternalStore(virtual.subscribe, virtual.items, virtual.items);

  useLayoutEffect(() => {
    const rowsChanged = configRef.current.items !== config.items;
    const refreshChanged = configRef.current.refreshKey !== config.refreshKey;
    configRef.current = config;
    if (rowsChanged || refreshChanged) virtual.refresh();
  });

  const connectList = useCallback(
    (list: HTMLElement | null) => {
      if (!list) return;
      let scroller: HTMLElement | null = list.parentElement;
      const shellMain = list.closest<HTMLElement>(".shell__main");
      while (scroller && scroller !== shellMain) {
        const overflowY = getComputedStyle(scroller).overflowY;
        if (overflowY === "auto" || overflowY === "scroll") break;
        scroller = scroller.parentElement;
      }
      scroller ??= shellMain;
      if (!scroller) return;
      const activeScroller = scroller;

      const updateMargin = () => {
        const listTop = list.getBoundingClientRect().top;
        const scrollerTop = activeScroller.getBoundingClientRect().top + activeScroller.clientTop;
        options.scrollMargin = listTop - scrollerTop + activeScroller.scrollTop;
        virtual.refresh();
      };
      updateMargin();
      const disconnect = virtual.connect(activeScroller, { findable: true });
      const layoutRoot = list.closest<HTMLElement>(".audit, .members-page") ?? list.parentElement;
      const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updateMargin);
      observer?.observe(layoutRoot ?? list);
      return () => {
        observer?.disconnect();
        disconnect();
      };
    },
    [options, virtual],
  );

  return { virtual, virtualRows, connectList };
}
