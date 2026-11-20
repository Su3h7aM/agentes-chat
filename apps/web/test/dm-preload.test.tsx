import { afterEach, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { ApiError, keys } from "@agenteschat/client";
import { act, cleanup } from "@testing-library/react";
import { ADA_ID, createFakeApi, GENERAL_ID, ORG_ID, seedDm, seedState } from "./fake-api";
import { renderApp, settle } from "./render";

afterEach(() => cleanup());

for (const partner of [
  { type: "agent" as const, id: ADA_ID },
  { type: "person" as const, id: "u-walter" },
]) {
  test(`preloads a known ${partner.type} DM while open is pending, but waits for confirmation`, async () => {
    const state = seedState();
    const api = createFakeApi(state);
    const open = api.dms.open;
    const messages = api.chat.messages;
    const asked: string[] = [];
    let release = () => {};
    api.dms.open = async (orgId, target) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return open(orgId, target);
    };
    api.chat.messages = (orgId, id, options) => {
      if (!options?.threadId) asked.push(id);
      return messages(orgId, id, options);
    };
    const { router, services } = await renderApp(`/org/${ORG_ID}/issues`, { api });
    await settle(6);
    const channelId = seedDm(state, partner, { body: "Histórico conhecido" });
    services.queryClient.setQueryData(keys.dms(ORG_ID), [...state.dms]);
    try {
      await act(async () => {
        if (partner.type === "agent")
          await router.navigate({
            to: "/org/$orgId/dm/agent/$agentId",
            params: { orgId: ORG_ID, agentId: partner.id },
          });
        else
          await router.navigate({ to: "/org/$orgId/dm/person/$userId", params: { orgId: ORG_ID, userId: partner.id } });
      });
      await settle(6);
      expect(asked).toContain(channelId);
      expect(document.body.textContent).not.toContain("Histórico conhecido");
      expect(Boolean(document.querySelector(".channel__name"))).toBe(false);
    } finally {
      await act(async () => release());
    }
    await settle(6);
    expect(document.body.textContent).toContain("Histórico conhecido");
  });
}

for (const status of [403, 404]) {
  test(`open returning ${status} never exposes the cached conversation`, async () => {
    const state = seedState();
    seedDm(state, { type: "agent", id: ADA_ID }, { body: "Histórico privado" });
    const api = createFakeApi(state);
    api.dms.open = async () => {
      throw new ApiError(status, status === 404 ? "not_found" : "forbidden", "Denied");
    };
    const { router } = await renderApp(`/org/${ORG_ID}/issues`, { api });
    await settle(6);
    await act(async () => {
      await router.navigate({ to: "/org/$orgId/dm/agent/$agentId", params: { orgId: ORG_ID, agentId: ADA_ID } });
    });
    await settle(6);
    expect(Boolean(document.querySelector(".channel__name"))).toBe(false);
    expect(document.body.textContent).not.toContain("Histórico privado");
    expect(document.querySelector(".page--mid")).toBeTruthy();
  });
}

test("without a cached DM the server opens it before history is requested", async () => {
  const state = seedState();
  const api = createFakeApi(state);
  const open = api.dms.open;
  let release = () => {};
  let opened = false;
  const asked: string[] = [];
  const messages = api.chat.messages;
  api.dms.open = async (orgId, target) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    opened = true;
    return open(orgId, target);
  };
  api.chat.messages = (orgId, id, options) => {
    if (!options?.threadId) asked.push(id);
    return messages(orgId, id, options);
  };
  const { router, services } = await renderApp(`/org/${ORG_ID}/issues`, { api });
  await settle(6);
  services.queryClient.removeQueries({ queryKey: keys.dms(ORG_ID), exact: true });
  try {
    await act(async () => {
      await router.navigate({ to: "/org/$orgId/dm/agent/$agentId", params: { orgId: ORG_ID, agentId: ADA_ID } });
    });
    await settle(6);
    expect(opened).toBe(false);
    expect(asked).toEqual([]);
  } finally {
    await act(async () => release());
  }
  await settle(6);
  expect(opened).toBe(true);
  expect(asked.length).toBeGreaterThan(0);
});

test("the channel returned by open takes precedence over a stale cached channel", async () => {
  const state = seedState();
  const oldId = seedDm(state, { type: "agent", id: ADA_ID }, { body: "Histórico antigo" });
  const oldMessage = state.messages.at(-1);
  if (!oldMessage) throw new Error("Expected seeded message");
  state.messages.push({
    ...oldMessage,
    id: "other-message",
    channelId: GENERAL_ID,
    body: "Canal confirmado",
  });
  const api = createFakeApi(state);
  api.dms.open = async () => ({ channelId: GENERAL_ID });
  const asked: string[] = [];
  const messages = api.chat.messages;
  api.chat.messages = (orgId, id, options) => {
    if (!options?.threadId) asked.push(id);
    return messages(orgId, id, options);
  };
  const { router } = await renderApp(`/org/${ORG_ID}/issues`, { api });
  await settle(6);
  await act(async () => {
    await router.navigate({ to: "/org/$orgId/dm/agent/$agentId", params: { orgId: ORG_ID, agentId: ADA_ID } });
  });
  await settle(8);
  expect(asked).toContain(oldId);
  expect(asked).toContain(GENERAL_ID);
  expect(document.body.textContent).toContain("Canal confirmado");
  expect(document.body.textContent).not.toContain("Histórico antigo");
});
