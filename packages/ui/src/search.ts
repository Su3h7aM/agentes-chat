import { fuzzyScore, type MatchRange, type MatchSegment, matchRanges, matchSegments } from "@ui-sdk/core/text-match";

/** Lowercase and without accents ("São Paulo" → "sao paulo"): what a search compares. */
export const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Whether every word of `query` is in `text`, ignoring case and accents ("glm flash" finds "GLM 5.3 Flash"). */
export function matchesWords(text: string, query: string): boolean {
  const hay = fold(text);
  return fold(query)
    .split(/\s+/)
    .every((word) => hay.includes(word));
}

/**
 * How well `text` answers `query`, 0 to ~1: every word must fuzzy-match somewhere (case- and accent-aware, so
 * "resume" finds "Résumé" and "openrouter hy3" still finds a Hy3 row), and better matches score higher. Empty
 * queries score 1, so an unfiltered list keeps its order.
 *
 * Words whose letters only line up by accident (below 0.2: no word start, no run, like "gpt" in "GLM … OpenRouter")
 * score 0, so a junk query empties the list instead of ranking noise.
 */
export function rankedScore(text: string, query: string): number {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return 1;
  let total = 0;
  for (const word of words) {
    const score = fuzzyScore(text, word);
    if (score < 0.2) return 0;
    total += score;
  }
  return total / words.length;
}

/**
 * `options` ordered for a search box: those scoring above 0 for `query`, best first. Ties keep their order, and an
 * empty query keeps the list as given.
 */
export function rankOptions<T>(options: readonly T[], query: string, textOf: (option: T) => string): T[] {
  if (!query.trim()) return [...options];
  return options
    .map((option) => ({ option, score: rankedScore(textOf(option), query) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.option);
}

/** The ranges of `text` matching every word of `query` (fuzzy), merged; empty when nothing matches. */
export function matchWordRanges(text: string, query: string): MatchRange[] {
  const words = query.split(/\s+/).filter(Boolean);
  const ranges: MatchRange[] = [];
  for (const word of words) ranges.push(...matchRanges(text, word, "fuzzy"));
  ranges.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: MatchRange[] = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

/** `text` split into matched/unmatched pieces for `query`, for `<mark>`; plain when nothing matches. */
export function highlightSegments(text: string, query: string): MatchSegment[] {
  if (!query.trim()) return [{ text, match: false }];
  return matchSegments(text, matchWordRanges(text, query));
}

export type { MatchRange, MatchSegment };
