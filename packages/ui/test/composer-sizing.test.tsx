import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "../testing/dom";

setupDom();

import { cleanup, render, screen } from "@testing-library/react";
import { Composer } from "../src/components/Composer";

afterEach(cleanup);

describe("composer sizing", () => {
  for (const supported of [true, false]) {
    test(`uses ${supported ? "native sizing" : "the measured fallback"} when a draft changes`, () => {
      const originalCss = Object.getOwnPropertyDescriptor(globalThis, "CSS");
      const originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
      let height = 60;
      Object.defineProperty(globalThis, "CSS", {
        configurable: true,
        value: {
          supports: (property: string, value: string) =>
            supported && property === "field-sizing" && value === "content",
        },
      });
      Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => height });
      const box = (value: string) => (
        <Composer value={value} onChange={() => {}} onSend={() => {}} label="Message" sendLabel="Send" />
      );
      try {
        const { rerender } = render(box("draft"));
        const field = screen.getByRole("textbox") as HTMLTextAreaElement;
        expect(field.style.height).toBe(supported ? "" : "60px");
        height = 100;
        rerender(box("restored\ndraft"));
        expect(field.value).toBe("restored\ndraft");
        expect(field.style.height).toBe(supported ? "" : "100px");
        height = 30;
        rerender(box(""));
        expect(field.style.height).toBe(supported ? "" : "30px");
      } finally {
        cleanup();
        if (originalCss) Object.defineProperty(globalThis, "CSS", originalCss);
        else Reflect.deleteProperty(globalThis, "CSS");
        if (originalScrollHeight) Object.defineProperty(HTMLElement.prototype, "scrollHeight", originalScrollHeight);
        else Reflect.deleteProperty(HTMLElement.prototype, "scrollHeight");
      }
    });
  }
});
