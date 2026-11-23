import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { desktopRenderer, desktopReportTags } from "@/lib/desktop";
import { atRule, builtCss, declarations, topLevel } from "./built-css";

const app = (bridge: object | undefined) => {
  (window as { __agentesDesktop?: object }).__agentesDesktop = bridge;
};

afterEach(() => app(undefined));

test("the renderer the app says it paints with; Linux apps that don't say painted on the CPU", () => {
  expect(desktopRenderer()).toBeNull();
  app({ platform: "linux", renderer: "gpu" });
  expect(desktopRenderer()).toBe("gpu");
  app({ platform: "linux", renderer: "cpu" });
  expect(desktopRenderer()).toBe("cpu");
  app({ platform: "linux" });
  expect(desktopRenderer()).toBe("cpu");
  app({ platform: "mac" });
  expect(desktopRenderer()).toBe("gpu");
  app({ platform: "windows", renderer: "something else" });
  expect(desktopRenderer()).toBe("gpu");
});

test("error reports carry how the app draws, from the app's own facts only", () => {
  expect(desktopReportTags()).toEqual({});
  app({ platform: "mac", renderer: "gpu", system: null });
  expect(desktopReportTags()).toEqual({ desktop_renderer: "gpu" });
  app({
    platform: "linux",
    renderer: "cpu",
    system: {
      distro: "Ubuntu 26.04 LTS",
      session: "wayland (GNOME)",
      webkit: "2.50.4",
      gpu: "",
      renderer: "cpu",
      bundle: "AppImage",
      odd: 3,
    },
  });
  expect(desktopReportTags()).toEqual({
    desktop_renderer: "cpu",
    desktop_distro: "Ubuntu 26.04 LTS",
    desktop_session: "wayland (GNOME)",
    desktop_webkit: "2.50.4",
    desktop_bundle: "AppImage",
  });
});

test("painted on the CPU, glass is solid and nothing blurs or loops", () => {
  const css = readFileSync(path.join(import.meta.dir, "../src/desktop.css"), "utf8");
  const rule = (selector: string) => {
    const at = css.indexOf(`${selector} {`);
    expect(at).toBeGreaterThan(-1);
    return css.slice(at, css.indexOf("}", at));
  };
  expect(rule('html[data-desktop-renderer="cpu"] [data-theme]')).toContain("--glass: var(--glass-solid)");
  const all = rule('html[data-desktop-renderer="cpu"] *::after');
  expect(all).toContain("backdrop-filter: none !important");
  expect(all).toContain("-webkit-backdrop-filter: none !important");
  expect(all).toContain("animation-iteration-count: 1 !important");
});
test("with nobody looking, endless loops end their round; merely idle, they keep going", () => {
  const css = readFileSync(path.join(import.meta.dir, "../src/desktop.css"), "utf8");
  const at = css.indexOf('html[data-sight="away"] *,');
  expect(at).toBeGreaterThan(-1);
  const rule = css.slice(at, css.indexOf("}", at));
  for (const sight of ["away", "hidden"])
    for (const part of ["*", "*::before", "*::after"]) expect(rule).toContain(`html[data-sight="${sight}"] ${part}`);
  expect(rule).toContain("animation-iteration-count: 1 !important");
  expect(css).not.toContain('html[data-sight="idle"]');
  expect(css).not.toContain("html[data-sight] *");
});

test("software painting drops the conversation's per-frame paint effects", () => {
  const css = readFileSync(path.join(import.meta.dir, "../src/desktop.css"), "utf8");
  const rule = (selector: string) => {
    const at = css.indexOf(`${selector} {`);
    expect(at).toBeGreaterThan(-1);
    return css.slice(at, css.indexOf("}", at));
  };
  expect(rule('html[data-desktop-renderer="cpu"] .channel__messages')).toContain("mask-image: none !important");
  expect(rule('html[data-desktop-renderer="cpu"] .channel__messages .ac-msg')).toContain("box-shadow: none !important");
  const cardShadows = 'html[data-desktop-renderer="cpu"] .rq *::after';
  const cardShadowsAt = css.indexOf(`${cardShadows} {`);
  expect(cardShadowsAt).toBeGreaterThan(-1);
  expect(css.slice(cardShadowsAt, css.indexOf("}", cardShadowsAt))).toContain("box-shadow: none !important");
  expect(css).toContain('html[data-desktop-renderer="cpu"] .rq *,');
  expect(css).toContain('html[data-desktop-renderer="cpu"] .rq *::before,');
});
test("Linux desktop webview drops scroller mask and shell layer promotion without flattening shadows or affecting browsers", async () => {
  const css = await builtCss("src/styles.css");
  const top = topLevel(css);
  const last = (sheet: string, selector: string, property: string) =>
    declarations(sheet, selector)
      .filter(([p]) => p === property)
      .at(-1)?.[1];

  // Browsers keep the mask fade and never show the static overlay.
  expect(last(top, ".channel__fade", "display")).toBe("none");
  expect(last(top, ".channel__messages", "mask-image")).toContain("linear-gradient");

  // Linux desktop webview (SHM, DMA-BUF and CPU) drops the mask, keeps stacking isolation, and drops shell promotion.
  for (const scope of ['html[data-desktop="linux"]', 'html[data-desktop-renderer="cpu"]']) {
    expect(last(top, `${scope} .channel__messages`, "mask-image")).toBe("none!important");
    expect(last(top, `${scope} .channel__messages`, "-webkit-mask-image")).toBe("none!important");
    expect(last(top, `${scope} .channel__messages`, "isolation")).toBe("isolate");
    expect(last(top, `${scope} .shell__main`, "will-change")).toBe("auto");
    expect(last(top, `${scope} .shell__main`, "contain")).toBe("layout");

    // Static bottom fade overlay replaces the mask identically, spares the 8px scrollbar, and hides on wallpapers.
    expect(last(top, `${scope} .channel__fade`, "display")).toBe("block");
    expect(last(top, `${scope} .channel__fade`, "height")).toBe("0");
    expect(last(top, `${scope} .channel__fade`, "pointer-events")).toBe("none");
    expect(last(top, `${scope} .channel__col[data-wallpaper] > .channel__fade`, "display")).toBe("none");
    expect(last(top, `${scope} .channel__fade::before`, "height")).toBe("24px");
    expect(last(top, `${scope} .channel__fade::before`, "background")).toBe(
      "linear-gradient(to bottom, transparent, var(--bg))",
    );
    expect(
      last(atRule(css, "@media (hover: hover) and (pointer: fine)"), `${scope} .channel__fade::before`, "right"),
    ).toBe("8px");
    expect(last(atRule(css, "@media (max-width: 760px)"), `${scope} .channel__fade::before`, "height")).toBe("10px");
  }

  // Linux GPU keeps glass, animations, and elevation shadows outside CPU-only rules.
  expect(last(top, 'html[data-desktop="linux"]', "--glass")).toBeUndefined();
  expect(last(top, 'html[data-desktop="linux"] .channel__messages', "--e1")).toBeUndefined();
  expect(last(top, 'html[data-desktop="linux"] .channel__messages', "--e2")).toBeUndefined();
  expect(last(top, 'html[data-desktop="linux"] .channel__messages', "--card-well-shadow")).toBeUndefined();
  expect(last(top, 'html[data-desktop="linux"] .channel__messages .ac-msg', "box-shadow")).toBeUndefined();
  expect(
    last(top, 'html[data-desktop="linux"] .channel__messages .ac-btn--primary:not(:focus-visible)', "box-shadow"),
  ).toBeUndefined();
});
