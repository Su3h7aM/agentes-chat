/**
 * Run foreground-resume work after the event that brought the window back has
 * returned, the browser has painted one frame, and one more task has had its
 * turn. A single timeout can run before the activating click is delivered; the
 * task -> frame -> task sequence gives WebKit an interaction boundary before
 * query refreshes, reconnects and polling resume. Returns the cancel.
 */
export function scheduleAfterForegroundReady(callback: () => void): () => void {
  if (typeof window === "undefined") {
    callback();
    return () => {};
  }

  let cancelled = false;
  let frameId: number | null = null;
  let trailingTaskId: number | null = null;

  const leadingTaskId = window.setTimeout(() => {
    if (cancelled) return;
    const afterFrame = () => {
      if (cancelled) return;
      trailingTaskId = window.setTimeout(() => {
        if (!cancelled) callback();
      }, 0);
    };
    if (typeof window.requestAnimationFrame === "function") {
      frameId = window.requestAnimationFrame(afterFrame);
    } else {
      afterFrame();
    }
  }, 0);

  return () => {
    cancelled = true;
    window.clearTimeout(leadingTaskId);
    if (frameId !== null && typeof window.cancelAnimationFrame === "function") window.cancelAnimationFrame(frameId);
    if (trailingTaskId !== null) window.clearTimeout(trailingTaskId);
  };
}
