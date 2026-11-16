import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { Credential, JevKey } from "@agenteschat/client";
import { ApiError } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createFakeApi, OPENROUTER_KEY, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const click = async (el: Element, rounds = 4) => {
  await act(async () => fireEvent.click(el));
  await settle(rounds);
};
const type = (el: Element, value: string) => act(async () => fireEvent.change(el, { target: { value } }));
const open = async (patch: Partial<ReturnType<typeof seedState>> = {}) => {
  const state = seedState(patch);
  const result = await renderApp(`/org/${ORG_ID}/settings/keys`, { api: createFakeApi(state) });
  await settle(5);
  return { ...result, state };
};
const decision = () => screen().getByRole("region", { name: "Quem escolhe os agentes" });
const radio = (name: string) => within(decision()).getByRole("radio", { name });
const calls = (state: ReturnType<typeof seedState>, method: string) =>
  state.calls.filter((c) => c.method === method).map((c) => c.args);
const OFF: JevKey = { source: null, via: null, hint: null, state: "off", month: { decisions: 0, costUsd: 0 } };

const CUSTOM_KEY: Credential = {
  id: "cred-custom",
  provider: "custom",
  label: "Magpie",
  keyHint: "9f3c",
  createdAt: "2026-11-01T10:00:00.000Z",
  revokedAt: null,
  endpoint: {
    style: "openai",
    baseURL: "https://magpie.example/v1",
    models: [{ id: "magpie/decision-1", label: "Magpie Decision 1" }],
  },
};

const chooseOtherModel = async (label: string, id: string) => {
  await click(within(decision()).getByRole("combobox", { name: label }));
  await click(screen().getByRole("option", { name: "Outro modelo…" }));
  await type(within(decision()).getByLabelText("ID do modelo"), id);
};

describe("a workspace's decision models in Settings › AI and usage", () => {
  test("one card always offers Jev, OpenRouter and Custom, even without those credentials", async () => {
    await open({ jev: OFF });
    expect(decision().textContent).toContain("Provedor de decisões");
    expect(radio("Jev (TypeSafe)").getAttribute("aria-checked")).toBe("true");
    expect(radio("OpenRouter")).toBeTruthy();
    expect(radio("Personalizado")).toBeTruthy();
    expect(screen().queryByRole("region", { name: "Jev" })).toBeNull();

    // Jev is the installation's key setup, never a model or address field.
    expect(within(decision()).getByRole("button", { name: "Configurar o Jev" })).toBeTruthy();
    expect(within(decision()).queryByLabelText("Modelo de decisão")).toBeNull();
    expect(within(decision()).queryByLabelText("Endereço")).toBeNull();

    await click(radio("OpenRouter"));
    expect(decision().textContent).toContain("Não há chave da OpenRouter neste workspace.");
    expect(within(decision()).getByRole("link", { name: "Chaves de provedor" }).getAttribute("href")).toBe("#sec-keys");
    expect(within(decision()).queryByLabelText("Chave de API")).toBeNull();
    expect(within(decision()).queryByLabelText("Endereço")).toBeNull();
    expect(within(decision()).queryByText("Criar endpoint System One")).toBeNull();

    await click(radio("Personalizado"));
    expect(decision().textContent).toContain("Não há endpoint personalizado neste workspace.");
    expect(within(decision()).getByRole("link", { name: "Chaves de provedor" }).getAttribute("href")).toBe("#sec-keys");
  });

  test("OpenRouter reuses its live key, offers known models and Other, and saves through the probe", async () => {
    const { state } = await open({
      jev: OFF,
      credentials: [...seedState().credentials, OPENROUTER_KEY],
    });
    await click(radio("OpenRouter"));
    expect(within(decision()).getByRole("combobox", { name: "Conta" }).textContent).toContain("OpenRouter");
    expect(within(decision()).getByRole("combobox", { name: "Modelo de decisão" }).textContent).toContain("Jev 1.14");
    expect(within(decision()).queryByLabelText("Endereço")).toBeNull();
    expect(within(decision()).queryByLabelText("Chave de API")).toBeNull();

    await chooseOtherModel("Modelo de decisão", " vendor/decision-1 ");
    await click(within(decision()).getByRole("button", { name: "Testar e salvar" }), 6);

    expect(calls(state, "system.saveDecisions")).toEqual([
      [
        ORG_ID,
        {
          credentialId: OPENROUTER_KEY.id,
          model: "vendor/decision-1",
          visionModel: "typesafe/jev-1.14",
        },
      ],
    ]);
    expect(decision().textContent).toContain("Salvo. O teste passou.");
    expect(document.body.innerHTML).not.toContain("sk-or-");

    await type(within(decision()).getByLabelText("ID do modelo"), "vendor/decision-2");
    expect(decision().textContent).not.toContain("Salvo. O teste passou.");
  });

  test("a refused probe keeps the OpenRouter mode and every draft field", async () => {
    const { state } = await open({
      jev: OFF,
      credentials: [...seedState().credentials, OPENROUTER_KEY],
      decisionSaveError: new ApiError(422, "decision_check_failed", "The decision service refused it."),
    });
    await click(radio("OpenRouter"));
    await chooseOtherModel("Modelo de decisão", "vendor/decision-1");
    await click(within(decision()).getByRole("button", { name: "Testar e salvar" }), 6);

    expect(decision().textContent).toContain("Não foi possível testar este modelo. Tente de novo.");
    expect(radio("OpenRouter").getAttribute("aria-checked")).toBe("true");
    expect((within(decision()).getByLabelText("ID do modelo") as HTMLInputElement).value).toBe("vendor/decision-1");
    expect((within(decision()).getByRole("combobox", { name: "Conta" }) as HTMLElement).textContent).toContain(
      "OpenRouter",
    );
    expect(state.decisions?.settings ?? null).toBeNull();
  });

  test("a refusal names the side that failed, in the workspace's words", async () => {
    await open({
      jev: OFF,
      credentials: [...seedState().credentials, OPENROUTER_KEY],
      decisionSaveError: new ApiError(422, "decision_check_refused", "The endpoint refused this account's key."),
    });
    await click(radio("OpenRouter"));
    await chooseOtherModel("Modelo de decisão", "vendor/decision-1");
    await click(within(decision()).getByRole("button", { name: "Testar e salvar" }), 6);

    expect(decision().textContent).toContain(
      "O endpoint recusou a chave desta conta. Confira a chave em Chaves de provedores.",
    );
  });

  test("an endpoint override refusal names Custom only and keeps the OpenRouter draft", async () => {
    const { state } = await open({
      jev: OFF,
      credentials: [...seedState().credentials, OPENROUTER_KEY],
      decisionSaveError: new ApiError(422, "decision_endpoint_unsupported", "OpenRouter decides at its own route."),
    });
    await click(radio("OpenRouter"));
    await chooseOtherModel("Modelo de decisão", "vendor/decision-1");
    await click(within(decision()).getByRole("button", { name: "Testar e salvar" }), 6);

    expect(decision().textContent).toContain(
      "Um endpoint completo vale só para uma conta de decisão Personalizada. Limpe o campo para usar Jev ou OpenRouter.",
    );
    expect(decision().textContent).not.toContain("Confira o endereço");
    expect(radio("OpenRouter").getAttribute("aria-checked")).toBe("true");
    expect((within(decision()).getByLabelText("ID do modelo") as HTMLInputElement).value).toBe("vendor/decision-1");
    expect(state.decisions?.settings ?? null).toBeNull();
  });

  test("Custom uses an existing chat endpoint, previews the derived address and sends an optional full endpoint", async () => {
    const { state } = await open({
      jev: OFF,
      credentials: [...seedState().credentials, CUSTOM_KEY],
    });
    await click(radio("Personalizado"));
    expect(within(decision()).getByRole("combobox", { name: "Conta" }).textContent).toContain("Magpie");
    expect(decision().textContent).toContain("As chamadas vão para");
    expect(decision().querySelector(".jev-decision__endpoint")?.textContent).toContain(
      "https://magpie.example/v1/systemone",
    );
    expect(within(decision()).queryByLabelText("Chave de API")).toBeNull();
    expect(within(decision()).queryByLabelText("Endereço")).toBeNull();
    expect(within(decision()).queryByText("Criar endpoint System One")).toBeNull();

    // The full endpoint is optional and outside the normal fields.
    await click(within(decision()).getByText("Avançado"));
    const endpoint = within(decision()).getByLabelText("Endpoint completo (opcional)") as HTMLInputElement;
    expect(endpoint.placeholder).toBe("https://magpie.example/v1/systemone");
    await click(within(decision()).getByRole("button", { name: "Testar e salvar" }), 6);
    expect(calls(state, "system.saveDecisions")[0]?.[1]).toEqual({
      credentialId: CUSTOM_KEY.id,
      model: "magpie/decision-1",
      visionModel: "magpie/decision-1",
    });
    const notice = () => decision().querySelector(".jev-decision__endpoint")?.textContent ?? "";
    expect(decision().textContent).toContain("Salvo. O teste passou.");

    await type(endpoint, "https://magpie.example/decisions");
    expect(notice()).toContain("https://magpie.example/decisions");
    expect(endpoint.placeholder).toBe("https://magpie.example/v1/systemone");
    expect(decision().textContent).not.toContain("Salvo. O teste passou.");
    await click(within(decision()).getByRole("button", { name: "Testar e salvar" }), 6);
    expect(calls(state, "system.saveDecisions")[1]?.[1]).toEqual({
      credentialId: CUSTOM_KEY.id,
      model: "magpie/decision-1",
      visionModel: "magpie/decision-1",
      endpoint: "https://magpie.example/decisions",
    });

    await type(endpoint, "");
    expect(notice()).toContain("https://magpie.example/v1/systemone");
    expect(decision().textContent).not.toContain("Salvo. O teste passou.");
  });

  test("drafts stay separate by mode, and a failed Jev reset keeps the working mode and draft", async () => {
    const { state } = await open({
      jev: OFF,
      credentials: [...seedState().credentials, OPENROUTER_KEY, CUSTOM_KEY],
      decisions: {
        settings: { credentialId: OPENROUTER_KEY.id, model: "typesafe/jev-1.14", visionModel: null },
        available: true,
      },
      decisionResetError: new ApiError(503, "unavailable", "The reset failed."),
    });
    expect(radio("OpenRouter").getAttribute("aria-checked")).toBe("true");
    await chooseOtherModel("Modelo de decisão", "vendor/openrouter-draft");
    await click(radio("Personalizado"));
    await chooseOtherModel("Modelo de decisão", "vendor/custom-draft");
    await click(radio("OpenRouter"));
    expect((within(decision()).getByLabelText("ID do modelo") as HTMLInputElement).value).toBe(
      "vendor/openrouter-draft",
    );

    await click(radio("Jev (TypeSafe)"), 6);
    expect(radio("OpenRouter").getAttribute("aria-checked")).toBe("true");
    expect(decision().textContent).toContain("Algo deu errado do nosso lado.");
    expect((within(decision()).getByLabelText("ID do modelo") as HTMLInputElement).value).toBe(
      "vendor/openrouter-draft",
    );
    expect(calls(state, "system.resetDecisions")).toEqual([[ORG_ID]]);
  });

  test("an unavailable credential stays visible and disables saving", async () => {
    const revoked = {
      ...OPENROUTER_KEY,
      id: "cred-revoked",
      label: "OpenRouter antiga",
      revokedAt: "2026-11-15T12:00:00.000Z",
    };
    await open({
      jev: OFF,
      credentials: [...seedState().credentials, revoked],
      decisions: { settings: { credentialId: revoked.id, model: "old/model", visionModel: null }, available: false },
    });
    expect(decision().textContent).toContain("OpenRouter antiga");
    expect(decision().textContent).toContain(
      "A conta escolhida não está disponível. Escolha outra ou volte ao Jev da instalação.",
    );
    expect((within(decision()).getByRole("button", { name: "Testar e salvar" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(within(decision()).getByRole("combobox", { name: "Conta" }).textContent).toContain("OpenRouter antiga");
  });

  test("a draft whose account is revoked after opening cannot save and keeps its model", async () => {
    const { state, services } = await open({
      jev: OFF,
      credentials: [...seedState().credentials, OPENROUTER_KEY],
      decisions: {
        settings: { credentialId: OPENROUTER_KEY.id, model: "typesafe/jev-1.14", visionModel: null },
        available: true,
      },
    });
    await chooseOtherModel("Modelo de decisão", "vendor/decision-1");
    state.credentials = state.credentials.map((credential) =>
      credential.id === OPENROUTER_KEY.id ? { ...credential, revokedAt: "2026-11-16T12:00:00.000Z" } : credential,
    );
    await act(async () => {
      await services.queryClient.invalidateQueries();
    });
    await settle(5);
    expect(decision().textContent).toContain("Esta conta foi removida ou revogada.");
    expect((within(decision()).getByLabelText("ID do modelo") as HTMLInputElement).value).toBe("vendor/decision-1");
    expect((within(decision()).getByRole("button", { name: "Testar e salvar" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  test("a saved copy stands for its live base row and still saves", async () => {
    const base = { ...CUSTOM_KEY, copies: 1 };
    const copy = { ...CUSTOM_KEY, id: "cred-copy", copyOf: CUSTOM_KEY.id, copies: undefined };
    const { state } = await open({
      jev: OFF,
      credentials: [...seedState().credentials, base, copy],
      decisions: {
        settings: { credentialId: copy.id, model: "magpie/decision-1", visionModel: null },
        available: true,
      },
    });
    expect(within(decision()).getByRole("combobox", { name: "Conta" }).textContent).toContain("Magpie");
    expect(decision().textContent).not.toContain("Esta conta foi removida ou revogada.");
    const save = within(decision()).getByRole("button", { name: "Testar e salvar" }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    await click(save, 6);
    expect(calls(state, "system.saveDecisions")[0]?.[1]).toMatchObject({ credentialId: base.id });
  });

  test("a member with no manage_credentials sees no decision settings", async () => {
    const state = seedState({ credentials: [...seedState().credentials, OPENROUTER_KEY] });
    const org = state.me?.organizations[0];
    if (org) {
      org.role = "member";
      org.permissions = ["read", "post"];
    }
    await renderApp(`/org/${ORG_ID}/settings/keys`, { api: createFakeApi(state) });
    await settle(5);
    expect(screen().queryByRole("region", { name: "Quem escolhe os agentes" })).toBeNull();
  });

  test("a 200-character model id wraps inside its own box, while short facts stay whole", async () => {
    const id = `vendor/${"a".repeat(193)}`;
    expect(id).toHaveLength(200);
    await open({
      jev: OFF,
      credentials: [...seedState().credentials, OPENROUTER_KEY],
      decisions: { settings: { credentialId: OPENROUTER_KEY.id, model: id, visionModel: id }, available: true },
    });
    const ids = [...decision().querySelectorAll(".jev__id")];
    expect(ids.map((el) => el.textContent)).toContain(id);
    expect(ids.some((el) => el.textContent === `Com visão: ${id}`)).toBe(true);
    expect(ids.every((el) => el.classList.contains("jev__fact"))).toBe(true);
    const css = readFileSync(new URL("../src/layout.css", import.meta.url), "utf8");
    expect(css).toContain(".jev__id {\n  white-space: normal;\n  overflow-wrap: anywhere;\n}");
  });
});
