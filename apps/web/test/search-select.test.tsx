import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { SearchSelect, type SelectOption } from "@agenteschat/ui";
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { useState } from "react";

afterEach(() => cleanup());

const labels = { search: "Buscar modelos", searchPlaceholder: "Nome", noResults: "Nada", list: "Modelos" };
const OPTIONS: SelectOption[] = [
  { value: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", group: "Claude" },
  { value: "~z-ai/glm-latest", label: "Z.ai: GLM Latest", group: "OpenRouter · Boas escolhas" },
  { value: "z-ai/glm-5.3", label: "Z.ai: GLM 5.3", group: "OpenRouter", disabled: true },
  { value: "tencent/hy3-preview", label: "Tencent: Hy3 preview", group: "OpenRouter" },
];

function Harness({ options = OPTIONS, initial = "claude-sonnet-5-5" }: { options?: SelectOption[]; initial?: string }) {
  const [value, setValue] = useState(initial);
  return <SearchSelect aria-label="Modelo" value={value} onValueChange={setValue} options={options} labels={labels} />;
}

describe("SearchSelect", () => {
  test("opens on the chosen one; the search reads names, ids and groups; arrows and Enter pick, never a disabled one", async () => {
    render(<Harness />);
    const box = document.body.querySelector('[role="combobox"]') as HTMLElement;
    expect(box.textContent).toBe("Claude Sonnet 5.5");
    await act(async () => fireEvent.keyDown(box, { key: "ArrowDown" }));
    const list = within(document.body).getByRole("listbox", { name: "Modelos" });
    expect(
      within(list)
        .getAllByRole("group")
        .map((g) => g.getAttribute("aria-label")),
    ).toEqual(["Claude", "OpenRouter · Boas escolhas", "OpenRouter"]);
    const chosen = within(list)
      .getAllByRole("option")
      .find((o) => o.getAttribute("aria-selected") === "true");
    expect(chosen?.hasAttribute("data-active")).toBe(true);
    // No check column: the chosen one is its state (its plate and heavier name).
    expect(chosen?.querySelector(".ac-tz__check")).toBeNull();
    expect(chosen?.firstElementChild?.className).toBe("ac-menu__label");
    const search = within(document.body).getByRole("combobox", { name: "Buscar modelos" });
    const shown = () =>
      within(list)
        .queryAllByRole("option")
        .map((o) => o.textContent);
    const activeText = () =>
      within(list)
        .queryAllByRole("option")
        .find((o) => o.hasAttribute("data-active"))?.textContent;
    await act(async () => fireEvent.change(search, { target: { value: "openrouter hy3" } }));
    expect(shown()).toEqual(["Tencent: Hy3 preview"]);
    await act(async () => fireEvent.change(search, { target: { value: "gpt" } }));
    expect(shown()).toEqual([]);
    expect(list.textContent).toBe("Nada");
    await act(async () => fireEvent.change(search, { target: { value: "glm latest" } }));
    expect(shown()).toEqual(["Z.ai: GLM Latest"]);
    // The match marks, keeping the label's case; typing lands on the first pickable row.
    const row = within(list).getByRole("option");
    expect([...row.querySelectorAll("mark.ac-search__mark")].map((m) => m.textContent)).toEqual(["GLM", "Latest"]);
    expect(activeText()).toBe("Z.ai: GLM Latest");
    expect(search.getAttribute("aria-activedescendant")).toBe(row.id);
    await act(async () => fireEvent.keyDown(search, { key: "Enter" }));
    expect(box.textContent).toBe("Z.ai: GLM Latest");
  });

  test("ranks the matches and never lands on a disabled option", async () => {
    render(<Harness />);
    const box = document.body.querySelector('[role="combobox"]') as HTMLElement;
    await act(async () => fireEvent.keyDown(box, { key: "ArrowDown" }));
    const search = within(document.body).getByRole("combobox", { name: "Buscar modelos" });
    // Ranked: the id's word-start match first, accents and case aside.
    await act(async () => fireEvent.change(search, { target: { value: "Z-AI" } }));
    expect(
      within(document.body)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Z.ai: GLM 5.3", "Z.ai: GLM Latest"]);
    const activeText = () =>
      within(document.body)
        .getAllByRole("option")
        .find((o) => o.hasAttribute("data-active"))?.textContent;
    // Typing lands past the disabled first row; arrows wrap past it too.
    expect(activeText()).toBe("Z.ai: GLM Latest");
    await act(async () => fireEvent.keyDown(search, { key: "ArrowDown" }));
    expect(activeText()).toBe("Z.ai: GLM Latest");
    await act(async () => fireEvent.keyDown(search, { key: "ArrowUp" }));
    expect(activeText()).toBe("Z.ai: GLM Latest");
    // Enter picks the highlighted row, never the disabled one.
    await act(async () => fireEvent.keyDown(search, { key: "Enter" }));
    expect(box.textContent).toBe("Z.ai: GLM Latest");
  });

  test("arrows skip disabled options, wrap around; Home/End/Page land on pickable rows", async () => {
    const nav: SelectOption[] = [
      { value: "a", label: "Alpha" },
      { value: "b", label: "Beta", disabled: true },
      { value: "c", label: "Gamma" },
      { value: "d", label: "Delta", disabled: true },
    ];
    render(<Harness options={nav} initial="a" />);
    const box = document.body.querySelector('[role="combobox"]') as HTMLElement;
    await act(async () => fireEvent.keyDown(box, { key: "ArrowDown" }));
    const search = within(document.body).getByRole("combobox", { name: "Buscar modelos" });
    const activeText = () =>
      within(document.body)
        .getAllByRole("option")
        .find((o) => o.hasAttribute("data-active"))?.textContent;
    expect(activeText()).toBe("Alpha");
    await act(async () => fireEvent.keyDown(search, { key: "ArrowDown" }));
    expect(activeText()).toBe("Gamma");
    // Past the end wraps past the disabled row, back to the start.
    await act(async () => fireEvent.keyDown(search, { key: "ArrowDown" }));
    expect(activeText()).toBe("Alpha");
    await act(async () => fireEvent.keyDown(search, { key: "ArrowUp" }));
    expect(activeText()).toBe("Gamma");
    // End lands on the last pickable row, Home on the first.
    await act(async () => fireEvent.keyDown(search, { key: "End" }));
    expect(activeText()).toBe("Gamma");
    await act(async () => fireEvent.keyDown(search, { key: "Home" }));
    expect(activeText()).toBe("Alpha");
    // A page jumps past the disabled rows to the other end.
    await act(async () => fireEvent.keyDown(search, { key: "PageDown" }));
    expect(activeText()).toBe("Gamma");
    await act(async () => fireEvent.keyDown(search, { key: "PageUp" }));
    expect(activeText()).toBe("Alpha");
    await act(async () => fireEvent.keyDown(search, { key: "End" }));
    await act(async () => fireEvent.keyDown(search, { key: "Enter" }));
    expect(box.textContent).toBe("Gamma");
  });
});
