/**
 * Real AppImage scrollback validation.
 *
 * Extracts the built AppImage, seeds its own PGlite database with the shared 600-message
 * history, launches the real Tauri/WebKitGTK app through tauri-driver, and drives rapid
 * upward bursts through the real chat scroller. Writes a JSON metrics artifact.
 *
 *   bun apps/desktop/scripts/scroll-validation-gui.ts [--appimage <path>]
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createDiskBlobStore } from "@agenteschat/adapters";
import { createDatabase, pgliteUrl, schema } from "@agenteschat/db";
import { type Family, MESSAGES, seedHistory } from "../../server/test/scroll-validation-seed";

const REPO = resolve(import.meta.dir, "../../..");
/** A rapid but realistic upward fling: ~12,000 px/s at 60 fps, not a teleport. */
const BURST_STEP = 200;
const BURST_FRAMES = 10;
const BURSTS = 40;
const DEFAULT_APPIMAGE =
  "/home/su3h7am/Projects/agentes-chat/apps/desktop/src-tauri/target/release/bundle/appimage/agentes_0.8.14+a60bb1615_amd64.AppImage";
const WORK = join(REPO, ".scroll-validation");
const OUT = join(REPO, "scroll-validation-results");
const TAURI_DRIVER = process.env.TAURI_DRIVER ?? join(process.env.HOME ?? "", ".local/share/cargo/bin/tauri-driver");

const argv = process.argv.slice(2);
const argValue = (name: string) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};
const appimage = resolve(argValue("--appimage") || process.env.SCROLL_APPIMAGE || DEFAULT_APPIMAGE);
const webDir = argValue("--web-dir") ? resolve(argValue("--web-dir") as string) : null;
const cssFile = argValue("--css") ? resolve(argValue("--css") as string) : null;
const cpu = argv.includes("--cpu");
const diagnosticsMode = argValue("--diagnostics") === "low" ? "low" : "full";
const NETWORK_PROFILES = {
  none: { delayMs: 0, jitterMs: 0, bandwidthKbps: 0, loss: 0, retryMs: 0 },
  "3g": { delayMs: 150, jitterMs: 20, bandwidthKbps: 700, loss: 0.01, retryMs: 800 },
  degraded: { delayMs: 350, jitterMs: 50, bandwidthKbps: 250, loss: 0.05, retryMs: 1200 },
} as const;
type NetworkName = keyof typeof NETWORK_PROFILES;
const networkName = (argValue("--network") ?? "none") as NetworkName;
if (!(networkName in NETWORK_PROFILES)) {
  throw new Error(`--network must be none, 3g or degraded (got ${networkName})`);
}
const network = NETWORK_PROFILES[networkName];
const family = (argValue("--family") ?? "mixed") as Family;
if (!["mixed", "text", "cards", "media", "refs"].includes(family)) {
  throw new Error(`--family must be mixed, text, cards, media or refs (got ${family})`);
}
const seedMessages = family === "mixed" ? MESSAGES : 300;
const deadline = (ms: number) => Date.now() + ms;
const sleep = (ms: number) => Bun.sleep(ms);

let driver: ReturnType<typeof Bun.spawn> | null = null;
let sessionId: string | null = null;
const started = Date.now();

function log(line: string) {
  console.log(`[scroll-gui ${((Date.now() - started) / 1000).toFixed(1)}s] ${line}`);
}

async function run(command: string[], options: { cwd?: string; env?: Record<string, string> } = {}) {
  const child = Bun.spawn(command, {
    cwd: options.cwd ?? REPO,
    env: options.env ?? process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`${command[0]} exited ${code}\n${stdout}\n${stderr}`);
  return { stdout, stderr, code };
}

async function waitFor<T>(label: string, ms: number, check: () => Promise<T | null>): Promise<T> {
  const until = deadline(ms);
  let lastError: unknown = null;
  while (Date.now() < until) {
    try {
      const value = await check();
      if (value !== null) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw new Error(`${label} timed out after ${ms}ms${lastError ? `: ${String(lastError)}` : ""}`);
}

async function freePort(start = 4530): Promise<number> {
  for (let port = start; port <= 4579; port++) {
    try {
      const socket = await Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {} } });
      socket.end();
    } catch {
      return port;
    }
  }
  throw new Error("no free port for the AppImage server");
}

function appDirs(root: string) {
  return {
    root,
    run: join(root, "AppRun"),
    runner: join(root, "usr/bin/agentes-runner"),
    native: join(root, "usr/lib/agentes.chat/server/native.js"),
    lib: join(root, "usr/lib"),
    pkg: join(root, "usr/lib/agentes.chat"),
  };
}

function serverEnv(home: string, root: string): Record<string, string> {
  const dirs = appDirs(root);
  return {
    HOME: home,
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    BUN_BE_BUN: "1",
    LD_LIBRARY_PATH: `${dirs.lib}:${dirs.pkg}`,
    DISPLAY: process.env.DISPLAY || ":0",
  };
}

const DRIVER_SCRIPT = String.raw`
if (!window.__sv) {
  const scroller = document.querySelector('.channel__messages');
  if (!scroller) throw new Error('chat scroller is missing');
  const MODE = '${diagnosticsMode}';
  const pages = [];
  const errors = [];
  const rowAdds = new Map();
  const diagnostics = { writes: [], resizes: [], scrolls: [], added: [], removed: [], rowCount: 0 };
  const NETWORK = ${JSON.stringify(network)};
  const NETWORK_NAME = '${networkName}';
  let drawnAdds = 0;
  let drawnRemoves = 0;
  const layoutProbes = [];
  let networkLosses = 0;
  let networkBytes = 0;
  let networkWaitMs = 0;
  let offline = false;
  let probing = false;
  const wait = (ms) => new Promise((done) => setTimeout(done, ms));
  const scrollTopProperty = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
  if (MODE === 'full') {
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      get() { return scrollTopProperty.get.call(scroller); },
      set(value) {
        const from = scrollTopProperty.get.call(scroller);
        if (Math.abs(value - from) > 20) {
          diagnostics.writes.push({ from, to: value, at: performance.now(), stack: new Error().stack });
        }
        scrollTopProperty.set.call(scroller, value);
      },
    });
    scroller.addEventListener('scroll', () => {
      diagnostics.scrolls.push({
        at: performance.now(),
        top: scroller.scrollTop,
        height: scroller.scrollHeight,
        loading: Boolean(document.querySelector('.channel__older')),
      });
    }, { passive: true });
  }
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const url = String(args[0]?.url ?? args[0]);
    const older = url.includes('/messages?') && url.includes('before=');
    const record = { url, start: performance.now(), end: null, ids: [], status: null, error: null, networkMs: 0 };
    const waitForNetwork = async (ms) => {
      const delay = Math.max(0, Math.round(ms));
      record.networkMs += delay;
      networkWaitMs += delay;
      await wait(delay);
    };
    try {
      if (older && offline) {
        record.error = 'offline';
        record.end = performance.now();
        if (!probing) pages.push(record);
        throw new TypeError('network offline');
      }
      if (older && NETWORK.delayMs > 0) {
        await waitForNetwork(NETWORK.delayMs + (Math.random() * 2 - 1) * NETWORK.jitterMs);
        if (Math.random() < NETWORK.loss) {
          networkLosses += 1;
          await waitForNetwork(NETWORK.retryMs);
        }
      }
      const response = await originalFetch(...args);
      if (older) {
        record.status = response.status;
        let data = null;
        try {
          data = await response.clone().json();
          record.ids = (data.messages || []).map((m) => m.id);
        } catch (error) {
          record.error = String(error);
        }
        if (NETWORK.bandwidthKbps > 0) {
          const declared = Number(response.headers.get('content-length') || 0);
          const bytes = declared || new TextEncoder().encode(JSON.stringify(data ?? {})).length;
          networkBytes += bytes;
          await waitForNetwork((bytes * 8) / (NETWORK.bandwidthKbps * 1000) * 1000);
        }
        record.end = performance.now();
        if (!probing) pages.push(record);
      }
      return response;
    } catch (error) {
      if (older) {
        record.error = String(error);
        record.end = performance.now();
        if (!probing) pages.push(record);
      }
      throw error;
    }
  };
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue;
        const rows = node.matches('.ac-msg[data-message-id]')
          ? [node]
          : [...(node.querySelectorAll?.('.ac-msg[data-message-id]') ?? [])];
        for (const row of rows) {
          const id = row.getAttribute('data-message-id');
          if (id && !rowAdds.has(id)) rowAdds.set(id, performance.now());
          if (MODE === 'full' && id) diagnostics.added.push({ id, at: performance.now() });
        }
        diagnostics.rowCount += rows.length;
      }
      for (const node of record.removedNodes) {
        if (!(node instanceof Element)) continue;
        const rows = node.matches('.ac-msg[data-message-id]')
          ? [node]
          : [...(node.querySelectorAll?.('.ac-msg[data-message-id]') ?? [])];
        if (MODE === 'full') {
          for (const row of rows) diagnostics.removed.push({ id: row.getAttribute('data-message-id'), at: performance.now() });
        }
        diagnostics.rowCount -= rows.length;
      }
    }
  });
  window.addEventListener('error', (event) => {
    errors.push({ kind: 'error', message: String(event.message), stack: String(event.error?.stack ?? '') });
  });
  window.addEventListener('unhandledrejection', (event) => {
    errors.push({ kind: 'rejection', message: String(event.reason), stack: String(event.reason?.stack ?? '') });
  });
  observer.observe(scroller, { childList: true, subtree: true });
  diagnostics.rowCount = scroller.querySelectorAll('.ac-msg[data-message-id]').length;
  if (MODE === 'full') {
    new MutationObserver((records) => {
      const at = performance.now();
      void scroller.offsetHeight;
      layoutProbes.push({ at, ms: performance.now() - at, changes: records.length });
    }).observe(scroller, {
      subtree: true,
      attributes: true,
      attributeFilter: ['data-drawn'],
    });
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.oldValue === null) drawnAdds += 1;
        else drawnRemoves += 1;
      }
    }).observe(scroller, {
      subtree: true,
      attributes: true,
      attributeFilter: ['data-drawn'],
      attributeOldValue: true,
    });
    const rowHeights = new WeakMap();
    const rowObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const row = entry.target;
        if (!(row instanceof Element) || !row.matches('.ac-msg[data-message-id]')) continue;
        const height = row.offsetHeight;
        const before = rowHeights.get(row);
        if (before !== undefined && before !== height) {
          diagnostics.resizes.push({
            id: row.getAttribute('data-message-id'),
            before,
            after: height,
            at: performance.now(),
            top: row.getBoundingClientRect().top - scroller.getBoundingClientRect().top,
          });
        }
        rowHeights.set(row, height);
      }
    });
    for (const row of scroller.querySelectorAll('.ac-msg[data-message-id]')) rowObserver.observe(row);
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue;
          const rows = node.matches('.ac-msg[data-message-id]')
            ? [node]
            : [...(node.querySelectorAll?.('.ac-msg[data-message-id]') ?? [])];
          for (const row of rows) rowObserver.observe(row);
        }
      }
    }).observe(scroller, { childList: true });
  }
  const firstVisibleRow = () => {
    const box = scroller.getBoundingClientRect();
    const x = box.left + box.width / 2;
    for (const y of [box.top + 8, box.top + box.height / 2, box.bottom - 8]) {
      for (const element of document.elementsFromPoint(x, y)) {
        const row = element.closest?.('.ac-msg[data-message-id]');
        if (row) return row;
      }
    }
    return scroller.querySelector('.ac-msg[data-message-id]');
  };
  const reconnectProbe = async () => {
    const url = pages.at(-1)?.url;
    if (!url) return { available: false, reason: 'no older-page request' };
    const start = performance.now();
    let offlineFailed = false;
    probing = true;
    try {
      offline = true;
      try {
        await fetch(url);
      } catch {
        offlineFailed = true;
      }
      offline = false;
      let recovered = false;
      let status = null;
      let error = null;
      try {
        const response = await fetch(url);
        status = response.status;
        recovered = response.ok;
      } catch (failure) {
        error = String(failure);
      }
      return {
        available: true,
        offlineFailed,
        recovered,
        status,
        ms: Math.round(performance.now() - start),
        error,
      };
    } finally {
      offline = false;
      probing = false;
    }
  };
  window.__sv = {
    pages,
    rowAdds,
    scroller,
    firstVisibleRow,
    reconnectProbe,
    busy: false,
    burst: async ({ step = 700, frames = 6 } = {}) => {
      if (window.__sv.busy) throw new Error('a burst is already running');
      window.__sv.busy = true;
      const before = Date.now();
      const frameData = [];
      const cadence = [];
      let sampling = true;
      let lastFrame = 0;
      const sampleFrames = (t) => {
        if (!sampling) return;
        if (lastFrame) cadence.push(t - lastFrame);
        lastFrame = t;
        requestAnimationFrame(sampleFrames);
      };
      requestAnimationFrame(sampleFrames);
      try {
        for (let frame = 0; frame < frames; frame++) {
          const t0 = performance.now();
          drawnAdds = 0;
          drawnRemoves = 0;
          const scrollBefore = scroller.scrollTop;
          // The event only marks an upward gesture for the app. The scroll distance comes from scrollTop below,
          // so no deferred wheel/default scroll can leak into the next settle window.
          scroller.dispatchEvent(
            new WheelEvent('wheel', { deltaY: -1, bubbles: true, cancelable: true }),
          );
          scroller.scrollTop = Math.max(0, scroller.scrollTop - Math.abs(step));
          await new Promise((done) => requestAnimationFrame(done));
          // Let ResizeObserver and the anchor correction run before the sample: measure the visible frame.
          await new Promise((done) => requestAnimationFrame(done));
          const t1 = performance.now();
          const scrollAfter = scroller.scrollTop;
          const scrollDelta = scrollAfter - scrollBefore;
          frameData.push({
            at: t1,
            t: t1,
            dt: t1 - t0,
            scrollTop: scrollAfter,
            scrollHeight: scroller.scrollHeight,
            scrollDelta,
            rows: diagnostics.rowCount,
            drawnRows: MODE === 'full' ? scroller.querySelectorAll('[data-drawn]').length : 0,
            drawnAdds: MODE === 'full' ? drawnAdds : 0,
            drawnRemoves: MODE === 'full' ? drawnRemoves : 0,
            loading: Boolean(document.querySelector('.channel__older')),
          });
        }
      } finally {
        sampling = false;
        window.__sv.busy = false;
      }
      // Read the row the gesture ended on before any quiet wait: late draw-ahead layout must be measured, not adopted.
      const anchorRow = firstVisibleRow();
      const anchorBox = scroller.getBoundingClientRect();
      const anchor = anchorRow
        ? {
            id: anchorRow.getAttribute('data-message-id'),
            top: anchorRow.getBoundingClientRect().top - anchorBox.top,
          }
        : null;
      return { ms: Date.now() - before, frames: frameData, cadence, anchor };
    },
    settle: async (timeout = 2500, baseline = null) => {
      const start = performance.now();
      let lastBusy = start;
      let anchorRow = baseline?.id
        ? [...scroller.querySelectorAll('.ac-msg[data-message-id]')].find(
            (row) => row.getAttribute('data-message-id') === baseline.id,
          )
        : firstVisibleRow();
      if (baseline?.id && !anchorRow) throw new Error('settle baseline row is missing');
      const box = scroller.getBoundingClientRect();
      const anchor = anchorRow
        ? {
            id: anchorRow.getAttribute('data-message-id'),
            top: baseline ? baseline.top : anchorRow.getBoundingClientRect().top - box.top,
          }
        : null;
      let maxDisplacement = 0;
      let maxAt = 0;
      let loadingSeen = false;
      const startScrollTop = scroller.scrollTop;
      const startScrollHeight = scroller.scrollHeight;
      const scrollEvents = [];
      const onScroll = () => scrollEvents.push({ at: performance.now() - start, top: scroller.scrollTop });
      if (MODE === 'full') scroller.addEventListener('scroll', onScroll, { passive: true });
      const diagStart = performance.now();
      const finish = (result) => {
        scroller.removeEventListener('scroll', onScroll);
        if (MODE === 'low' && anchor) {
          const top = anchorRow?.isConnected
            ? anchorRow.getBoundingClientRect().top - box.top
            : anchor.top;
          maxDisplacement = Math.abs(top - anchor.top);
          maxAt = performance.now() - start;
        }
        return {
          ...result,
          maxDisplacement,
          maxAt,
          scrollEvents: scrollEvents.slice(-40),
          diagnostics: MODE === 'full'
            ? {
                writes: diagnostics.writes.filter((w) => w.at >= diagStart).slice(-20),
                resizes: diagnostics.resizes.filter((r) => r.at >= diagStart).slice(-30),
                scrolls: diagnostics.scrolls.filter((s) => s.at >= diagStart).slice(-40),
                added: diagnostics.added.filter((a) => a.at >= diagStart).slice(-60),
                removed: diagnostics.removed.filter((a) => a.at >= diagStart).slice(-30),
              }
            : { writes: [], resizes: [], scrolls: [], added: [], removed: [] },
        };
      };
      while (performance.now() - start <= timeout) {
        const loading = Boolean(document.querySelector('.channel__older'));
        if (loading) loadingSeen = true;
        if (MODE === 'full' && anchor) {
          if (!anchorRow?.isConnected) anchorRow = firstVisibleRow();
          if (anchorRow) {
            const top = anchorRow.getBoundingClientRect().top - box.top;
            const drift = Math.abs(top - anchor.top);
            if (drift > maxDisplacement) {
              maxDisplacement = drift;
              maxAt = performance.now() - start;
            }
          }
        }
        if (!loading && performance.now() - lastBusy > 200) {
          return finish({
            ms: performance.now() - start,
            loading: false,
            maxDisplacement,
            maxAt,
            loadingSeen,
            anchor: anchor?.id ?? null,
            startScrollTop,
            endScrollTop: scroller.scrollTop,
            startScrollHeight,
            endScrollHeight: scroller.scrollHeight,
          });
        }
        if (loading) lastBusy = performance.now();
        await new Promise((done) => requestAnimationFrame(done));
      }
      return finish({
        ms: performance.now() - start,
        loading: Boolean(document.querySelector('.channel__older')),
        maxDisplacement,
        maxAt,
        loadingSeen,
        anchor: anchor?.id ?? null,
        startScrollTop,
        endScrollTop: scroller.scrollTop,
        startScrollHeight,
        endScrollHeight: scroller.scrollHeight,
      });
    },
    snapshot: () => ({
      scrollTop: scroller.scrollTop,
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight,
      loading: Boolean(document.querySelector('.channel__older')),
      ids: [...scroller.querySelectorAll('.ac-msg[data-message-id]')].map((row) =>
        row.getAttribute('data-message-id'),
      ),
      drawnRows: scroller.querySelectorAll('[data-drawn]').length,
      network: {
        profile: NETWORK_NAME,
        delayMs: NETWORK.delayMs,
        jitterMs: NETWORK.jitterMs,
        bandwidthKbps: NETWORK.bandwidthKbps,
        loss: NETWORK.loss,
        losses: networkLosses,
        bytes: networkBytes,
        waitMs: Math.round(networkWaitMs),
      },
      pages: window.__sv.pages.map((page) => {
        const additions = page.ids.map((id) => rowAdds.get(id)).filter((t) => t !== undefined);
        return {
          url: page.url,
          status: page.status,
          start: page.start,
          end: page.end,
          networkMs: page.networkMs,
          ids: page.ids,
          admissionMs: page.end === null || additions.length === 0 ? null : Math.min(...additions) - page.end,
          firstAdd: additions.length === 0 ? null : Math.min(...additions),
          lastAdd: additions.length === 0 ? null : Math.max(...additions),
        };
      }),
      errors,
      layoutProbes,
    }),
    resetStartupBaseline: () => {
      // Drop startup/first-transition layout and scroll-write maxima so only
      // scrolling after the initial full page is measured. Pages, row
      // admission times, errors, and network counters are preserved.
      layoutProbes.length = 0;
      diagnostics.writes.length = 0;
      diagnostics.resizes.length = 0;
      diagnostics.scrolls.length = 0;
      diagnostics.added.length = 0;
      diagnostics.removed.length = 0;
      return true;
    },
  };
}
return true;
`;

async function webdriver<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${driverPort}${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  const json = (await response.json()) as { value: T | { error?: string; message?: string } };
  if (!response.ok || (json.value && typeof json.value === "object" && "error" in json.value && json.value.error)) {
    const failure = json.value as { error?: string; message?: string };
    throw new Error(`WebDriver ${method} ${path}: ${failure.error ?? response.status} ${failure.message ?? ""}`);
  }
  return json.value;
}

let driverPort = 0;

async function execute(script: string, args: unknown[] = []): Promise<unknown> {
  if (!sessionId) throw new Error("no WebDriver session");
  return webdriver("POST", `/session/${sessionId}/execute/sync`, { script, args });
}

async function executeAsync(script: string, args: unknown[] = []): Promise<unknown> {
  if (!sessionId) throw new Error("no WebDriver session");
  return webdriver("POST", `/session/${sessionId}/execute/async`, { script, args });
}

async function handles(): Promise<string[]> {
  if (!sessionId) throw new Error("no WebDriver session");
  return (await webdriver<string[]>("GET", `/session/${sessionId}/window/handles`)) ?? [];
}

async function useHandle(handle: string) {
  if (!sessionId) throw new Error("no WebDriver session");
  await webdriver("POST", `/session/${sessionId}/window`, { handle });
}

/** Clicks through the AppImage's real first-run panel for a folder that already holds its owner key. */
async function setupLocalApp(serverUrl: string) {
  let clicked = false;
  await waitFor("the AppImage setup window", 60_000, async () => {
    for (const handle of await handles()) {
      await useHandle(handle);
      const state = (await execute("return { url: location.href, text: document.body?.innerText || '' };")) as {
        url: string;
        text: string;
      };
      if (state.url.startsWith(serverUrl)) return true;
      if (clicked) continue;
      // Each stage is polled on its own: after "On this computer" the first
      // screen is gone, so re-checking for it would stall. Check the owner
      // form first so a re-poll after the earlier clicks lands here.
      const startReady = (await execute(
        `return {
          inputs: document.querySelectorAll('input').length,
          start: Boolean(
            [...document.querySelectorAll('button')].find((x) => x.innerText.trim() === 'Start'),
          ),
        };`,
      )) as { inputs: number; start: boolean };
      if (startReady.start && startReady.inputs >= 2) {
        await execute(
          String.raw`
            const inputs = [...document.querySelectorAll('input')];
            const set = (input, value) => {
              const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
              setter.call(input, value);
              input.dispatchEvent(new Event('input', { bubbles: true }));
            };
            set(inputs[0], 'Marina');
            set(inputs[1], 'scroll@example.com');
            const start = [...document.querySelectorAll('button')].find((x) => x.innerText.trim() === 'Start');
            if (!start) throw new Error('Start is missing');
            start.click();
            return true;
          `,
        );
        clicked = true;
        log("started the AppImage local setup");
        return true;
      }
      const buttons = (await execute(
        `return [...document.querySelectorAll('button')].map((x) => x.innerText);`,
      )) as string[];
      if (buttons.some((text) => text.includes("Get this computer ready"))) {
        await execute(
          'const b = [...document.querySelectorAll("button")].find((x) => x.innerText.includes("Get this computer ready")); if (!b) throw new Error("Get this computer ready is missing"); b.click(); return true;',
        );
        return null;
      }
      if (
        state.text.includes("Where will your workspace live?") &&
        buttons.some((text) => text.includes("On this computer"))
      ) {
        await execute(
          'const b = [...document.querySelectorAll("button")].find((x) => x.innerText.includes("On this computer")); if (!b) throw new Error("On this computer is missing"); b.click(); return true;',
        );
        return null;
      }
    }
    return null;
  });
}

async function main() {
  mkdirSync(WORK, { recursive: true });
  mkdirSync(OUT, { recursive: true });
  const extract = join(WORK, "extract");
  const home = join(WORK, "home");
  const data = join(home, ".agentes");
  // `--appimage-extract` unpacks to `squashfs-root` (older notes said `AppDir`).
  const extractCandidates = [join(extract, "squashfs-root"), join(extract, "AppDir")];

  log(`extracting ${appimage}`);
  rmSync(extract, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  mkdirSync(extract, { recursive: true });
  mkdirSync(join(home, ".agentes"), { recursive: true });
  await run([appimage, "--appimage-extract"], { cwd: extract, env: { HOME: home, PATH: process.env.PATH ?? "" } });
  const root = extractCandidates.find((candidate) => existsSync(join(candidate, "AppRun")));
  if (!root) {
    throw new Error(`unexpected AppImage layout: no AppRun under ${extractCandidates.join(" or ")}`);
  }
  const dirs = appDirs(root);
  if (!existsSync(dirs.runner) || !existsSync(dirs.native)) {
    throw new Error(`unexpected AppImage layout at ${dirs.root}`);
  }
  if (webDir) {
    if (!existsSync(join(webDir, "index.html"))) throw new Error(`--web-dir has no index.html: ${webDir}`);
    const target = join(dirs.pkg, "web");
    rmSync(target, { recursive: true, force: true });
    cpSync(webDir, target, { recursive: true });
    log(`overlaid the local web build from ${webDir}`);
  }

  const port = await freePort();
  const ownerKey = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  writeFileSync(join(data, "owner-key"), ownerKey, { mode: 0o600 });
  writeFileSync(
    join(data, ".env"),
    [
      `PORT=${port}`,
      `PUBLIC_URL=http://127.0.0.1:${port}`,
      `AGENTES_SECRET=${Buffer.from(crypto.getRandomValues(new Uint8Array(48))).toString("base64")}`,
      "TELEMETRY=off",
      "FEEDBACK_RELAY=false",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );

  log("migrating the AppImage database");
  await run([dirs.runner, dirs.native, "migrate", "--data", data], { env: serverEnv(home, dirs.root) });

  log("seeding the AppImage database");
  const database = createDatabase({ url: pgliteUrl(join(data, "db")), poolMax: 1 });
  const userId = `user_owner_${crypto.randomUUID().slice(0, 8)}`;
  const orgId = crypto.randomUUID();
  const channelId = crypto.randomUUID();
  const adaId = crypto.randomUUID();
  const atlasId = crypto.randomUUID();
  let seededIds: string[] = [];
  try {
    await database.db.insert(schema.users).values({
      id: userId,
      name: "Marina",
      email: "scroll@example.com",
      locale: "en",
    });
    await database.db.insert(schema.organizations).values({ id: orgId, name: "Scroll Lab" });
    await database.db.insert(schema.organizationMembers).values({ orgId, userId, role: "owner", handle: "marina" });
    await database.db
      .insert(schema.channels)
      .values({ id: channelId, orgId, name: "general", createdByUserId: userId });
    await database.db.insert(schema.channelMembers).values({ orgId, channelId, userId });
    await database.db.insert(schema.agents).values([
      {
        id: adaId,
        orgId,
        name: "Ada",
        handle: "ada",
        role: "Engineer",
        instructions: "You keep the rollout stable.",
        model: "claude-sonnet-5-5",
        ownerUserId: userId,
      },
      {
        id: atlasId,
        orgId,
        name: "Atlas",
        handle: "atlas",
        role: "Operations",
        instructions: "You watch the deployment queue.",
        model: "claude-sonnet-5-5",
        ownerUserId: userId,
      },
    ]);
    await database.db.insert(schema.channelMembers).values([
      { orgId, channelId, agentId: adaId },
      { orgId, channelId, agentId: atlasId },
    ]);
    const blobs = createDiskBlobStore(join(data, "files"));
    const seed = await seedHistory(
      database.db,
      { orgId, channelId, userId, adaId, atlasId },
      blobs,
      seedMessages,
      family,
    );
    seededIds = seed.seeded.map((message) => message.id);
  } finally {
    await database.close();
  }

  // The extracted AppRun launches directly: tauri-driver inherits this
  // process's environment for the app, so no temporary wrapper script is
  // needed (and none is left behind in WORK).
  const appEnv: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local/share"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_RUNTIME_DIR: join(home, "run"),
    DISPLAY: process.env.DISPLAY || ":0",
    GDK_BACKEND: "x11",
    ...(cpu
      ? {
          WEBKIT_DISABLE_DMABUF_RENDERER: "1",
          WEBKIT_DISABLE_COMPOSITING_MODE: "1",
          LIBGL_ALWAYS_SOFTWARE: "1",
        }
      : {}),
  };
  delete appEnv.WAYLAND_DISPLAY;
  mkdirSync(join(home, "run"), { recursive: true, mode: 0o700 });

  driverPort = await freePort(port + 2);
  log(`starting tauri-driver on ${driverPort}`);
  driver = Bun.spawn([TAURI_DRIVER, "--port", String(driverPort), "--native-port", String(driverPort + 1)], {
    env: appEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  await waitFor("tauri-driver status", 20_000, async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${driverPort}/status`, { signal: AbortSignal.timeout(2000) });
      return response.ok ? true : null;
    } catch {
      return null;
    }
  });

  const created = await webdriver<{ sessionId: string }>("POST", "/session", {
    capabilities: {
      alwaysMatch: {
        browserName: "wry",
        "tauri:options": cpu ? { application: dirs.run, args: ["--compatibility-mode"] } : { application: dirs.run },
      },
    },
  });
  sessionId = created.sessionId;
  log(`session ${sessionId}`);

  const serverUrl = `http://127.0.0.1:${port}`;
  await setupLocalApp(serverUrl);
  const target = await waitFor("the AppImage server window", 180_000, async () => {
    for (const handle of await handles()) {
      await useHandle(handle);
      const state = (await execute(
        "return { url: location.href, desktop: Boolean(window.__agentesDesktop), text: document.body?.innerText?.slice(0, 120) || '' };",
      )) as { url: string; desktop: boolean; text: string };
      if (state.url.startsWith(serverUrl) && !state.url.includes("/desktop/handover")) return { handle, ...state };
    }
    return null;
  });
  log(`main window: ${target.url}`);
  if (!target.desktop) throw new Error("the desktop bridge is missing on the AppImage page");
  const desktop = (await execute("return window.__agentesDesktop ?? null;")) as {
    renderer?: string;
    platform?: string;
    system?: unknown;
  } | null;
  log(`renderer=${desktop?.renderer ?? "unknown"} platform=${desktop?.platform ?? "unknown"}`);

  const chatUrl = `${serverUrl}/org/${orgId}/c/${channelId}`;
  const navStart = Date.now();
  await execute(`location.href = ${JSON.stringify(chatUrl)}; return true;`);
  let lastUrl = "";
  try {
    await waitFor("chat navigation", 120_000, async () => {
      try {
        lastUrl = await webdriver<string>("GET", `/session/${sessionId}/url`);
        return lastUrl.startsWith(chatUrl) ? true : null;
      } catch {
        return null;
      }
    });
  } catch (error) {
    let page: unknown = null;
    try {
      page = await execute(
        "return { url: location.href, title: document.title, text: document.body?.innerText?.slice(0, 300) || '' };",
      );
    } catch (readError) {
      page = { error: String(readError) };
    }
    throw new Error(
      `${error instanceof Error ? error.message : String(error)} (last URL: ${lastUrl}; page: ${JSON.stringify(page)})`,
    );
  }
  const visible = (await executeAsync(
    String.raw`
      const done = arguments[arguments.length - 1];
      const deadline = Date.now() + 60000;
      const check = () => {
        const scroller = document.querySelector('.channel__messages');
        const row = scroller?.querySelector('.ac-msg[data-message-id]');
        if (row) {
          done({
            ok: true,
            scrollTop: scroller.scrollTop,
            rows: scroller.querySelectorAll('.ac-msg[data-message-id]').length,
          });
          return;
        }
        if (Date.now() > deadline) {
          done({ ok: false, error: 'first message timeout', url: location.href, text: document.body.innerText.slice(0, 400) });
          return;
        }
        requestAnimationFrame(check);
      };
      check();
    `,
  )) as { ok: boolean; error?: string; text?: string; scrollTop?: number; rows?: number };
  if (!visible.ok) throw new Error(`chat did not paint: ${visible.error} ${visible.text ?? ""}`);
  const firstVisibleMs = Date.now() - navStart;
  log(`first visible row in ${firstVisibleMs}ms (${visible.rows} rows)`);

  await execute(DRIVER_SCRIPT);
  if (cssFile) {
    const css = readFileSync(cssFile, "utf8");
    await execute(
      `const style = document.createElement('style'); style.dataset.scrollValidation = ''; style.textContent = ${JSON.stringify(css)}; document.head.append(style); return true;`,
    );
    log(`injected ${cssFile}`);
  }
  // Startup gate (profiling): wait for the initial full page before bursts so
  // startup/first-transition maxima are never attributed to scrolling.
  const expectedInitialRows = Math.min(seedMessages, 100);
  await waitFor("initial full page", 120_000, async () => {
    const state = (await execute(
      "return { rows: window.__sv.scroller.querySelectorAll('.ac-msg[data-message-id]').length, loading: Boolean(document.querySelector('.channel__older')) };",
    )) as { rows: number; loading: boolean };
    return state.rows >= expectedInitialRows && !state.loading ? true : null;
  });
  await executeAsync(
    `
      const done = arguments[arguments.length - 1];
      requestAnimationFrame(() => requestAnimationFrame(() => done(true)));
    `,
  );
  await executeAsync(`const done = arguments[arguments.length - 1]; window.__sv.settle(2500).then(() => done(true));`);
  await execute("window.__sv.resetStartupBaseline(); return true;");
  log(`initial full page ready (>=${expectedInitialRows} rows, settled)`);
  const burstResults: {
    ms: number;
    cadence: number[];
    anchor: { id: string | null; top: number } | null;
    frames: {
      at: number;
      dt: number;
      scrollTop: number;
      scrollHeight: number;
      scrollDelta: number;
      rows: number;
      drawnRows: number;
      drawnAdds: number;
      drawnRemoves: number;
      loading: boolean;
    }[];
  }[] = [];
  const settleResults: {
    ms: number;
    loading: boolean;
    maxDisplacement: number;
    maxAt: number;
    loadingSeen: boolean;
    anchor: string | null;
    startScrollTop: number;
    endScrollTop: number;
    startScrollHeight: number;
    endScrollHeight: number;
    scrollEvents: { at: number; top: number }[];
  }[] = [];
  for (let i = 0; i < BURSTS; i++) {
    const burst = (await executeAsync(
      `const done = arguments[arguments.length - 1]; window.__sv.burst({ step: ${BURST_STEP}, frames: ${BURST_FRAMES} }).then((r) => done(r));`,
    )) as (typeof burstResults)[number];
    burstResults.push(burst);
    await sleep(250);
    const settled = (await executeAsync(
      `const done = arguments[arguments.length - 1]; window.__sv.settle(2500, ${JSON.stringify(burst.anchor)}).then((r) => done(r));`,
    )) as (typeof settleResults)[number];
    settleResults.push(settled);
  }
  // One more upward gesture at the top requests the empty page.
  const finalBurst = (await executeAsync(
    `const done = arguments[arguments.length - 1]; window.__sv.scroller.scrollTop = 0; window.__sv.burst({ step: ${BURST_STEP}, frames: 2 }).then((r) => done(r));`,
  )) as (typeof burstResults)[number];
  await sleep(300);
  const finalSettle = (await executeAsync(
    `const done = arguments[arguments.length - 1]; window.__sv.settle(3000, ${JSON.stringify(finalBurst.anchor)}).then((r) => done(r));`,
  )) as (typeof settleResults)[number];
  settleResults.push(finalSettle);
  try {
    await waitFor("empty older page", 10_000, async () => {
      const snapshot = (await execute("return window.__sv.snapshot();")) as {
        pages: { ids: string[]; status: number | null; start: number; end: number | null }[];
        loading: boolean;
      };
      return snapshot.pages.some((page) => page.ids.length === 0) && !snapshot.loading ? true : null;
    });
  } catch (error) {
    const snapshot = (await execute("return window.__sv.snapshot();")) as {
      scrollTop: number;
      scrollHeight: number;
      loading: boolean;
      ids: string[];
      pages: { url: string; status: number | null; start: number; end: number | null; ids: string[] }[];
    };
    const live = (await execute(
      `const scroller = window.__sv.scroller;
       const current = document.querySelector('.channel__messages');
       return {
         url: location.href,
         bodyText: document.body?.innerText?.slice(0, 1000) ?? '',
         rootHtmlLength: document.getElementById('root')?.innerHTML.length ?? null,
         trackedConnected: scroller.isConnected,
         trackedIsCurrent: scroller === current,
         currentFound: Boolean(current),
         currentScrollTop: current?.scrollTop ?? null,
         currentScrollHeight: current?.scrollHeight ?? null,
         currentRows: current?.querySelectorAll('.ac-msg[data-message-id]').length ?? null,
       };`,
    )) as Record<string, unknown>;
    log(
      `empty-page timeout: ${JSON.stringify({
        loading: snapshot.loading,
        scrollTop: snapshot.scrollTop,
        scrollHeight: snapshot.scrollHeight,
        renderedRows: snapshot.ids.length,
        live,
        errors: (snapshot as { errors?: unknown[] }).errors ?? [],
        pages: snapshot.pages.map((page) => ({
          status: page.status,
          ids: page.ids.length,
          start: Math.round(page.start),
          end: page.end === null ? null : Math.round(page.end),
        })),
      })}`,
    );
    throw error;
  }
  let reconnect: unknown = null;
  try {
    reconnect = await executeAsync(
      "const done = arguments[arguments.length - 1]; window.__sv.reconnectProbe().then((r) => done(r));",
    );
  } catch (error) {
    reconnect = { available: false, error: String(error) };
  }

  const snapshot = (await execute("return window.__sv.snapshot();")) as {
    scrollTop: number;
    scrollHeight: number;
    clientHeight: number;
    loading: boolean;
    ids: string[];
    drawnRows: number;
    network: {
      profile: string;
      delayMs: number;
      jitterMs: number;
      bandwidthKbps: number;
      loss: number;
      losses: number;
      bytes: number;
      waitMs: number;
    };
    layoutProbes: { at: number; ms: number; changes: number }[];
    pages: {
      url: string;
      status: number | null;
      start: number;
      end: number | null;
      networkMs: number;
      ids: string[];
      admissionMs: number | null;
      firstAdd: number | null;
      lastAdd: number | null;
    }[];
  };
  const frames = burstResults.flatMap((burst) => burst.frames);
  const deltas = burstResults.flatMap((burst) => burst.cadence).sort((a, b) => a - b);
  const pct = (p: number) => deltas[Math.min(deltas.length - 1, Math.floor((deltas.length - 1) * p))] ?? 0;
  const layoutMs = snapshot.layoutProbes.map((probe) => probe.ms).sort((a, b) => a - b);
  const layoutPct = (p: number) => layoutMs[Math.min(layoutMs.length - 1, Math.floor((layoutMs.length - 1) * p))] ?? 0;
  const worstSettle = settleResults.reduce(
    (worst, settle) => (settle.maxDisplacement > worst.maxDisplacement ? settle : worst),
    settleResults[0] ?? {
      ms: 0,
      loading: false,
      maxDisplacement: 0,
      maxAt: 0,
      loadingSeen: false,
      anchor: null,
      startScrollTop: 0,
      endScrollTop: 0,
      startScrollHeight: 0,
      endScrollHeight: 0,
      scrollEvents: [],
    },
  );
  const duplicates = snapshot.ids.length - new Set(snapshot.ids).size;
  const rendered = new Set(snapshot.ids);
  const missing = seededIds.filter((id) => !rendered.has(id));
  const loadedIndexes = snapshot.ids
    .map((id) => seededIds.indexOf(id))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b);
  const contiguousLoadedWindow = loadedIndexes.every(
    (index, position) => position === 0 || index === loadedIndexes[position - 1] + 1,
  );

  const metrics = {
    startedAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    diagnostics_mode: diagnosticsMode,
    family,
    seedMessages,
    network: snapshot.network,
    reconnect,
    appImage: appimage,
    serverUrl,
    renderer: desktop?.renderer ?? null,
    sessionId,
    first_visible_ms: firstVisibleMs,
    admission_latency_ms: snapshot.pages.filter((p) => p.admissionMs !== null).map((p) => p.admissionMs),
    older_page_requests: snapshot.pages.map((p) => ({
      url: p.url,
      status: p.status,
      ids: p.ids.length,
      start: p.start,
      end: p.end,
      networkMs: p.networkMs,
      admissionMs: p.admissionMs,
      firstAdd: p.firstAdd,
      lastAdd: p.lastAdd,
    })),
    max_visible_anchor_displacement_px: Math.max(...settleResults.map((s) => s.maxDisplacement), 0),
    worst_settle: worstSettle,
    settle_samples: settleResults.map((s) => ({
      anchor: s.anchor,
      maxDisplacement: s.maxDisplacement,
      maxAt: s.maxAt,
      loadingSeen: s.loadingSeen,
      scrollTopDelta: s.endScrollTop - s.startScrollTop,
      scrollHeightDelta: s.endScrollHeight - s.startScrollHeight,
      scrollEvents: s.scrollEvents,
    })),
    scroll: {
      profile: { stepPx: BURST_STEP, framesPerBurst: BURST_FRAMES, bursts: BURSTS },
      bursts: burstResults.length,
      finalScrollTop: snapshot.scrollTop,
      scrollHeight: snapshot.scrollHeight,
      clientHeight: snapshot.clientHeight,
      drawnRows: snapshot.drawnRows,
    },
    frame_cadence: {
      frames: deltas.length,
      longFramesOver50ms: deltas.filter((dt) => dt > 50).length,
      p50Ms: pct(0.5),
      p95Ms: pct(0.95),
      maxMs: deltas.at(-1) ?? 0,
    },
    layout_probes: {
      count: layoutMs.length,
      p50Ms: layoutPct(0.5),
      p95Ms: layoutPct(0.95),
      maxMs: layoutMs.at(-1) ?? 0,
      changesMax: Math.max(...snapshot.layoutProbes.map((probe) => probe.changes), 0),
    },
    frame_samples: frames.map((frame) => ({
      dt: Math.round(frame.dt),
      rows: frame.rows,
      drawnRows: frame.drawnRows,
      drawnAdds: frame.drawnAdds,
      drawnRemoves: frame.drawnRemoves,
      at: Math.round(frame.at),
      scrollTop: Math.round(frame.scrollTop),
      scrollHeight: frame.scrollHeight,
      loading: frame.loading,
    })),
    burst_summaries: burstResults.map((burst, index) => ({
      index,
      frames: burst.frames.length,
      longFrames: burst.frames.filter((frame) => frame.dt > 50).length,
      maxMs: Math.max(...burst.frames.map((frame) => frame.dt), 0),
      rowsStart: burst.frames[0]?.rows ?? 0,
      rowsEnd: burst.frames.at(-1)?.rows ?? 0,
      drawnMax: Math.max(...burst.frames.map((frame) => frame.drawnRows), 0),
    })),
    history: {
      seededRows: seededIds.length,
      renderedRows: snapshot.ids.length,
      uniqueRows: new Set(snapshot.ids).size,
      duplicateRows: duplicates,
      missingRows: missing.length,
      missingIds: missing.slice(0, 20),
      contiguousLoadedWindow,
    },
    loading: {
      seenDuringBursts: frames.some((f) => f.loading),
      finalLoading: snapshot.loading,
      emptyPageRequests: snapshot.pages.filter((p) => p.ids.length === 0).length,
      stuck: snapshot.loading,
    },
  };
  const suffix = [
    diagnosticsMode,
    family === "mixed" ? null : family,
    networkName === "none" ? null : `net-${networkName}`,
  ].filter(Boolean);
  const metricsPath = join(OUT, `metrics-${suffix.join("-")}.json`);
  writeFileSync(metricsPath, `${JSON.stringify(metrics, null, 2)}\n`);
  log(`wrote ${metricsPath}`);
  console.log(JSON.stringify(metrics, null, 2));
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? `${error.stack ?? error.message}` : String(error);
  writeFileSync(
    join(OUT, "failure.json"),
    `${JSON.stringify({ startedAt: new Date(started).toISOString(), error: message }, null, 2)}\n`,
  );
  console.error(message);
  process.exitCode = 1;
} finally {
  if (sessionId) {
    try {
      await webdriver("DELETE", `/session/${sessionId}`);
    } catch {}
  }
  driver?.kill();
}
