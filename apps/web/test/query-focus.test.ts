import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { focusManager } from "@tanstack/react-query";
import { bindFocusToWindow } from "../src/app/query-client";

let undo: (() => void) | null = null;

afterEach(() => {
  undo?.();
  undo = null;
  focusManager.setFocused(undefined);
});

/** Waits for the deferred resume (a task, a frame, a task). */
const resume = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 16));
};

describe("the query client's window focus", () => {
  test("a window without the focus polls nothing; getting it back resumes after a paint", async () => {
    const hasFocus = spyOn(document, "hasFocus").mockReturnValue(false);
    undo = bindFocusToWindow();
    expect(focusManager.isFocused()).toBe(false);

    hasFocus.mockReturnValue(true);
    window.dispatchEvent(new Event("focus"));
    // The activating turn is left alone: the resume waits a frame.
    expect(focusManager.isFocused()).toBe(false);
    await resume();
    expect(focusManager.isFocused()).toBe(true);

    hasFocus.mockReturnValue(false);
    window.dispatchEvent(new Event("blur"));
    expect(focusManager.isFocused()).toBe(false);
    hasFocus.mockRestore();
  });

  test("its undo puts back the tab-visibility check", async () => {
    const hasFocus = spyOn(document, "hasFocus").mockReturnValue(false);
    undo = bindFocusToWindow();
    expect(focusManager.isFocused()).toBe(false);

    undo();
    undo = null;
    expect(focusManager.isFocused()).toBe(true);
    hasFocus.mockRestore();
  });
});
