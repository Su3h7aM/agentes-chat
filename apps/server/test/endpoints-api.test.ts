import { afterEach, expect, test } from "bun:test";
import { customModelId } from "@agenteschat/providers";
import { browser, createTestServer, joinByInvitation, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
afterEach(() => t.close());

/** A gateway's model list, as `GET /v1/models` answers. */
const gatewayList = (async (url: string | URL | Request) =>
  String(url) === "https://gw.example/v1/models"
    ? new Response(
        JSON.stringify({
          data: [{ id: "llama-4", context_length: 32_000, pricing: { prompt: "0.000002" } }, { id: "qwen-3" }],
        }),
      )
    : new Response("not found", { status: 404 })) as unknown as typeof fetch;

const resolveHost = async (host: string) => (host === "inside.example" ? ["10.0.0.7"] : ["93.184.216.34"]);

const endpoint = {
  style: "openai",
  baseURL: "https://gw.example/v1",
  models: [{ id: "llama-4", prices: { input: 1, output: 2 } }, { id: "qwen-3" }],
};

test("an endpoint: its list, saved with a test per model, its models in the pickers, admins only", async () => {
  t = await createTestServer({ http: gatewayList, resolveHost });
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);

  const listed = await api("/credentials/endpoint-models", {
    json: { style: "openai", baseURL: "https://gw.example/v1/", apiKey: "gw-key-1234567" },
  });
  expect(await listed.json()).toEqual({
    baseURL: "https://gw.example/v1",
    models: [
      {
        id: "llama-4",
        discovered: {
          contextWindow: { source: "endpoint", value: 32_000, discoveredAt: expect.any(String) },
          prices: { input: { source: "endpoint", value: 2, discoveredAt: expect.any(String) } },
        },
      },
      { id: "qwen-3" },
    ],
  });

  const created = await api("/credentials", {
    json: { provider: "custom", label: "OpenGateway", apiKey: "gw-key-1234567", endpoint },
  });
  expect(created.status).toBe(201);
  const key = (await created.json()) as {
    id: string;
    keyHint: string;
    endpoint: { models: { id: string; prices?: { input: number }; check?: string }[] };
    checks: { model: string; check: string }[];
  };
  expect(JSON.stringify(key)).not.toContain("gw-key-1234567");
  // The fake model answers in text: the endpoint works, without tools.
  expect(key.checks).toEqual([
    { model: "llama-4", check: "no_tools" },
    { model: "qwen-3", check: "no_tools" },
  ]);
  expect(key.endpoint.models[0]?.prices?.input).toBe(1);

  const rediscovered = await api("/credentials/endpoint-models", { json: { credentialId: key.id } });
  expect(rediscovered.status).toBe(200);
  expect(await rediscovered.json()).toMatchObject({ models: [{ id: "llama-4" }, { id: "qwen-3" }] });
  const probe = await api(`/credentials/${key.id}/probe`, { json: { models: ["qwen-3"] } });
  expect(probe.status).toBe(200);
  const probeResult = (await probe.json()) as { models: { id: string; discovered?: unknown }[] };
  expect(probeResult.models[1]).toMatchObject({ id: "qwen-3" });
  expect(probeResult.models[1]?.discovered).toBeUndefined();

  const models = (await (await owner("/api/app/models")).json()) as {
    models: { id: string; provider: string; endpoint?: { credentialId: string; name: string }; unpriced?: boolean }[];
  };
  const llama = models.models.find((m) => m.id === customModelId(key.id, "llama-4"));
  expect(llama).toMatchObject({ provider: "custom", endpoint: { credentialId: key.id, name: "OpenGateway" } });
  expect(llama?.unpriced).toBeUndefined();
  expect(models.models.find((m) => m.id === customModelId(key.id, "qwen-3"))?.unpriced).toBe(true);
  const orgModels = (await (await api("/models")).json()) as { models: { id: string; available: boolean }[] };
  expect(orgModels.models.find((m) => m.id === customModelId(key.id, "qwen-3"))?.available).toBe(true);

  const overrides = { contextWindow: 64_000, image: false, pdf: true, prices: { input: 0, output: 0.125 } };
  const changed = await api(`/credentials/${key.id}/models`, {
    method: "PUT",
    json: { models: [{ id: "qwen-3", prices: { input: 0.5, output: 1 }, overrides }] },
  });
  expect(changed.status).toBe(200);
  expect(((await changed.json()) as { models: unknown[] }).models).toEqual([
    {
      id: "qwen-3",
      prices: { input: 0.5, output: 1, cacheRead: 0.5, cacheWrite: 0.5 },
      overrides,
      check: "no_tools",
    },
  ]);

  // A member neither lists, adds nor changes one.
  const member = await joinByInvitation(t, owner, orgId, "bia@example.com");
  const asMember = (path: string, init?: Parameters<typeof member>[1]) =>
    member(`/api/app/organizations/${orgId}${path}`, init);
  expect(
    (await asMember("/credentials/endpoint-models", { json: { style: "openai", baseURL: "https://gw.example/v1" } }))
      .status,
  ).toBe(403);
  expect(
    (await asMember("/credentials", { json: { provider: "custom", label: "x", apiKey: "", endpoint } })).status,
  ).toBe(403);
  expect((await asMember(`/credentials/${key.id}/models`, { method: "PUT", json: { models: [] } })).status).toBe(403);
});

test("on the Cloud's rules: http, internal and private addresses are refused", async () => {
  t = await createTestServer({ http: gatewayList, resolveHost, env: { MODEL_ENDPOINTS_PRIVATE: "false" } });
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  for (const baseURL of [
    "http://gw.example/v1",
    "https://localhost:11434/v1",
    "https://inside.example/v1",
    "https://169.254.169.254/v1",
  ]) {
    const listed = await owner(`/api/app/organizations/${orgId}/credentials/endpoint-models`, {
      json: { style: "openai", baseURL },
    });
    expect(listed.status).toBe(400);
    const saved = await owner(`/api/app/organizations/${orgId}/credentials`, {
      json: { provider: "custom", label: "x", apiKey: "k-12345678", endpoint: { ...endpoint, baseURL } },
    });
    expect(saved.status).toBe(400);
  }
});

test("legacy model writes retain newer per-field discovery and return converted prices", async () => {
  t = await createTestServer({ http: gatewayList, resolveHost });
  const owner = browser(t);
  await signUp(owner, "legacy@example.com");
  const { orgId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);
  const date = "2026-01-01T00:00:00.000Z";
  const created = await api("/credentials", {
    json: {
      provider: "custom",
      label: "gateway",
      apiKey: "key",
      endpoint: {
        style: "openai",
        baseURL: "https://gw.example/v1",
        models: [
          {
            id: "m",
            discovered: {
              contextWindow: { value: 32000, source: "endpoint", discoveredAt: date },
              prices: {
                input: { value: 0, source: "endpoint", discoveredAt: date },
                output: { value: 1.5, source: "endpoint", discoveredAt: date },
              },
            },
          },
        ],
      },
    },
  });
  expect(created.status).toBe(201);
  const key = (await created.json()) as { id: string };
  const changed = await api(`/credentials/${key.id}/models`, {
    method: "PUT",
    json: {
      models: [
        {
          id: "m",
          discovered: {
            discoveredAt: "2026-02-01T00:00:00.000Z",
            limits: { source: "catalog", value: { contextWindow: 1000, maxOutputTokens: 2000 } },
            prices: { source: "catalog", value: { input: 5, cacheRead: 0.25 } },
            image: { source: "probe", value: false },
          },
        },
      ],
    },
  });
  expect(changed.status).toBe(200);
  const result = (await changed.json()) as { models: { discovered: unknown }[] };
  expect(result.models[0]?.discovered).toEqual({
    contextWindow: { value: 32000, source: "endpoint", discoveredAt: date },
    maxOutputTokens: { value: 2000, source: "catalog", discoveredAt: "2026-02-01T00:00:00.000Z" },
    prices: {
      input: { value: 0, source: "endpoint", discoveredAt: date },
      output: { value: 1.5, source: "endpoint", discoveredAt: date },
      cacheRead: { value: 0.25, source: "catalog", discoveredAt: "2026-02-01T00:00:00.000Z" },
    },
    image: { source: "probe", value: false, discoveredAt: "2026-02-01T00:00:00.000Z" },
  });
});

test("discovered prices round-trip nano units without rounding to whole dollars", async () => {
  t = await createTestServer({ http: gatewayList, resolveHost });
  const { modelIn, modelOut } = await import("../src/routes/app/credential-view");
  const discoveredAt = "2026-01-01T00:00:00.000Z";
  const stored = {
    id: "m",
    discovered: {
      prices: {
        input: { value: 1234567, source: "endpoint" as const, discoveredAt },
        output: { value: 1, source: "catalog" as const, discoveredAt },
      },
    },
  };
  expect(modelIn(modelOut(stored))).toEqual(stored);
});

test("model API schema preserves future model fields", async () => {
  t = await createTestServer({ http: gatewayList, resolveHost });
  const { EndpointModel } = await import("../src/routes/app/schemas");
  const { modelIn } = await import("../src/routes/app/credential-view");
  expect(modelIn(EndpointModel.parse({ id: "m", futureSetting: { enabled: true } })) as unknown).toEqual({
    id: "m",
    futureSetting: { enabled: true },
  });
});
