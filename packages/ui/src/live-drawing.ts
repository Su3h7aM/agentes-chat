/**
 * The live drawings: agent avatars (agent/live.ts), stickers (agent/sticker-live.ts), engines' and computers'
 * portraits (brain/live.ts, computer/live.ts). Held still, each is drawn once and again when what it shows changes,
 * as with reduced motion.
 *
 * They are held when the desktop app's window paints in software: the Linux app's WebKitGTK without its graphics card
 * path repaints everything over a moving canvas in the CPU, 25 times a second, which keeps a core busy and makes
 * clicks slow. The window says how it paints on <html> before the first drawing (`data-desktop-renderer`, apps/web/src/
 * main.tsx and the stylesheet's own CPU rules in desktop.css). The skies stand still the same way (`holdSkies`,
 * sky/engine.ts).
 */
export const liveDrawingHeld = () =>
  typeof document !== "undefined" && document.documentElement.dataset.desktopRenderer === "cpu";
