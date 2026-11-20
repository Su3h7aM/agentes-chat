import { type RefObject, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";

/**
 * A box with a `max-height` holds more than it shows, at this width: measured when it lays out and again whenever its
 * content changes size (fonts, pictures, the page's width). While `active` is off (the box shows whole) it keeps its
 * last answer. With `over`, the answer is whether its content is taller than that instead: for a box whose
 * `max-height` depends on the answer, which would otherwise stay cut after its content shrank back under the limit.
 * Once cut, such a box shows whole again only under `under`: content near `over` at one width and under it at another
 * flipped it on every frame when cutting it took the conversation's scrollbar away and widened the column.
 */
export function useOverflows(box: RefObject<HTMLElement | null>, active = true, over?: number, under = over): boolean {
  const [cut, setCut] = useState(false);
  // The last answer given, so a measure that finds the same one sets nothing and the hysteresis reads what was shown.
  const answered = useRef<boolean | undefined>(undefined);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || !active) return;
    const measure = (beforePaint = false) => {
      if (el.checkVisibility?.({ contentVisibilityAuto: true }) === false) return;
      // Once cut, the box shows whole again only under `under`, not `over` (the hysteresis in the doc above).
      const limit = (answered.current ? under : over) ?? el.clientHeight;
      const next = el.scrollHeight > limit + 1;
      if (next === answered.current) return;
      answered.current = next;
      if (beforePaint) flushSync(() => setCut(next));
      else setCut(next);
    };
    // A row off screen is skipped (`content-visibility: auto`) and measuring it lays it out anyway: its observer
    // measures it once it is seen, before that frame paints (`flushSync`). Without `checkVisibility` it is at once.
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const resized = new ResizeObserver(() => measure(true));
    // The box itself while it still grows towards its `max-height`, its first child for what it holds past it.
    resized.observe(el);
    if (el.firstElementChild) resized.observe(el.firstElementChild);
    return () => resized.disconnect();
  }, [box, active, over, under]);
  return cut;
}
