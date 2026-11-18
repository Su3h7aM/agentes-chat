import { describe, expect, test } from "bun:test";

import { RETAINED_OLDER_MAX, retainedOlderTail } from "../src/lib/older-pages";

describe("the older pages a channel keeps", () => {
  test("everything fits: nothing to release", () => {
    const pages = ["a", "b", "c"];
    expect(retainedOlderTail(pages, 3)).toBeNull();
    expect(retainedOlderTail(pages, 10)).toBeNull();
  });

  test("over the bound: the newest ones stay, the far ones are released", () => {
    const pages = Array.from({ length: 9 }, (_, i) => `m-${i}`);
    expect(retainedOlderTail(pages, 4)).toEqual(["m-5", "m-6", "m-7", "m-8"]);
  });

  test("the bound is the channel's: 200 older messages", () => {
    const pages = Array.from({ length: RETAINED_OLDER_MAX + 1 }, (_, i) => `m-${i}`);
    const kept = retainedOlderTail(pages);
    expect(kept).toHaveLength(RETAINED_OLDER_MAX);
    expect(kept?.[0]).toBe("m-1");
    expect(kept?.at(-1)).toBe(`m-${RETAINED_OLDER_MAX}`);
    expect(retainedOlderTail(pages.slice(0, RETAINED_OLDER_MAX))).toBeNull();
  });
});
