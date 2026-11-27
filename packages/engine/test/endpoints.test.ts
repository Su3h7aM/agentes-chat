import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { contextWindowOf, customModelId, MODEL_CATALOG, ProviderError } from "@agenteschat/providers";
import {
  agentAiState,
  allowsPrivateEndpoints,
  BudgetExceededError,
  backfillEndpointCatalog,
  checkCredential,
  checkEndpoint,
  cleanEndpointModels,
  createAgent,
  createCredential,
  type EndpointModel,
  endpointAddress,
  endpointPricesFromUsd,
  listCredentials,
  listEndpoint,
  modelInfoFor,
  pickerModels,
  rotateCredential,
  updateAgent,
  updateEndpointModels,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(() => f?.close());

/** DNS as a test sees it: `gw.example` is public, `inside.example` resolves to a private address. */
const resolveHost = async (host: string) =>
  host === "inside.example" ? ["10.0.0.7"] : host === "meta.example" ? ["169.254.169.254"] : ["93.184.216.34"];
const cloud = { allowPrivate: false, resolveHost };
const selfHost = { allowPrivate: true, resolveHost };

const addEndpoint = (
  fx: Fixture,
  models: EndpointModel[] = [{ id: "llama-4", prices: endpointPricesFromUsd({ input: 1, output: 2 }) }],
) =>
  createCredential(
    fx.db,
    fx.keyWrapper,
    fx.owner.id,
    fx.org.id,
    {
      provider: "custom",
      label: "OpenGateway",
      apiKey: "gw-key-1234567",
      endpoint: { style: "openai", baseURL: "https://gw.example/v1/chat/completions/", models },
    },
    { net: cloud },
  );

describe("the address", () => {
  test("the Cloud refuses http, internal names, private and metadata addresses; self-host allows them", async () => {
    for (const raw of [
      "http://gw.example/v1",
      "https://localhost:11434/v1",
      "https://inside.example/v1",
      "https://meta.example/v1",
      "https://10.1.2.3/v1",
    ]) {
      await expect(endpointAddress(raw, "openai", cloud)).rejects.toThrow();
    }
    expect(await endpointAddress("http://localhost:11434/v1/", "openai", selfHost)).toBe("http://localhost:11434/v1");
    await expect(endpointAddress("ftp://x.example", "openai", selfHost)).rejects.toThrow();
    await expect(endpointAddress("https://u:p@gw.example/v1", "openai", selfHost)).rejects.toThrow();
  });

  test("the path the SDK adds is left out", async () => {
    expect(await endpointAddress("https://gw.example/v1/chat/completions?x=1", "openai", cloud)).toBe(
      "https://gw.example/v1",
    );
    expect(await endpointAddress("https://gw.example/anthropic/v1/messages", "anthropic", cloud)).toBe(
      "https://gw.example/anthropic/v1",
    );
    expect(await endpointAddress("https://gw.example/v1/responses", "openai", cloud)).toBe("https://gw.example/v1");
    expect(await endpointAddress("https://gw.example/v1/models", "openai", cloud)).toBe("https://gw.example/v1");
  });

  test("API check timestamps compare instants across ISO formats", () => {
    const old = [{ id: "m", apiCheckedAt: "2026-01-01T00:00:00Z" }];
    expect(cleanEndpointModels([{ id: "m", apiCheckedAt: "2026-01-01T00:00:00.000Z" }], old)[0]?.apiCheckedAt).toBe(
      "2026-01-01T00:00:00Z",
    );
    const newer = cleanEndpointModels([{ id: "m", apiCheckedAt: "2026-01-01T00:00:00.001Z" }], old);
    expect(newer[0]?.apiCheckedAt).toBe("2026-01-01T00:00:00.001Z");
    expect(cleanEndpointModels([{ id: "m", apiCheckedAt: "2026-01-01T00:00:00Z" }], newer)[0]?.apiCheckedAt).toBe(
      "2026-01-01T00:00:00.001Z",
    );
  });

  test("private addresses: on by default, off on agentes.chat Cloud, the flag wins", () => {
    expect(allowsPrivateEndpoints({ PUBLIC_URL: "https://chat.example.com" })).toBe(true);
    expect(allowsPrivateEndpoints({ PUBLIC_URL: "https://app.agentes.chat" })).toBe(false);
    expect(allowsPrivateEndpoints({ PUBLIC_URL: "https://chat.example.com", ALLOW_SIGNUP: true })).toBe(false);
    expect(allowsPrivateEndpoints({ PUBLIC_URL: "https://chat.example.com", MODEL_ENDPOINTS_PRIVATE: false })).toBe(
      false,
    );
  });
});

describe("the credential", () => {
  test("unresolved capabilities stay unknown and use the fallback until manually configured", async () => {
    f = await setup();
    const cred = await addEndpoint(f, [{ id: "unresolved" }]);
    const id = customModelId(cred.id, "unresolved");
    const stored = (await listCredentials(f.db, f.owner.id, f.org.id)).find((row) => row.id === cred.id)?.endpoint
      ?.models[0];
    expect(stored?.discovered).toBeUndefined();
    expect(stored?.overrides).toBeUndefined();
    const unknown = await modelInfoFor(f.db, id, f.org.id);
    expect(unknown?.contextWindow).toBeUndefined();
    expect(unknown?.reads).toBeUndefined();
    expect(contextWindowOf(id)).toBe(200_000);
    await updateEndpointModels(f.db, f.owner.id, f.org.id, cred.id, [
      { id: "unresolved", overrides: { contextWindow: 64_000, image: true, pdf: false } },
    ]);
    expect(await modelInfoFor(f.db, id, f.org.id)).toMatchObject({
      contextWindow: 64_000,
      reads: { image: true, pdf: false },
    });
    expect(contextWindowOf(id)).toBe(64_000);
  });
  test("resolves capabilities per field and keeps discovered data when manual overrides are cleared", async () => {
    f = await setup();
    const discoveredAt = "2026-11-25T00:00:00.000Z";
    const discovered: NonNullable<EndpointModel["discovered"]> = {
      contextWindow: { source: "catalog", value: 100_000, discoveredAt },
      maxOutputTokens: { source: "catalog", value: 8_000, discoveredAt },
      prices: {
        input: { source: "endpoint", value: 500, discoveredAt },
        output: { source: "endpoint", value: 900, discoveredAt },
      },
      image: { source: "probe", value: true, discoveredAt },
      pdf: { source: "endpoint", value: true, discoveredAt },
    };
    const prices = endpointPricesFromUsd({ input: 1, output: 2 });
    const cred = await addEndpoint(f, [
      {
        id: "model",
        prices,
        discovered,
        overrides: { maxOutputTokens: 4_000, image: false, prices: { output: 0 } },
      },
    ]);
    const model = customModelId(cred.id, "model");
    const info = () => modelInfoFor(f.db, model, f.org.id);
    expect(await info()).toMatchObject({
      contextWindow: 100_000,
      maxOutputTokens: 4_000,
      reads: { image: false, pdf: true },
      prices: { input: 1000, output: 0 },
    });
    await updateEndpointModels(f.db, f.owner.id, f.org.id, cred.id, [{ id: "model", prices, overrides: {} }]);
    expect(await info()).toMatchObject({
      contextWindow: 100_000,
      maxOutputTokens: 8_000,
      reads: { image: true, pdf: true },
      prices: { input: 1000, output: 2000 },
    });
  });
  test("persists per-model API discovery and respects manual override and legacy fallback", async () => {
    f = await setup();
    const discovered = {
      api: { source: "endpoint" as const, value: "responses" as const, discoveredAt: "2026-11-25T00:00:00.000Z" },
    };
    const cred = await addEndpoint(f, [{ id: "m", discovered, overrides: { api: "messages" } }, { id: "unknown" }]);
    const info = () => modelInfoFor(f.db, customModelId(cred.id, "m"), f.org.id);
    expect((await info())?.api).toBe("messages");
    expect((await modelInfoFor(f.db, customModelId(cred.id, "unknown"), f.org.id))?.api).toBe("chat");
    await updateEndpointModels(f.db, f.owner.id, f.org.id, cred.id, [{ id: "m", overrides: {} }]);
    expect((await info())?.api).toBe("responses");
    expect(
      (await listCredentials(f.db, f.owner.id, f.org.id)).find((row) => row.id === cred.id)?.endpoint?.models[0]
        ?.discovered,
    ).toEqual(discovered);
  });

  test("a fresh model listing clears stale API evidence while retaining manual overrides on update and resave", async () => {
    f = await setup();
    const old = {
      api: { source: "endpoint" as const, value: "responses" as const, discoveredAt: "2026-01-01T00:00:00.000Z" },
    };
    const cred = await addEndpoint(f, [{ id: "m", discovered: old, overrides: { api: "messages" } }]);
    const fetcher = (async () =>
      Response.json({
        data: [{ id: "m", native_endpoints: ["/v1/messages", "/v1/responses"] }],
      })) as unknown as typeof fetch;
    const listed = await listEndpoint(
      f.db,
      f.owner.id,
      f.org.id,
      { baseURL: "https://gw.example/v1" },
      { ...cloud, fetch: fetcher },
    );
    const fresh = listed.models.find((m) => m.id === "m");
    if (!fresh) throw new Error("missing model");
    await updateEndpointModels(f.db, f.owner.id, f.org.id, cred.id, [fresh]);
    let model = (await listCredentials(f.db, f.owner.id, f.org.id)).find((c) => c.id === cred.id)?.endpoint?.models[0];
    expect(model?.discovered?.api).toBeUndefined();
    expect(model?.overrides?.api).toBe("messages");
    const saved = await createCredential(
      f.db,
      f.keyWrapper,
      f.owner.id,
      f.org.id,
      {
        provider: "custom",
        label: "OpenGateway",
        apiKey: "gw-key-1234567",
        endpoint: { style: "openai", baseURL: "https://gw.example/v1", models: [fresh] },
      },
      { net: cloud },
    );
    model = saved.endpoint?.models[0];
    expect(saved.reused).toBe(true);
    expect(model?.discovered?.api).toBeUndefined();
    expect(model?.overrides?.api).toBe("messages");
  });

  test("automatic list fallback occurs only on 404 or 405", async () => {
    f = await setup();
    for (const status of [404, 405, 401, 200]) {
      const calls: { url: string; headers: Headers; signal: AbortSignal | null | undefined }[] = [];
      const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), headers: new Headers(init?.headers), signal: init?.signal });
        if (calls.length === 1) return new Response(status === 200 ? '{"data":[]}' : "", { status });
        return new Response(JSON.stringify({ data: [{ id: "m", native_endpoints: ["/v1/messages"] }] }));
      }) as typeof fetch;
      const result = await listEndpoint(
        f.db,
        f.owner.id,
        f.org.id,
        { baseURL: "https://gw.example/v1" },
        { ...cloud, fetch: fetcher },
      );
      if (status === 404 || status === 405) {
        expect(calls.slice(0, 2).map((call) => call.url)).toEqual([
          "https://gw.example/v1/models",
          "https://gw.example/v1/models",
        ]);
        expect(calls[0]?.headers.get("authorization")).toBe("Bearer none");
        expect(calls[1]?.headers.get("x-api-key")).toBe("none");
        expect(calls[0]?.signal).toBe(calls[1]?.signal);
        expect(result.listingStyle).toBe("anthropic");
        expect(result.models[0]?.discovered?.api).toMatchObject({ value: "messages", source: "endpoint" });
      } else expect(calls).toHaveLength(1);
    }
  });

  test("saved legacy address normalizes before using its separate listing authentication", async () => {
    f = await setup();
    const calls: { url: string; headers: Headers }[] = [];
    const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), headers: new Headers(init?.headers) });
      return Response.json({ data: [] });
    }) as typeof fetch;
    const result = await listEndpoint(
      f.db,
      f.owner.id,
      f.org.id,
      { style: "anthropic", listingStyle: "openai", baseURL: "https://gw.example", apiKey: "key" },
      { ...cloud, fetch: fetcher },
    );
    expect(calls[0]?.url).toBe("https://gw.example/v1/models");
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer key");
    expect(result.baseURL).toBe("https://gw.example/v1");
  });

  test("fallback to Messages returns the base used for its successful list", async () => {
    f = await setup();
    const urls: string[] = [];
    const fetcher = (async (url: string | URL | Request) => {
      urls.push(String(url));
      return urls.length === 1 ? new Response("", { status: 404 }) : Response.json({ data: [] });
    }) as typeof fetch;
    const result = await listEndpoint(
      f.db,
      f.owner.id,
      f.org.id,
      { baseURL: "https://gw.example" },
      { ...cloud, fetch: fetcher },
    );
    expect(urls).toEqual(["https://gw.example/models", "https://gw.example/v1/models"]);
    expect(result.baseURL).toBe("https://gw.example/v1");
    expect(result.listingStyle).toBe("anthropic");
  });

  test("admins only; the endpoint is required, its models checked, the key sealed and never shown", async () => {
    f = await setup();
    const member = await addMember(f.db, f.org.id, "member");
    const input = {
      provider: "custom" as const,
      label: "GW",
      apiKey: "gw-key-1234567",
      endpoint: { style: "openai" as const, baseURL: "https://gw.example/v1", models: [{ id: "m" }] },
    };
    await expect(createCredential(f.db, f.keyWrapper, member.id, f.org.id, input, { net: cloud })).rejects.toThrow();
    await expect(
      createCredential(f.db, f.keyWrapper, f.owner.id, f.org.id, { ...input, endpoint: undefined }, { net: cloud }),
    ).rejects.toThrow("endpoint");
    await expect(
      createCredential(
        f.db,
        f.keyWrapper,
        f.owner.id,
        f.org.id,
        { ...input, endpoint: { ...input.endpoint, models: [] } },
        { net: cloud },
      ),
    ).rejects.toThrow("at least one model");
    const saved = await addEndpoint(f);
    expect(saved.endpoint).toEqual({
      style: "openai",
      baseURL: "https://gw.example/v1",
      models: [{ id: "llama-4", prices: { input: 1000, output: 2000, cacheRead: 1000, cacheWrite: 1000 } }],
    });
    expect(JSON.stringify(await listCredentials(f.db, f.owner.id, f.org.id))).not.toContain("gw-key-1234567");
    const [row] = await f.db
      .select()
      .from(schema.providerCredentials)
      .where(eq(schema.providerCredentials.id, saved.id));
    expect(row?.secretCiphertext).not.toContain("gw-key");
  });

  test("a key-less server (a local Ollama) is saved with no key hint", async () => {
    f = await setup();
    const saved = await createCredential(
      f.db,
      f.keyWrapper,
      f.owner.id,
      f.org.id,
      {
        provider: "custom",
        label: "Ollama",
        apiKey: "",
        endpoint: { style: "openai", baseURL: "http://localhost:11434/v1", models: [{ id: "qwen3:8b" }] },
      },
      { net: selfHost },
    );
    expect(saved.keyHint).toBe("");
  });

  test("the list before saving: the models, or why there are none", async () => {
    f = await setup();
    const ok = (async () =>
      new Response(JSON.stringify({ data: [{ id: "a" }, { id: "b" }] }))) as unknown as typeof fetch;
    expect(
      await listEndpoint(
        f.db,
        f.owner.id,
        f.org.id,
        { style: "openai", baseURL: "https://gw.example/v1", apiKey: "k" },
        { ...cloud, fetch: ok },
      ),
    ).toEqual({
      baseURL: "https://gw.example/v1",
      listingStyle: "openai",
      models: [
        { id: "a", apiCheckedAt: expect.any(String) },
        { id: "b", apiCheckedAt: expect.any(String) },
      ],
    });
    const down = (async () => new Response("no", { status: 404 })) as unknown as typeof fetch;
    const r = await listEndpoint(
      f.db,
      f.owner.id,
      f.org.id,
      { style: "openai", baseURL: "https://gw.example/v1" },
      { ...cloud, fetch: down },
    );
    expect(r.models).toEqual([]);
    expect(r.error).toContain("404");
    await expect(
      listEndpoint(f.db, f.owner.id, f.org.id, { style: "openai", baseURL: "https://inside.example/v1" }, cloud),
    ).rejects.toThrow("internal network");
  });
});

describe("calls", () => {
  test("an endpoint key alone repairs an Automatic agent; explicit models are preserved", async () => {
    f = await setup();
    const cred = await addEndpoint(f, [{ id: "first" }, { id: "chosen" }]);
    await updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, { model: "auto" });
    const connected = await updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, { credentialId: cred.id });
    expect(connected.model).toBe(customModelId(cred.id, "first"));
    const explicit = customModelId(cred.id, "chosen");
    const selected = await updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, { model: explicit });
    expect(selected.model).toBe(explicit);
    const reconnected = await updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, { credentialId: cred.id });
    expect(reconnected.model).toBe(explicit);
    const automatic = await updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, { model: "auto" });
    expect(automatic.model).toBe(customModelId(cred.id, "first"));
  });

  test("an endpoint key on Automatic pins the model whose test called a tool, not the first one listed", async () => {
    f = await setup({
      reply: (request) =>
        request.model.endsWith(":tools")
          ? { chunks: [], toolUses: [{ name: "report_status", input: { ok: true } }] }
          : { chunks: ["I can't call tools."] },
    });
    const cred = await addEndpoint(f, [{ id: "chat" }, { id: "tools" }]);
    await checkEndpoint(f.db, f.gateway, f.owner.id, f.org.id, cred.id);
    const agent = await updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, { model: "auto", credentialId: cred.id });
    expect(agent.model).toBe(customModelId(cred.id, "tools"));
  });

  test("new agents with an endpoint key use its model, while catalog keys keep Automatic", async () => {
    f = await setup();
    const cred = await addEndpoint(f);
    const agent = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Endpoint", handle: "endpoint-agent", credentialId: cred.id },
      { model: "auto" },
    );
    expect(agent.model).toBe(customModelId(cred.id, "llama-4"));
    const catalog = await updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, { model: "auto" });
    expect(catalog.model).toBe("auto");
  });

  test("connecting an endpoint on Automatic selects its own model and can answer", async () => {
    f = await setup();
    const cred = await addEndpoint(f);
    const agent = await updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, {
      model: "auto",
      credentialId: cred.id,
    });
    expect(agent.model).toBe(customModelId(cred.id, "llama-4"));
    expect(await agentAiState({ db: f.db, gateway: f.gateway }, agent)).toMatchObject({ state: "ready" });
    await f.gateway.stream({
      orgId: f.org.id,
      agentId: agent.id,
      system: "s",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 100,
      onDelta() {},
    });
    expect(f.provider.calls.at(-1)?.request.model).toBe(agent.model);
    expect(f.provider.calls.at(-1)?.endpoint).toEqual({
      style: "openai",
      baseURL: "https://gw.example/v1",
      api: "chat",
      reads: undefined,
    });
  });

  test("an agent on an endpoint model: its key and address, the admin's prices, tokens and cost recorded", async () => {
    f = await setup({ reply: () => ({ chunks: ["ok"], usage: { inputTokens: 1000, outputTokens: 100 } }) });
    const cred = await addEndpoint(f);
    const model = customModelId(cred.id, "llama-4");
    await updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, { model, credentialId: cred.id });
    const result = await f.gateway.stream({
      orgId: f.org.id,
      agentId: f.agent.id,
      system: "s",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 100,
      onDelta() {},
    });
    const sent = f.provider.calls.at(-1);
    expect(sent?.apiKey).toBe("gw-key-1234567");
    expect(sent?.endpoint).toEqual({
      style: "openai",
      baseURL: "https://gw.example/v1",
      api: "chat",
      reads: undefined,
    });
    expect(result.costNanoUsd).toBe(1000 * 1000 + 100 * 2000);
    const [record] = await f.db.select().from(schema.usageRecords).where(eq(schema.usageRecords.agentId, f.agent.id));
    expect(record).toMatchObject({ provider: "custom", model, credentialId: cred.id, orgId: f.org.id });
  });

  test("an unpriced model: cost 0 with its tokens, so a budget never stops it; a priced one is stopped", async () => {
    f = await setup({
      budgetNanoUsd: 1,
      reply: () => ({ chunks: ["ok"], usage: { inputTokens: 500, outputTokens: 50 } }),
    });
    const cred = await addEndpoint(f, [
      { id: "free-model" },
      { id: "paid", prices: endpointPricesFromUsd({ input: 5, output: 5 }) },
    ]);
    const run = (model: string) =>
      updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, { model, credentialId: cred.id }).then(() =>
        f.gateway.stream({
          orgId: f.org.id,
          agentId: f.agent.id,
          system: "s",
          messages: [{ role: "user", content: "hi" }],
          maxTokens: 100,
          onDelta() {},
        }),
      );
    const free = await run(customModelId(cred.id, "free-model"));
    expect(free.costNanoUsd).toBe(0);
    const [record] = await f.db.select().from(schema.usageRecords);
    expect(record).toMatchObject({ inputTokens: 500, outputTokens: 50, costNanoUsd: 0 });
    await expect(run(customModelId(cred.id, "paid"))).rejects.toBeInstanceOf(BudgetExceededError);
  });

  test("a model named as the endpoint lists it gets its full id; one it doesn't list says which it has", async () => {
    f = await setup();
    const cred = await addEndpoint(f, [{ id: "vendor/model-a" }, { id: "model-b" }]);
    const both = await updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, {
      model: "vendor/model-a",
      credentialId: cred.id,
    });
    expect(both.model).toBe(customModelId(cred.id, "vendor/model-a"));
    // The model alone, on the agent's endpoint key.
    const alone = await updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, { model: "model-b" });
    expect(alone.model).toBe(customModelId(cred.id, "model-b"));
    expect(alone.credentialId).toBe(cred.id);
    await expect(
      updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, { model: "not-listed", credentialId: cred.id }),
    ).rejects.toThrow("Its models: vendor/model-a, model-b");
  });

  test("a known model picked alone leaves the endpoint key, even when the endpoint lists the same id", async () => {
    f = await setup();
    const openai = Object.entries(MODEL_CATALOG).find(([, m]) => m.provider === "openai")?.[0];
    if (!openai) throw new Error("no OpenAI model in the catalog");
    const cred = await addEndpoint(f, [{ id: openai }]);
    const onEndpoint = await updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, {
      model: openai,
      credentialId: cred.id,
    });
    expect(onEndpoint.model).toBe(customModelId(cred.id, openai));
    const moved = await updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, { model: openai });
    expect([moved.model, moved.credentialId]).toEqual([openai, null]);
  });

  test("another workspace's endpoint model is unknown here", async () => {
    f = await setup();
    const cred = await addEndpoint(f);
    const model = customModelId(cred.id, "llama-4");
    expect((await modelInfoFor(f.db, model, f.org.id))?.endpoint).toBe("OpenGateway");
    expect(await modelInfoFor(f.db, model, crypto.randomUUID())).toBeUndefined();
    expect(await modelInfoFor(f.db, model)).toBeUndefined();
    expect((await pickerModels(f.db, [f.org.id])).some(([id]) => id === model)).toBe(true);
    expect((await pickerModels(f.db)).some(([id]) => id === model)).toBe(false);
    // Its model only runs on its own endpoint.
    await expect(
      updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, { model, credentialId: f.credential.id }),
    ).rejects.toThrow("its own endpoint");
  });
});

describe("the test call", () => {
  test("one per model with a tool: ok, no tools, or failed in the server's words; each kept and recorded", async () => {
    f = await setup({
      reply: (request) =>
        request.model.endsWith(":tools")
          ? { chunks: [], toolUses: [{ name: "report_status", input: { ok: true } }] }
          : request.model.endsWith(":broken")
            ? new ProviderError("provider rejected the request (404): model broken not found", false, 404)
            : { chunks: ["I can't call tools."] },
    });
    const cred = await addEndpoint(f, [{ id: "tools" }, { id: "chat" }, { id: "broken" }]);
    // A key of an endpoint has no cheap catalog model to test it with: its own models' checks are the answer, so it is
    // `unchecked` only while none of them has been tested (a connect flow toasts that, never a tested key).
    expect(await f.gateway.verifyStoredKey(f.org.id, cred.id)).toMatchObject({
      provider: "custom",
      result: { state: "unchecked" },
    });
    const checks = await checkEndpoint(f.db, f.gateway, f.owner.id, f.org.id, cred.id);
    expect(checks).toEqual([
      { model: "tools", check: "ok" },
      { model: "chat", check: "no_tools" },
      { model: "broken", check: "failed", error: "provider rejected the request (404): model broken not found" },
    ]);
    expect(f.provider.calls.find((c) => c.request.model.endsWith(":tools"))?.request.tools?.[0]?.name).toBe(
      "report_status",
    );
    const [saved] = (await listCredentials(f.db, f.owner.id, f.org.id)).filter((c) => c.id === cred.id);
    expect(saved?.endpoint?.models.map((m) => m.check)).toEqual(["ok", "no_tools", "failed"]);
    // Tested: the key answers, so nothing says it couldn't be checked.
    expect(await f.gateway.verifyStoredKey(f.org.id, cred.id)).toMatchObject({ result: { state: "ok" } });
    // The connect flows try a key this way before an agent is pointed at it.
    expect(await checkCredential(f.db, f.gateway, f.owner.id, f.org.id, cred.id)).toBe("ok");
    const rows = await f.db.select().from(schema.usageRecords).where(eq(schema.usageRecords.credentialId, cred.id));
    expect(rows.map((r) => r.kind)).toEqual(["summary", "summary"]);
    // Prices change, the checks stay with their models.
    const next = await updateEndpointModels(f.db, f.owner.id, f.org.id, cred.id, [
      { id: "tools", prices: endpointPricesFromUsd({ input: 1, output: 1 }) },
    ]);
    expect(next.models).toEqual([
      { id: "tools", prices: { input: 1000, output: 1000, cacheRead: 1000, cacheWrite: 1000 }, check: "ok" },
    ]);
    const member = await addMember(f.db, f.org.id, "member");
    await expect(checkEndpoint(f.db, f.gateway, member.id, f.org.id, cred.id)).rejects.toThrow();
  });

  test("a new key for an endpoint clears its models' tests: the old key's answers don't vouch for it", async () => {
    f = await setup({ reply: () => ({ chunks: [], toolUses: [{ name: "report_status", input: { ok: true } }] }) });
    const cred = await addEndpoint(f, [{ id: "tools" }]);
    await checkEndpoint(f.db, f.gateway, f.owner.id, f.org.id, cred.id);
    expect(await checkCredential(f.db, f.gateway, f.owner.id, f.org.id, cred.id)).toBe("ok");
    await rotateCredential(f.db, f.keyWrapper, f.owner.id, f.org.id, cred.id, { apiKey: "gw-key-7654321" });
    const [saved] = (await listCredentials(f.db, f.owner.id, f.org.id)).filter((c) => c.id === cred.id);
    expect(saved?.endpoint).toMatchObject({ baseURL: "https://gw.example/v1", models: [{ id: "tools" }] });
    expect(saved?.endpoint?.models[0]?.check).toBeUndefined();
    expect(await checkCredential(f.db, f.gateway, f.owner.id, f.org.id, cred.id)).toBe("unchecked");
  });
});

test("complete endpoint modalities take precedence over catalog attachments", async () => {
  f = await setup();
  const read = (async (url: string | URL | Request) =>
    String(url).includes("models.dev")
      ? Response.json({
          gw: { api: "https://gw.example/v1", models: { model: { modalities: { input: ["text", "image", "pdf"] } } } },
        })
      : Response.json({ data: [{ id: "model", input_modalities: ["text", "file"] }] })) as unknown as typeof fetch;
  const result = await listEndpoint(
    f.db,
    f.owner.id,
    f.org.id,
    { style: "openai", baseURL: "https://gw.example/v1" },
    { ...cloud, fetch: read },
  );
  expect(result.models[0]?.discovered?.image).toMatchObject({ source: "endpoint", value: false });
  expect(result.models[0]?.discovered?.pdf).toMatchObject({ source: "endpoint", value: false });
});

test("catalog backfill fills partial models while retaining endpoint values", async () => {
  f = await setup();
  const discoveredAt = "2026-01-01T00:00:00.000Z";
  const cred = await addEndpoint(f, [
    { id: "partial", discovered: { contextWindow: { value: 100, source: "endpoint", discoveredAt } } },
  ]);
  const read = (async () =>
    Response.json({
      gw: {
        api: "https://gw.example/v1",
        models: { partial: { limit: { context: 200, output: 30 }, cost: { input: 0, output: 1 } } },
      },
    })) as unknown as typeof fetch;
  await backfillEndpointCatalog(f.db, f.org.id, read);
  const [row] = await f.db.select().from(schema.providerCredentials).where(eq(schema.providerCredentials.id, cred.id));
  const discovery = row?.options.endpoint?.models[0]?.discovered;
  expect(discovery?.contextWindow).toEqual({ value: 100, source: "endpoint", discoveredAt });
  expect(discovery?.maxOutputTokens).toMatchObject({ value: 30, source: "catalog" });
  expect(discovery?.prices?.input).toMatchObject({ value: 0, source: "catalog" });
});

test("backfill removes stale catalog fields even when discovery is otherwise complete", async () => {
  f = await setup();
  const date = "2026-01-01T00:00:00.000Z";
  const catalog = <T>(value: T) => ({ value, source: "catalog" as const, discoveredAt: date });
  const endpoint = <T>(value: T) => ({ value, source: "endpoint" as const, discoveredAt: date });
  const probe = <T>(value: T) => ({ value, source: "probe" as const, discoveredAt: date });
  const cred = await addEndpoint(f, [
    {
      id: "gpt-4o",
      overrides: { image: true },
      discovered: {
        contextWindow: catalog(128_000),
        maxOutputTokens: endpoint(4096),
        image: catalog(true),
        pdf: probe(false),
        prices: { input: catalog(0), output: endpoint(1) },
      },
    },
  ]);
  const read = (async () =>
    Response.json({ openai: { models: { "gpt-4o": { limit: { context: 128_000 } } } } })) as unknown as typeof fetch;
  await backfillEndpointCatalog(f.db, f.org.id, read);
  const [row] = await f.db.select().from(schema.providerCredentials).where(eq(schema.providerCredentials.id, cred.id));
  expect(row?.options.endpoint?.models[0]).toMatchObject({
    id: "gpt-4o",
    overrides: { image: true },
    discovered: {
      maxOutputTokens: endpoint(4096),
      pdf: probe(false),
      prices: { output: endpoint(1) },
    },
  });
  const discovery = row?.options.endpoint?.models[0]?.discovered;
  expect(discovery?.contextWindow).toBeUndefined();
  expect(discovery?.image).toBeUndefined();
  expect(discovery?.prices?.input).toBeUndefined();
});

test("backfill skips complete discovery and repeated backfill leaves values unchanged", async () => {
  f = await setup();
  const discoveredAt = "2026-01-01T00:00:00.000Z";
  const field = (value: number) => ({ value, source: "endpoint" as const, discoveredAt });
  const cred = await addEndpoint(f, [
    {
      id: "complete",
      discovered: {
        contextWindow: field(100),
        maxOutputTokens: field(20),
        prices: { output: field(2), input: field(0) },
      },
    },
  ]);
  let calls = 0;
  const read = (async () => {
    calls++;
    return Response.json({});
  }) as unknown as typeof fetch;
  await backfillEndpointCatalog(f.db, f.org.id, read);
  await backfillEndpointCatalog(f.db, f.org.id, read);
  expect(calls).toBe(0);
  const [row] = await f.db.select().from(schema.providerCredentials).where(eq(schema.providerCredentials.id, cred.id));
  expect(row?.options.endpoint?.models[0]?.discovered?.prices?.input?.value).toBe(0);
});

test("resaving merges discovery added after duplicate lookup", async () => {
  f = await setup();
  const cred = await addEndpoint(f, [{ id: "model" }]);
  let injected = false;
  const proxied = new Proxy(f.db, {
    get(target, property, receiver) {
      if (property === "transaction")
        return async (...args: unknown[]) => {
          if (!injected) {
            injected = true;
            const [row] = await f.db
              .select()
              .from(schema.providerCredentials)
              .where(eq(schema.providerCredentials.id, cred.id));
            if (!row?.options.endpoint) throw new Error("missing endpoint");
            const models = row.options.endpoint.models.map((model) => ({
              ...model,
              discovered: {
                image: { value: true, source: "probe" as const, discoveredAt: "2026-01-01T00:00:00.000Z" },
              },
            }));
            await f.db
              .update(schema.providerCredentials)
              .set({ options: { ...row.options, endpoint: { ...row.options.endpoint, models } } })
              .where(eq(schema.providerCredentials.id, cred.id));
          }
          return Reflect.apply(target.transaction, target, args);
        };
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const saved = await createCredential(
    proxied,
    f.keyWrapper,
    f.owner.id,
    f.org.id,
    {
      provider: "custom",
      label: "OpenGateway",
      apiKey: "gw-key-1234567",
      endpoint: { style: "openai", baseURL: "https://gw.example/v1", models: [{ id: "model" }] },
    },
    { net: cloud },
  );
  expect(saved.reused).toBe(true);
  expect(saved.endpoint?.models[0]?.discovered?.image?.value).toBe(true);
});

test("resaving a legacy Messages endpoint retains model evidence and its protocol", async () => {
  f = await setup();
  const discoveredAt = "2026-01-01T00:00:00.000Z";
  const input = {
    provider: "custom" as const,
    label: "gateway",
    apiKey: "key",
    endpoint: {
      style: "anthropic" as const,
      baseURL: "https://gw.example/v1",
      models: [
        {
          id: "m",
          overrides: { image: false },
          discovered: { pdf: { source: "probe" as const, value: true, discoveredAt } },
        },
      ],
    },
  };
  const saved = await createCredential(f.db, f.keyWrapper, f.owner.id, f.org.id, input, { net: cloud });
  const [row] = await f.db.select().from(schema.providerCredentials).where(eq(schema.providerCredentials.id, saved.id));
  if (!row?.options.endpoint) throw new Error("missing endpoint");
  await f.db
    .update(schema.providerCredentials)
    .set({
      options: {
        ...row.options,
        endpoint: {
          ...row.options.endpoint,
          baseURL: "https://gw.example",
          models: row.options.endpoint.models.map((model) => ({ ...model, check: "ok" as const })),
        },
      },
    })
    .where(eq(schema.providerCredentials.id, saved.id));
  const again = await createCredential(
    f.db,
    f.keyWrapper,
    f.owner.id,
    f.org.id,
    {
      ...input,
      endpoint: { style: "openai", listingStyle: "openai", baseURL: input.endpoint.baseURL, models: [{ id: "m" }] },
    },
    { net: cloud },
  );
  expect(again.reused).toBe(true);
  expect(again.id).toBe(saved.id);
  expect(again.endpoint?.style).toBe("anthropic");
  expect(again.endpoint?.listingStyle).toBe("openai");
  expect(again.endpoint?.models[0]?.overrides?.image).toBe(false);
  expect(again.endpoint?.models[0]?.discovered?.pdf?.value).toBe(true);
  expect(again.endpoint?.models[0]?.check).toBe("ok");
  expect((await modelInfoFor(f.db, customModelId(saved.id, "m"), f.org.id))?.api).toBe("messages");
});

test("changing a model API clears its check and probe evidence", async () => {
  f = await setup();
  const discoveredAt = "2026-01-01T00:00:00.000Z";
  const before = [
    {
      id: "m",
      check: "ok" as const,
      discovered: {
        image: { source: "probe" as const, value: true, discoveredAt },
        pdf: { source: "endpoint" as const, value: true, discoveredAt },
      },
    },
  ];
  const [model] = cleanEndpointModels([{ id: "m", overrides: { api: "responses" } }], before);
  expect(model?.check).toBeUndefined();
  expect(model?.discovered?.image).toBeUndefined();
  expect(model?.discovered?.pdf).toEqual(before[0]?.discovered.pdf);
});

test("omitted client discovery preserves all stored fields", async () => {
  f = await setup();
  const discoveredAt = "2026-01-01T00:00:00.000Z";
  const discovered = {
    image: { source: "probe" as const, value: false, discoveredAt },
    contextWindow: { source: "endpoint" as const, value: 100, discoveredAt },
  };
  expect(cleanEndpointModels([{ id: "m" }], [{ id: "m", discovered }])[0]?.discovered).toEqual(discovered);
});

test("backfill normalizes legacy grouped data while filling gaps", async () => {
  f = await setup();
  const cred = await addEndpoint(f, [{ id: "partial" }]);
  const [row] = await f.db.select().from(schema.providerCredentials).where(eq(schema.providerCredentials.id, cred.id));
  if (!row?.options.endpoint) throw new Error("missing endpoint");
  const legacy = {
    discoveredAt: "2026-01-01T00:00:00.000Z",
    limits: { source: "endpoint", value: { contextWindow: 100 } },
  };
  const models = [{ id: "partial", discovered: legacy }] as unknown as EndpointModel[];
  await f.db
    .update(schema.providerCredentials)
    .set({ options: { ...row.options, endpoint: { ...row.options.endpoint, models } } })
    .where(eq(schema.providerCredentials.id, cred.id));
  const read = (async () =>
    Response.json({
      gw: { api: "https://gw.example/v1", models: { partial: { limit: { output: 20 } } } },
    })) as unknown as typeof fetch;
  await backfillEndpointCatalog(f.db, f.org.id, read);
  const [updated] = await f.db
    .select()
    .from(schema.providerCredentials)
    .where(eq(schema.providerCredentials.id, cred.id));
  const discovered = updated?.options.endpoint?.models[0]?.discovered;
  expect(discovered?.contextWindow).toEqual({ source: "endpoint", value: 100, discoveredAt: legacy.discoveredAt });
  expect(discovered?.maxOutputTokens?.value).toBe(20);
});

test("saving models preserves unknown stored fields and accepts new ones", async () => {
  f = await setup();
  const previous = [{ id: "m", futureSetting: { enabled: true } }] as unknown as EndpointModel[];
  expect(cleanEndpointModels([{ id: "m" }], previous)[0] as unknown).toEqual({
    id: "m",
    futureSetting: { enabled: true },
  });
  const incoming = [{ id: "m", anotherSetting: 7 }] as unknown as EndpointModel[];
  expect(cleanEndpointModels(incoming, previous)[0] as unknown).toEqual({
    id: "m",
    futureSetting: { enabled: true },
    anotherSetting: 7,
  });
});
