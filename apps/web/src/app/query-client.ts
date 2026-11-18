import { ApiError } from "@agenteschat/client";
import { sessionEnded } from "@agenteschat/client/lib/errors";
import { LiveQueryClient } from "@agenteschat/client/lib/live-query-client";
import { focusManager, MutationCache, QueryCache } from "@tanstack/react-query";
import { scheduleAfterForegroundReady } from "@/lib/foreground-ready";

/** This window is the one in use: it shows, and it holds the focus. */
export function appFocused(): boolean {
  return document.visibilityState === "visible" && document.hasFocus();
}

/** TanStack's own check: this tab shows (a window's focus is not its concern alone). */
function bindTabVisibility(setFocused: (focused?: boolean) => void): (() => void) | undefined {
  if (typeof window === "undefined" || !window.addEventListener) return;
  const listener = () => setFocused();
  window.addEventListener("visibilitychange", listener, false);
  return () => window.removeEventListener("visibilitychange", listener);
}

/**
 * React Query's "window focus" is this window's, not just the tab's. For the desktop app only (main.tsx): it keeps a
 * visible window running while another app has the focus, so visibility alone left every refetch interval and every
 * read on return going. A browser tab keeps TanStack's visibility check.
 * Coming back waits a paint first (`scheduleAfterForegroundReady`), so the return is drawn before the refresh work
 * begins. Returns the undo (the tab-visibility check, as without this).
 */
export function bindFocusToWindow(): () => void {
  focusManager.setEventListener((setFocused) => {
    let cancel: (() => void) | null = null;
    const onChange = () => {
      cancel?.();
      cancel = null;
      if (!appFocused()) {
        setFocused(false);
        return;
      }
      cancel = scheduleAfterForegroundReady(() => {
        cancel = null;
        if (appFocused()) setFocused(true);
      });
    };
    onChange();
    window.addEventListener("focus", onChange);
    window.addEventListener("blur", onChange);
    document.addEventListener("visibilitychange", onChange);
    return () => {
      cancel?.();
      window.removeEventListener("focus", onChange);
      window.removeEventListener("blur", onChange);
      document.removeEventListener("visibilitychange", onChange);
    };
  });
  return () => {
    focusManager.setEventListener(bindTabVisibility);
    focusManager.setFocused(undefined);
  };
}

/**
 * Queries show their errors inline; a
 * 401 anywhere means the session ended (back to sign-in); every failed write
 * gets a toast in the person's words.
 */
export function createQueryClient(handlers: {
  onUnauthorized: () => void;
  onMutationError: (message: string) => void;
  /** A failed write in the person's words (`errorText`). */
  describeError: (error: unknown) => string;
}) {
  return new LiveQueryClient({
    defaultOptions: {
      queries: {
        retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 2,
        refetchOnWindowFocus: false,
      },
    },
    queryCache: new QueryCache({
      onError: (error) => {
        if (sessionEnded(error)) handlers.onUnauthorized();
      },
    }),
    mutationCache: new MutationCache({
      onError: (error, _vars, _ctx, mutation) => {
        if (sessionEnded(error)) return handlers.onUnauthorized();
        // Mutations that show their own inline error opt out with `meta: { silent: true }`.
        if (mutation.meta?.silent) return;
        handlers.onMutationError(handlers.describeError(error));
      },
    }),
  });
}
