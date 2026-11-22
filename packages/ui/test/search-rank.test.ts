import { describe, expect, test } from "bun:test";
import { filterPalette, type PaletteItem } from "../src/components/CommandPalette";
import { highlightSegments, matchWordRanges, rankedScore, rankOptions } from "../src/search";

const noop = () => {};

describe("rankedScore", () => {
  test("empty queries score everything at 1, keeping the list as given", () => {
    expect(rankedScore("Anything", "")).toBe(1);
    expect(rankedScore("Anything", "   ")).toBe(1);
    expect(rankOptions(["b", "a"], "", (o) => o)).toEqual(["b", "a"]);
  });
  test("case and accents aside: “resume” finds “Résumé”", () => {
    expect(rankedScore("Résumé writer", "resume")).toBeGreaterThan(0);
    expect(rankedScore("Unrelated", "resume")).toBe(0);
  });
  test("better matches score higher: a start beats a middle, an exact word beats scattered letters", () => {
    expect(rankedScore("Settings", "set")).toBeGreaterThan(rankedScore("Open settings", "set"));
    expect(rankedScore("Git push", "gp")).toBeGreaterThan(0);
  });
  test("every word must match somewhere, in any order", () => {
    expect(rankedScore("Tencent: Hy3 preview OpenRouter", "openrouter hy3")).toBeGreaterThan(0);
    expect(rankedScore("Tencent: Hy3 preview", "openrouter hy3")).toBe(0);
  });
  test("letters that only line up by accident score 0, initials still count", () => {
    expect(rankedScore("Z.ai: GLM Latest OpenRouter", "gpt")).toBe(0);
    expect(rankedScore("Git push", "gp")).toBeGreaterThan(0);
  });
});

describe("rankOptions", () => {
  test("best first, misses out, ties keeping their order", () => {
    const options = ["Open settings", "Settings", "Git push"];
    expect(rankOptions(options, "set", (o) => o)).toEqual(["Settings", "Open settings"]);
    expect(rankOptions(options, "gpt", (o) => o)).toEqual([]);
  });
});

describe("highlightSegments", () => {
  test("marks the matched ranges, keeping case and accents", () => {
    expect(highlightSegments("Settings", "set")).toEqual([
      { text: "Set", match: true },
      { text: "tings", match: false },
    ]);
    expect(highlightSegments("Résumé writer", "resume")).toEqual([
      { text: "Résumé", match: true },
      { text: " writer", match: false },
    ]);
  });
  test("every word marks, merged; words matched elsewhere mark nothing", () => {
    const segments = highlightSegments("Z.ai: GLM Latest", "z-ai latest");
    // "z-ai" matches through the option's id, not its label: only "latest" marks.
    expect(segments.filter((s) => s.match).map((s) => s.text)).toEqual(["Latest"]);
    expect(segments.map((s) => s.text).join("")).toBe("Z.ai: GLM Latest");
    expect(highlightSegments("Settings", "xyz")).toEqual([{ text: "Settings", match: false }]);
    expect(highlightSegments("Settings", "")).toEqual([{ text: "Settings", match: false }]);
  });
  test("matchWordRanges merges overlaps", () => {
    expect(matchWordRanges("Settings", "set tings")).toEqual([{ start: 0, end: 8 }]);
  });
});

describe("filterPalette", () => {
  const items: PaletteItem[] = [
    { key: "a", group: "Go", label: "Open settings", onSelect: noop },
    { key: "b", group: "Go", label: "Settings", sub: "configurações", onSelect: noop },
    { key: "c", group: "Go", label: "Git push", keywords: "push", searchOnly: true, onSelect: noop },
  ];
  test("no query: everything but searchOnly, in order", () => {
    expect(filterPalette(items, "").map((i) => i.key)).toEqual(["a", "b"]);
  });
  test("ranked: the exact label first, sub and keywords match, accents aside", () => {
    expect(filterPalette(items, "set").map((i) => i.key)).toEqual(["b", "a"]);
    expect(filterPalette(items, "push").map((i) => i.key)).toEqual(["c"]);
    expect(filterPalette(items, "configuracoes").map((i) => i.key)).toEqual(["b"]);
    expect(filterPalette(items, "zzz")).toEqual([]);
  });
});
