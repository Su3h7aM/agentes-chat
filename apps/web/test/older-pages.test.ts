import { describe, expect, test } from "bun:test";

import {
  advanceOlderAdmission,
  beginOlderAdmission,
  noteOlderMotion,
  OLDER_ADMISSION_FORCE_MS,
  OLDER_ADMISSION_QUIET_MS,
  RETAINED_OLDER_MAX,
  retainedOlderTail,
} from "../src/lib/older-pages";

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

describe("when a fetched older page may join the list", () => {
  test("it waits for the quiet period and two stable scroll frames", () => {
    const admission = beginOlderAdmission(0, 400);
    expect(advanceOlderAdmission(admission, OLDER_ADMISSION_QUIET_MS - 1, 400)).toBe("waiting");
    expect(advanceOlderAdmission(admission, OLDER_ADMISSION_QUIET_MS, 400)).toBe("waiting");
    expect(advanceOlderAdmission(admission, OLDER_ADMISSION_QUIET_MS + 16, 400)).toBe("admit");
  });

  test("drift above half a pixel starts the stable frames again", () => {
    const admission = beginOlderAdmission(0, 400);
    advanceOlderAdmission(admission, OLDER_ADMISSION_QUIET_MS, 400);
    expect(advanceOlderAdmission(admission, OLDER_ADMISSION_QUIET_MS + 16, 400.6)).toBe("waiting");
    expect(advanceOlderAdmission(admission, OLDER_ADMISSION_QUIET_MS + 32, 400.6)).toBe("waiting");
    expect(advanceOlderAdmission(admission, OLDER_ADMISSION_QUIET_MS + 48, 400.6)).toBe("admit");
  });

  test("a new motion restarts the quiet period", () => {
    const admission = beginOlderAdmission(0, 400);
    advanceOlderAdmission(admission, OLDER_ADMISSION_QUIET_MS, 400);
    noteOlderMotion(admission, OLDER_ADMISSION_QUIET_MS + 10);
    expect(advanceOlderAdmission(admission, OLDER_ADMISSION_QUIET_MS + 20, 380)).toBe("waiting");
    expect(advanceOlderAdmission(admission, OLDER_ADMISSION_QUIET_MS + 130, 380)).toBe("waiting");
    expect(advanceOlderAdmission(admission, OLDER_ADMISSION_QUIET_MS + 146, 380)).toBe("admit");
  });

  test("continuous motion still commits at the bounded deadline", () => {
    const admission = beginOlderAdmission(0, 400);
    noteOlderMotion(admission, OLDER_ADMISSION_FORCE_MS - 1);
    expect(advanceOlderAdmission(admission, OLDER_ADMISSION_FORCE_MS, 380)).toBe("admit");
  });
});
