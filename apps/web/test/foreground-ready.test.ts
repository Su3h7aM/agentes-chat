import { describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { scheduleAfterForegroundReady } from "../src/lib/foreground-ready";

/** One task, a frame and one more task, on the browser's real clock. */
const waitForResume = () => new Promise((resolve) => setTimeout(resolve, 60));

describe("foreground-ready work", () => {
  test("runs after the activating event's own turn and a painted frame", async () => {
    const ran: string[] = [];
    scheduleAfterForegroundReady(() => ran.push("resume"));

    // Not in the activating event's own turn.
    expect(ran).toEqual([]);
    await waitForResume();
    expect(ran).toEqual(["resume"]);
  });

  test("a cancelled resume never runs", async () => {
    const ran: string[] = [];
    const cancel = scheduleAfterForegroundReady(() => ran.push("resume"));
    cancel();
    await waitForResume();
    expect(ran).toEqual([]);
  });
});
