import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createFakeApi, ORG_ID, seedState } from "./fake-api";
import { pick } from "./new-agent-flow";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(4);
};
const type = (el: Element, value: string) => act(async () => fireEvent.change(el, { target: { value } }));

describe("Outro provedor in Settings › Chaves de IA", () => {
  test("named, its models fetched and typed, prices on one, saved and tested: each model's result shows", async () => {
    const state = seedState({
      endpointList: {
        baseURL: "https://gw.example/v1",
        listingStyle: "anthropic",
        models: [{ id: "llama-4" }, { id: "qwen-3" }],
      },
      endpointChecks: { "qwen-3": { model: "qwen-3", check: "no_tools" } },
    });
    await renderApp(`/org/${ORG_ID}/settings/keys`, { api: createFakeApi(state) });
    await settle(5);
    const keys = screen().getByRole("region", { name: "Chaves de API" });
    await click(within(keys).getByRole("button", { name: "Adicionar chave" }));
    const add = screen().getByRole("dialog", { name: "Adicionar chave de API" });
    await pick(within(add).getByRole("combobox", { name: "Provedor" }), /Outro provedor/);

    const save = () => within(add).getByRole("button", { name: "Salvar e testar" });
    expect(save().hasAttribute("disabled")).toBe(true);
    await type(within(add).getByLabelText("Nome"), "OpenGateway");
    await type(within(add).getByLabelText("Endereço"), "https://gw.example/v1/");
    await type(within(add).getByLabelText("Chave de API"), "gw-key-1234567");
    await click(within(add).getByRole("button", { name: "Buscar modelos" }));
    expect(state.calls.find((c) => c.method === "agents.endpointModels")?.args[1]).toEqual({
      baseURL: "https://gw.example/v1/",
      apiKey: "[redacted]",
    });
    // Listed models start off: nothing to save yet.
    expect(save().hasAttribute("disabled")).toBe(true);
    await click(within(add).getByRole("checkbox", { name: "llama-4" }));
    await click(add.querySelector(".endpoint-model summary") as Element);
    expect(within(add).getByRole("combobox", { name: "llama-4 · API do modelo" }).textContent).toContain(
      "Chat Completions como alternativa",
    );
    await pick(within(add).getByRole("combobox", { name: "llama-4 · API do modelo" }), "OpenAI Responses");
    await type(within(add).getByLabelText("llama-4: preço de entrada"), "1");
    await type(within(add).getByLabelText("llama-4: preço de saída"), "2,5");
    await type(within(add).getByLabelText("Adicionar um modelo"), "qwen-3");
    await click(within(add).getByRole("button", { name: "Adicionar" }));
    expect(add.textContent).toContain("Um modelo sem preço não custa nada nos orçamentos");
    await click(save());
    await settle(4);

    expect(state.calls.find((c) => c.method === "agents.addCredential")?.args[1]).toEqual({
      provider: "custom",
      label: "OpenGateway",
      apiKey: "[redacted]",
      endpoint: {
        style: "openai",
        listingStyle: "anthropic",
        baseURL: "https://gw.example/v1",
        models: [
          { id: "llama-4", overrides: { api: "responses", prices: { input: 1, output: 2.5 } } },
          { id: "qwen-3" },
        ],
      },
    });
    expect(add.textContent).toContain("llama-4 · Funciona, com ferramentas");
    expect(add.textContent).toContain("qwen-3 · Responde, mas não usou ferramenta.");
    await click(within(add).getByRole("button", { name: "Concluir" }));
    expect(screen().queryByRole("dialog", { name: "Adicionar chave de API" })).toBeNull();
  });

  test("changing the address removes the previous host's discovery before saving", async () => {
    const at = "2026-11-01T10:00:00.000Z";
    const state = seedState({
      endpointList: {
        baseURL: "https://a.example/v1",
        listingStyle: "anthropic",
        models: [
          {
            id: "m",
            apiCheckedAt: at,
            discovered: { api: { source: "endpoint", value: "messages", discoveredAt: at } },
          },
        ],
      },
    });
    await renderApp(`/org/${ORG_ID}/settings/keys`, { api: createFakeApi(state) });
    await settle(5);
    await click(screen().getByRole("button", { name: "Adicionar chave" }));
    const add = screen().getByRole("dialog", { name: "Adicionar chave de API" });
    await pick(within(add).getByRole("combobox", { name: "Provedor" }), /Outro provedor/);
    await type(within(add).getByLabelText("Nome"), "Gateway");
    await type(within(add).getByLabelText("Endereço"), "https://a.example/v1");
    await click(within(add).getByRole("button", { name: "Buscar modelos" }));
    await click(within(add).getByRole("checkbox", { name: "m" }));
    await type(within(add).getByLabelText("Endereço"), "https://b.example/v1");
    await click(within(add).getByRole("button", { name: "Salvar e testar" }));
    const saved = state.calls.find((call) => call.method === "agents.addCredential")?.args[1] as { endpoint: unknown };
    expect(saved.endpoint).toEqual({ style: "openai", baseURL: "https://b.example/v1", models: [{ id: "m" }] });
  });

  test("refreshes a saved catalog, restores a legacy price and tests attachments", async () => {
    const model = { id: "model-a", prices: { input: 1, output: 2 }, overrides: { image: false } };
    const discoveredAt = "2026-11-01T10:00:00.000Z";
    const discovery = { prices: { input: { source: "endpoint" as const, value: 0, discoveredAt } } };
    const state = seedState({
      credentials: [
        {
          id: "saved-gw",
          provider: "custom",
          label: "My gateway",
          keyHint: "4567",
          endpoint: { style: "openai", baseURL: "https://gw.example/v1", models: [model] },
          createdAt: discoveredAt,
          revokedAt: null,
        },
      ],
      endpointList: { baseURL: "https://gw.example/v1", models: [{ id: model.id, discovered: discovery }] },
    });
    await renderApp(`/org/${ORG_ID}/settings/keys`, { api: createFakeApi(state) });
    await settle(5);
    await click(screen().getByRole("button", { name: "Modelos" }));
    const dialog = screen().getByRole("dialog", { name: "Modelos de My gateway" });
    await click(within(dialog).getByRole("button", { name: "Buscar modelos" }));
    expect(state.calls.find((c) => c.method === "agents.endpointModels")?.args[1]).toEqual({
      credentialId: "saved-gw",
    });
    await click(dialog.querySelector(".endpoint-model summary") as Element);
    await click(within(dialog).getByRole("button", { name: "Entrada · Usar valor descoberto" }));
    expect((within(dialog).getByLabelText("model-a: preço de entrada") as HTMLInputElement).value).toBe("0");
    await click(within(dialog).getByRole("button", { name: "Salvar e testar de novo" }));
    expect(state.calls.find((c) => c.method === "agents.setEndpointModels")?.args[2]).toEqual([
      { id: model.id, discovered: discovery, overrides: { image: false, prices: { output: 2 } } },
    ]);
    expect(state.calls.filter((c) => c.method === "agents.probeEndpoint").map((c) => c.args[2])).toEqual([
      { models: [model.id] },
    ]);
    await click(within(dialog).getByRole("button", { name: "Testar anexos novamente" }));
    expect(state.calls.filter((c) => c.method === "agents.probeEndpoint").at(-1)?.args[2]).toEqual({
      models: [model.id],
      force: true,
    });
  });

  test("retest is disabled when both attachments are manually set", async () => {
    const state = seedState({
      credentials: [
        {
          id: "saved-gw",
          provider: "custom",
          label: "My gateway",
          keyHint: "4567",
          endpoint: {
            style: "openai",
            baseURL: "https://gw.example/v1",
            models: [{ id: "model-a", overrides: { image: false, pdf: true } }],
          },
          createdAt: "2026-11-01T10:00:00.000Z",
          revokedAt: null,
        },
      ],
    });
    await renderApp(`/org/${ORG_ID}/settings/keys`, { api: createFakeApi(state) });
    await settle(5);
    await click(screen().getByRole("button", { name: "Modelos" }));
    const dialog = screen().getByRole("dialog", { name: "Modelos de My gateway" });
    await click(within(dialog).getByRole("button", { name: "Salvar e testar de novo" }));
    expect(
      (within(dialog).getByRole("button", { name: "Testar anexos novamente" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  const openForm = async (state = seedState()) => {
    const api = createFakeApi(state);
    await renderApp(`/org/${ORG_ID}/settings/keys`, { api });
    await settle(5);
    const keys = screen().getByRole("region", { name: "Chaves de API" });
    await click(within(keys).getByRole("button", { name: "Adicionar chave" }));
    const add = screen().getByRole("dialog", { name: "Adicionar chave de API" });
    await pick(within(add).getByRole("combobox", { name: "Provedor" }), /Outro provedor/);
    return { add, api };
  };

  test("the same endpoint and key saved again: the saved one is updated, and the results say so", async () => {
    const saved = {
      id: "cred-gw",
      provider: "custom",
      label: "OpenGateway",
      keyHint: "4567",
      endpoint: { style: "openai" as const, baseURL: "https://gw.example/v1", models: [{ id: "m-1" }] },
      createdAt: "2026-11-01T10:00:00.000Z",
      revokedAt: null,
    };
    const state = seedState({ credentials: [saved] });
    const { add } = await openForm(state);
    await type(within(add).getByLabelText("Nome"), "OpenGateway");
    await type(within(add).getByLabelText("Endereço"), "https://gw.example/v1");
    await type(within(add).getByLabelText("Chave de API"), "gw-key-1234567");
    await type(within(add).getByLabelText("Adicionar um modelo"), "m-1");
    await click(within(add).getByRole("button", { name: "Adicionar" }));
    await click(within(add).getByRole("button", { name: "Salvar e testar" }));
    expect(add.textContent).toContain("Essa chave já estava salva. Atualizei os dados.");
    expect(state.credentials.map((c) => c.id)).toEqual(["cred-gw"]);
  });

  test("laid out as a dialog: its fields in the body, Buscar modelos on the list's label line, Cancelar then the save in the footer", async () => {
    const { add } = await openForm();
    const body = add.querySelector(".ac-dialog__body") as HTMLElement;
    expect(body.querySelector(".ac-brand__initial")).toBeNull();
    expect(body.querySelector('.ac-brand[data-mark="custom"]')).not.toBeNull();
    expect(within(body).queryByRole("radiogroup", { name: "API" })).toBeNull();
    const fetch = within(body).getByRole("button", { name: "Buscar modelos" });
    expect(fetch.closest(".ac-field__label-row")?.textContent).toContain(
      "Escolha os modelos que os agentes podem usar",
    );
    expect(fetch.className).not.toContain("ac-btn");
    expect(within(body).getByRole("button", { name: "Adicionar" }).closest(".ac-input-affix")).not.toBeNull();
    const foot = add.querySelector(".ac-dialog__foot") as HTMLElement;
    expect([...foot.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Cancelar", "Salvar e testar"]);
    await click(within(foot).getByRole("button", { name: "Cancelar" }));
    expect(screen().queryByRole("dialog", { name: "Adicionar chave de API" })).toBeNull();
  });

  test("by keyboard: Enter adds without saving, the + and Remover leave the focus in the field, Buscar modelos comes before it", async () => {
    const { add, api } = await openForm();
    const typed = within(add).getByLabelText("Adicionar um modelo") as HTMLInputElement;
    await type(within(add).getByLabelText("Endereço"), "https://gw.example/v1");
    let saves = 0;
    (api.agents as { addCredential: unknown }).addCredential = () => {
      saves += 1;
      return new Promise(() => {});
    };
    await type(typed, "llama-4");
    await act(async () => fireEvent.keyDown(typed, { key: "Enter" }));
    await settle();
    expect(saves).toBe(0);
    expect(screen().queryByRole("dialog", { name: "Adicionar chave de API" })).not.toBeNull();
    expect(within(add).queryByRole("checkbox", { name: "llama-4" })).not.toBeNull();

    await type(typed, "qwen-3");
    const plus = within(add).getByRole("button", { name: "Adicionar" });
    await act(async () => plus.focus());
    await click(plus);
    expect(document.activeElement).toBe(typed);
    await click(add.querySelectorAll(".endpoint-model summary")[1] as Element);
    const remove = within(add).getByRole("button", { name: "Remover qwen-3" });
    await act(async () => remove.focus());
    await click(remove);
    expect(document.activeElement).toBe(typed);

    const fetch = within(add).getByRole("button", { name: "Buscar modelos" }) as HTMLButtonElement;
    expect(fetch.disabled).toBe(false);
    expect(fetch.compareDocumentPosition(typed) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test("model rows start closed and expose one shared disclosure group with effective facts", async () => {
    const at = "2026-11-01T10:00:00.000Z";
    const id = `vendor/${"long-model-".repeat(10)}v1`;
    const discovered = {
      api: { source: "endpoint" as const, value: "responses" as const, discoveredAt: at },
      contextWindow: { source: "endpoint" as const, value: 128000, discoveredAt: at },
      prices: { input: { source: "endpoint" as const, value: 0, discoveredAt: at } },
      image: { source: "endpoint" as const, value: true, discoveredAt: at },
    };
    const { add } = await openForm(
      seedState({ endpointList: { baseURL: "https://gw.example/v1", models: [{ id, discovered }, { id: "second" }] } }),
    );
    await type(within(add).getByLabelText("Endereço"), "https://gw.example/v1");
    await click(within(add).getByRole("button", { name: "Buscar modelos" }));
    const details = [...add.querySelectorAll<HTMLDetailsElement>(".endpoint-model details")];
    expect(details).toHaveLength(2);
    const [first, second] = details;
    if (!first || !second) throw new Error("Expected two model rows");
    expect(details.every((d) => !d.open)).toBe(true);
    expect(add.querySelectorAll(".endpoint-model--open")).toHaveLength(0);
    expect(first.getAttribute("name")).toBeTruthy();
    expect(second.getAttribute("name")).toBe(first.getAttribute("name"));
    expect(add.querySelectorAll(".endpoint-model details[open] .endpoint-model__capabilities")).toHaveLength(0);
    expect(first.querySelector("summary")?.textContent).toContain("OpenAI Responses");
    await click(first.querySelector("summary") as Element);
    expect(first.open).toBe(true);
    expect(first.closest(".endpoint-model--open")).not.toBeNull();
    expect(second.closest(".endpoint-model--open")).toBeNull();
    expect(add.querySelectorAll(".endpoint-model details[open] .endpoint-model__capabilities")).toHaveLength(1);
    expect(within(first).getByRole("combobox", { name: `${id} · API do modelo` })).toBeDefined();
    (globalThis as { geometrySnapshot?: () => void }).geometrySnapshot?.();
    expect(first.querySelector("summary input, summary button")).toBeNull();
    expect(within(add).getByRole("checkbox", { name: id }).getAttribute("aria-checked")).toBe("true");
    await type(within(add).getByLabelText(`${id}: preço de entrada`), "bad");
    await click(second.querySelector("summary") as Element);
    expect(first.open).toBe(false);
    expect(first.closest(".endpoint-model--open")).toBeNull();
    expect(second.closest(".endpoint-model--open")).not.toBeNull();
    expect(within(second).getByRole("combobox", { name: "second · API do modelo" })).toBeDefined();
    expect(first.querySelector("summary")?.textContent).toContain("Revise os valores inválidos");
    expect(second.querySelector("summary")?.textContent).toContain("Falta preço");
    expect(within(add).getByRole("checkbox", { name: "second" }).getAttribute("aria-checked")).toBe("true");
    await click(within(add).getByRole("checkbox", { name: "second" }));
    expect(second.open).toBe(false);
    expect(add.querySelectorAll(".endpoint-model--open")).toHaveLength(0);
  });

  test("models the provider lists have no Remover; one typed by hand has it only in its open row, under the list's field", async () => {
    const { add } = await openForm(
      seedState({ endpointList: { baseURL: "https://gw.example/v1", models: [{ id: "llama-4" }, { id: "qwen-3" }] } }),
    );
    await type(within(add).getByLabelText("Endereço"), "https://gw.example/v1");
    await click(within(add).getByRole("button", { name: "Buscar modelos" }));
    const typed = within(add).getByLabelText("Adicionar um modelo");
    await type(typed, "my-finetune");
    await act(async () => fireEvent.keyDown(typed, { key: "Enter" }));
    await settle();
    const rows = () => [...add.querySelectorAll<HTMLElement>(".endpoint-model")];
    const row = (id: string) => rows().find((r) => r.querySelector(".endpoint-model__name")?.textContent === id);
    expect(rows().map((r) => r.querySelector(".endpoint-model__name")?.textContent)).toEqual([
      "llama-4",
      "qwen-3",
      "my-finetune",
    ]);
    // Typing an id is the fallback: its field comes after every row.
    const last = rows().at(-1) as HTMLElement;
    expect(last.compareDocumentPosition(typed) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Closed rows carry no action of their own beside the chevron.
    expect(add.querySelectorAll(".endpoint-model > .ac-btn")).toHaveLength(0);
    // Only the typed model has a Remover at all, and it lives in its row's panel (a closed `<details>` hides it).
    const removers = [...add.querySelectorAll("button")].filter((b) => b.textContent?.startsWith("Remover "));
    expect(removers.map((b) => b.textContent)).toEqual(["Remover my-finetune"]);
    expect(removers[0]?.closest("details:not([open]) .ac-disclosure__body")).not.toBeNull();

    await click(row("llama-4")?.querySelector("summary") as Element);
    expect(row("llama-4")?.querySelector(".endpoint-model__capabilities")).not.toBeNull();
    expect(within(add).queryByRole("button", { name: "Remover llama-4" })).toBeNull();

    await click(within(add).getByRole("checkbox", { name: "qwen-3" }));
    await click(row("my-finetune")?.querySelector("summary") as Element);
    expect(row("llama-4")?.querySelector("details")?.open).toBe(false);
    const remove = within(add).getByRole("button", { name: "Remover my-finetune" });
    expect(remove.closest(".endpoint-model__capabilities")).not.toBeNull();
    expect(remove.closest("summary")).toBeNull();
    await click(remove);
    expect(row("my-finetune")).toBeUndefined();
    expect(add.querySelectorAll(".endpoint-model--open")).toHaveLength(0);
    expect(document.activeElement).toBe(typed);
    // The rest keep their selection: removing one model never unticks another.
    expect(within(add).getByRole("checkbox", { name: "llama-4" }).getAttribute("aria-checked")).toBe("true");
    expect(within(add).getByRole("checkbox", { name: "qwen-3" }).getAttribute("aria-checked")).toBe("true");
  });

  test("an id typed by hand that the provider then lists is the provider's: no Remover once fetched", async () => {
    const { add } = await openForm(
      seedState({ endpointList: { baseURL: "https://gw.example/v1", models: [{ id: "llama-4" }] } }),
    );
    await type(within(add).getByLabelText("Endereço"), "https://gw.example/v1");
    const typed = within(add).getByLabelText("Adicionar um modelo");
    await type(typed, "llama-4");
    await act(async () => fireEvent.keyDown(typed, { key: "Enter" }));
    await settle();
    await click(add.querySelector(".endpoint-model summary") as Element);
    expect(within(add).getByRole("button", { name: "Remover llama-4" })).toBeDefined();
    await click(within(add).getByRole("button", { name: "Buscar modelos" }));
    expect(add.querySelectorAll(".endpoint-model")).toHaveLength(1);
    expect(within(add).getByRole("checkbox", { name: "llama-4" }).getAttribute("aria-checked")).toBe("true");
    expect(within(add).queryByRole("button", { name: "Remover llama-4" })).toBeNull();
  });

  test("a long list gets a search over it: ticked models stay on top, the rest filter by their id, no select-all", async () => {
    const ids = [
      ...["deepseek-v4", "deepseek-r2", "kimi-k2", "glm-5", "minimax-m2"],
      ...Array.from({ length: 10 }, (_, i) => `qwen3-${i + 1}b`),
    ];
    const { add } = await openForm(
      seedState({ endpointList: { baseURL: "https://gw.example/v1", models: ids.map((id) => ({ id })) } }),
    );
    await type(within(add).getByLabelText("Endereço"), "https://gw.example/v1");
    await click(within(add).getByRole("button", { name: "Buscar modelos" }));
    const rows = () => [...add.querySelectorAll(".endpoint-model__name")].map((l) => l.textContent);
    expect(rows()).toHaveLength(15);
    await click(within(add).getByRole("checkbox", { name: "kimi-k2" }));
    const search = within(add).getByRole("searchbox", { name: "Buscar modelo" });
    await type(search, "QWEN3-1");
    // What is ticked stays on top, whatever is typed.
    expect(rows()).toEqual(["kimi-k2", "qwen3-1b", "qwen3-10b"]);
    // Ticking a match doesn't move it under the pointer.
    await click(within(add).getByRole("checkbox", { name: "qwen3-10b" }));
    expect(rows()).toEqual(["kimi-k2", "qwen3-1b", "qwen3-10b"]);
    await type(search, "nada");
    expect(rows()).toEqual(["kimi-k2", "qwen3-10b"]);
    expect(within(add).queryByRole("checkbox", { name: /todos/i })).toBeNull();
    await click(within(add).getByRole("button", { name: "Limpar busca" }));
    expect(rows()).toHaveLength(15);
  });

  test("twelve models or fewer: no search over them", async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `m-${i}`);
    const { add } = await openForm(
      seedState({ endpointList: { baseURL: "https://gw.example/v1", models: ids.map((id) => ({ id })) } }),
    );
    await type(within(add).getByLabelText("Endereço"), "https://gw.example/v1");
    await click(within(add).getByRole("button", { name: "Buscar modelos" }));
    expect(add.querySelectorAll(".endpoint-model")).toHaveLength(12);
    expect(within(add).queryByRole("searchbox")).toBeNull();
  });

  test("Enter adds a typed model, Remover in its open row takes it off, and while saving every control is off", async () => {
    const { add, api } = await openForm();
    await type(within(add).getByLabelText("Nome"), "OpenGateway");
    await type(within(add).getByLabelText("Endereço"), "https://gw.example/v1");
    const typed = within(add).getByLabelText("Adicionar um modelo");
    for (const id of ["llama-4", "qwen-3"]) {
      await type(typed, id);
      await act(async () => fireEvent.keyDown(typed, { key: "Enter" }));
      await settle();
    }
    expect((typed as HTMLInputElement).value).toBe("");
    await click(add.querySelectorAll(".endpoint-model summary")[1] as Element);
    await click(within(add).getByRole("button", { name: "Remover qwen-3" }));
    expect(within(add).queryByRole("checkbox", { name: "qwen-3" })).toBeNull();
    expect(within(add).getByRole("checkbox", { name: "llama-4" })).toBeDefined();

    (api.agents as { addCredential: unknown }).addCredential = () => new Promise(() => {});
    await click(within(add).getByRole("button", { name: "Salvar e testar" }));
    expect(add.textContent).toContain("Testando cada modelo…");
    expect(within(add).getByRole("button", { name: "Cancelar" }).hasAttribute("disabled")).toBe(true);
    expect(add.querySelector("fieldset.ac-locked")?.hasAttribute("disabled")).toBe(true);
    expect(
      add.querySelector("fieldset.ac-locked")?.contains(within(add).getByRole("combobox", { name: "Provedor" })),
    ).toBe(true);
  });
});
