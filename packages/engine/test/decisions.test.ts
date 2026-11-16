import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import {
  createCredential,
  createJevRouterStrategy,
  createWorkspaceDecisions,
  decisionSettings,
  defaultCredentials,
  type RoutingInput,
  sealSecret,
} from "../src";
import { type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(() => f?.close());

const decisionsFor = (fetch?: typeof globalThis.fetch, net?: Parameters<typeof createWorkspaceDecisions>[0]["net"]) =>
  createWorkspaceDecisions({
    db: f.db,
    keyWrappers: [f.keyWrapper],
    gateway: f.gateway,
    fetch,
    net,
    timeoutMs: 2000,
  });

async function customKey(
  options: { baseURL?: string; style?: "openai" | "anthropic"; makeDefault?: boolean; models?: { id: string }[] } = {},
) {
  return createCredential(
    f.db,
    f.keyWrapper,
    f.owner.id,
    f.org.id,
    {
      provider: "custom",
      label: "Gateway",
      apiKey: "decision-endpoint-key",
      makeDefault: options.makeDefault,
      endpoint: {
        style: options.style ?? "openai",
        baseURL: options.baseURL ?? "https://gateway.example/v1",
        models: options.models ?? [{ id: "chat-model" }],
      },
    },
    { net: { allowPrivate: true } },
  );
}

async function openRouterKey(key = "sk-or-v1-decision_test_1234") {
  return createCredential(
    f.db,
    f.keyWrapper,
    f.owner.id,
    f.org.id,
    { provider: "openrouter", label: "OpenRouter", apiKey: key },
    { fetch: (async () => Response.json({ data: { is_management_key: false } })) as unknown as typeof fetch },
  );
}

function fakeDecision(
  options: {
    status?: number;
    bad?: boolean;
    textUsage?: { input_tokens?: number; output_tokens?: number; cost?: number };
    visionUsage?: { input_tokens?: number; output_tokens?: number; cost?: number };
  } = {},
) {
  const calls: { url: string; body: { model?: string; assets?: unknown }; auth: string | null }[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/v1/key")) return Response.json({ data: { is_management_key: false } });
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      model?: string;
      assets?: unknown;
      questions?: Record<string, unknown>;
    };
    calls.push({ url, body, auth: new Headers(init?.headers).get("authorization") });
    if (options.status) return Response.json({ detail: {} }, { status: options.status });
    if (options.bad)
      return Response.json({ model: body.model, answers: { ok: { noul: "high" }, pick: { choice: "other" } } });
    if (body.assets)
      return Response.json({
        model: body.model,
        answers: { target: { box: { top: 0, bottom: 1, left: 0, right: 1 } } },
        usage: options.visionUsage ?? { input_tokens: 1.5, output_tokens: 0.5, cost: 0.000001 },
      });
    return Response.json({
      model: body.model,
      answers: { ok: { noul: 1 }, pick: { choice: "ok" }, level: { score: 1 } },
      usage: options.textUsage ?? { input_tokens: 10.4, output_tokens: 2.6, cost: 0 },
    });
  }) as unknown as typeof globalThis.fetch;
  return { fetch: fetcher, calls };
}

const ask = (orgId: string) => ({
  orgId,
  kind: "test",
  state: { text: "ok" },
  questions: { ok: { type: "noul" as const, instructions: "ok?", criteria: { true: "yes", false: "no" } } },
});

describe("workspace decision models", () => {
  test("null keeps the installation's Jev: the fallback answers and no credential is resolved", async () => {
    f = await setup();
    const decisions = decisionsFor();
    expect(await decisions.target(f.org.id)).toBeNull();
    let global = 0;
    let llm = 0;
    const combined = decisions.judge(
      {
        name: "global",
        async ask() {
          global++;
          return {};
        },
      },
      {
        name: "llm",
        async ask() {
          llm++;
          return {};
        },
      },
    );
    expect(await combined.ask(ask(f.org.id))).toEqual({});
    expect([global, llm]).toEqual([1, 0]);
    expect(await combined.nameFor?.(f.org.id)).toBe("global");
  });

  test("an OpenRouter model probes Noul, Choice, Score and Box before saving, then bills the org", async () => {
    f = await setup();
    const credential = await openRouterKey();
    const fake = fakeDecision();
    const decisions = decisionsFor(fake.fetch);
    const saved = await decisions.save(f.org.id, f.owner.id, {
      credentialId: credential.id,
      model: "jaredpalmer/kev-4b",
      visionModel: "typesafe/jev-latest",
    });
    expect(saved).toEqual({
      settings: {
        credentialId: credential.id,
        model: "jaredpalmer/kev-4b",
        visionModel: "typesafe/jev-latest",
      },
      available: true,
    });
    expect(fake.calls.map((c) => c.url)).toEqual([
      "https://openrouter.ai/api/alpha/decisions",
      "https://openrouter.ai/api/alpha/decisions",
    ]);
    expect(fake.calls[0]?.body.model).toBe("jaredpalmer/kev-4b");
    expect(fake.calls[1]?.body.model).toBe("typesafe/jev-latest");
    expect(fake.calls[1]?.body.assets).toBeDefined();

    const usage = await f.db.select().from(schema.usageRecords).where(eq(schema.usageRecords.orgId, f.org.id));
    expect(usage.find((u) => u.model === "jaredpalmer/kev-4b")).toMatchObject({
      provider: "openrouter-decisions",
      credentialId: credential.id,
      billedTo: "org",
      inputTokens: 10,
      outputTokens: 3,
      costNanoUsd: 0,
    });
    expect(usage.find((u) => u.model === "typesafe/jev-latest")).toMatchObject({
      provider: "openrouter-decisions",
      credentialId: credential.id,
      billedTo: "org",
      inputTokens: 2,
      outputTokens: 1,
      costNanoUsd: 1000,
    });
  });

  test("a failed probe keeps the previous setup and never stores the failed setting", async () => {
    f = await setup();
    const credential = await openRouterKey();
    const decisions = decisionsFor(fakeDecision().fetch);
    const first = await decisions.save(f.org.id, f.owner.id, {
      credentialId: credential.id,
      model: "jaredpalmer/kev-4b",
      visionModel: null,
    });
    const failing = decisionsFor(fakeDecision({ bad: true }).fetch);
    await expect(
      failing.save(f.org.id, f.owner.id, {
        credentialId: credential.id,
        model: "jaredpalmer/other-kev",
        visionModel: null,
      }),
    ).rejects.toMatchObject({ code: "decision_check_format" });
    expect(await decisionSettings(f.db, f.org.id)).toEqual(first.settings);
  });

  test("vision capability follows the organization's own choice", async () => {
    f = await setup();
    const [other] = await f.db.insert(schema.organizations).values({ name: "Other" }).returning();
    const credential = await openRouterKey();
    const decisions = decisionsFor(fakeDecision().fetch);
    expect(await decisions.vision(f.org.id)).toBeNull();
    expect(await decisions.vision(other?.id ?? "")).toBeNull();
    await decisions.save(f.org.id, f.owner.id, {
      credentialId: credential.id,
      model: "jaredpalmer/kev-4b",
      visionModel: null,
    });
    expect(await decisions.vision(f.org.id)).toBe(false);
    expect(await decisions.vision(other?.id ?? "")).toBeNull();
    await decisions.save(f.org.id, f.owner.id, {
      credentialId: credential.id,
      model: "jaredpalmer/kev-4b",
      visionModel: "typesafe/jev-latest",
    });
    expect(await decisions.vision(f.org.id)).toBe(true);
  });

  test("a broken workspace override uses the local LLM fallback, never the installation's Jev", async () => {
    f = await setup();
    const credential = await openRouterKey();
    const decisions = decisionsFor(fakeDecision().fetch);
    await decisions.save(f.org.id, f.owner.id, {
      credentialId: credential.id,
      model: "jaredpalmer/kev-4b",
      visionModel: null,
    });
    await f.db
      .update(schema.providerCredentials)
      .set({ revokedAt: new Date() })
      .where(eq(schema.providerCredentials.id, credential.id));
    let global = 0;
    let llm = 0;
    const combined = decisions.judge(
      {
        name: "global",
        async ask() {
          global++;
          return {};
        },
      },
      {
        name: "llm",
        async ask() {
          llm++;
          return {};
        },
      },
    );
    expect(await combined.ask(ask(f.org.id))).toEqual({});
    expect([global, llm]).toEqual([0, 1]);
    expect(await combined.nameFor?.(f.org.id)).toBe("llm");
  });

  test("a failed workspace route does not read the installation's key and never calls the global Jev", async () => {
    f = await setup();
    let global = 0;
    let override = 0;
    const strategy = createJevRouterStrategy({
      key: "global-typesafe-key",
      fetch: (async () => {
        global++;
        return Response.json({ answers: { needs_agent: { noul: 1 } } });
      }) as unknown as typeof fetch,
      resolve: async () => ({
        key: "sk-or-v1-override",
        transport: "openrouter",
        model: "jaredpalmer/kev-4b",
        credentialId: crypto.randomUUID(),
        fetch: (async () => {
          override++;
          return Response.json({ detail: {} }, { status: 500 });
        }) as unknown as typeof fetch,
      }),
      recordUsage: async () => {},
    });
    const input: RoutingInput = {
      orgId: f.org.id,
      channel: { id: f.general.id, name: "general", topic: "" },
      message: { id: crypto.randomUUID(), author: "Ana", body: "hello", names: [] },
      thread: [],
      candidates: [{ agentId: f.agent.id, handle: "ada", name: "Ada", role: "PM", about: "" }],
      authorUserId: f.owner.id,
    };
    await expect(strategy.decide(input)).rejects.toThrow("OpenRouter answered 500");
    expect([global, override]).toEqual([0, 1]);
  });

  test("an existing custom chat key serves decisions, stays chat, and can be the default", async () => {
    f = await setup();
    const endpoint = await customKey({ makeDefault: true });
    const fake = fakeDecision();
    const saved = await decisionsFor(fake.fetch).save(f.org.id, f.owner.id, {
      credentialId: endpoint.id,
      model: "jev-compatible",
      visionModel: null,
    });
    expect(saved).toEqual({
      settings: { credentialId: endpoint.id, model: "jev-compatible", visionModel: null },
      available: true,
    });
    expect(fake.calls[0]?.url).toBe("https://gateway.example/v1/systemone");
    expect(fake.calls[0]?.body.model).toBe("jev-compatible");
    const [usage] = await f.db.select().from(schema.usageRecords).where(eq(schema.usageRecords.orgId, f.org.id));
    expect(usage).toMatchObject({ provider: "systemone", credentialId: endpoint.id, billedTo: "org" });
    expect((await defaultCredentials(f.db, f.org.id)).perProvider.custom).toBe(endpoint.id);
  });

  test("the decision route is derived for OpenAI and Anthropic bases, and /systemone stays idempotent", async () => {
    f = await setup();
    const cases = [
      { baseURL: "https://gateway.example/v1", style: "openai" as const, url: "https://gateway.example/v1/systemone" },
      {
        baseURL: "https://gateway.example/anthropic",
        style: "anthropic" as const,
        url: "https://gateway.example/anthropic/v1/systemone",
      },
      {
        baseURL: "https://gateway.example/v1/systemone",
        style: "openai" as const,
        url: "https://gateway.example/v1/systemone",
      },
    ];
    for (const [i, c] of cases.entries()) {
      const endpoint = await customKey({
        baseURL: c.baseURL,
        style: c.style,
        models: [{ id: `chat-${i}` }],
      });
      const fake = fakeDecision();
      await decisionsFor(fake.fetch).save(f.org.id, f.owner.id, {
        credentialId: endpoint.id,
        model: "jev-compatible",
        visionModel: null,
      });
      expect(fake.calls[0]?.url).toBe(c.url);
    }
  });

  test("a full decision URL override is used exactly", async () => {
    f = await setup();
    const endpoint = await customKey();
    const fake = fakeDecision();
    const url = "https://decisions.example.com/api/decisions/?tenant=acme";
    const saved = await decisionsFor(fake.fetch, { allowPrivate: true }).save(f.org.id, f.owner.id, {
      credentialId: endpoint.id,
      model: "jev-compatible",
      visionModel: null,
      endpoint: url,
    });
    expect(saved.settings).toMatchObject({ endpoint: url });
    expect(fake.calls[0]?.url).toBe(url);
  });

  test("OpenRouter refuses an endpoint override before any call", async () => {
    f = await setup();
    const credential = await openRouterKey();
    const fake = fakeDecision();
    await expect(
      decisionsFor(fake.fetch).save(f.org.id, f.owner.id, {
        credentialId: credential.id,
        model: "vendor/model",
        visionModel: null,
        endpoint: "https://decisions.example.com/v1/systemone",
      }),
    ).rejects.toMatchObject({ code: "decision_endpoint_unsupported" });
    expect(fake.calls).toEqual([]);
    expect(await decisionSettings(f.db, f.org.id)).toBeNull();
  });

  test("an internal override is refused before the key is sent", async () => {
    f = await setup();
    const endpoint = await customKey();
    const net = { allowPrivate: false, resolveHost: async () => ["93.184.216.34"] };
    for (const url of [
      "http://169.254.169.254/latest/meta-data",
      "https://127.0.0.1/v1/systemone",
      "https://localhost/v1/systemone",
    ]) {
      const fake = fakeDecision();
      await expect(
        decisionsFor(fake.fetch, net).save(f.org.id, f.owner.id, {
          credentialId: endpoint.id,
          model: "jev-compatible",
          visionModel: null,
          endpoint: url,
        }),
      ).rejects.toMatchObject({ code: expect.stringMatching(/^url\./) });
      expect(fake.calls).toEqual([]);
    }
    expect(await decisionSettings(f.db, f.org.id)).toBeNull();
  });

  test("a provider without a decision route is refused", async () => {
    f = await setup();
    const fake = fakeDecision();
    await expect(
      decisionsFor(fake.fetch).save(f.org.id, f.owner.id, {
        credentialId: f.credential.id,
        model: "some-model",
        visionModel: null,
      }),
    ).rejects.toMatchObject({ code: "decision_account_invalid" });
    expect(fake.calls).toEqual([]);
  });

  test("a key rotated while the probe runs is not saved as if the new destination had been tested", async () => {
    f = await setup();
    const credential = await openRouterKey();
    const fake = fakeDecision();
    let first = true;
    const rotated = await sealSecret(
      f.keyWrapper,
      "openrouter-key-rotated",
      `provider-credential|${f.org.id}|${credential.id}`,
    );
    const racing = (async (input: string | URL | Request, init?: RequestInit) => {
      if (first) {
        first = false;
        await f.db
          .update(schema.providerCredentials)
          .set({
            secretCiphertext: rotated.ciphertext,
            wrappedDataKey: rotated.wrappedDataKey,
            kekId: rotated.kekId,
            keyHint: "ated",
          })
          .where(eq(schema.providerCredentials.id, credential.id));
      }
      return fake.fetch(input, init);
    }) as typeof globalThis.fetch;
    await expect(
      decisionsFor(racing).save(f.org.id, f.owner.id, {
        credentialId: credential.id,
        model: "jaredpalmer/kev-4b",
        visionModel: null,
      }),
    ).rejects.toMatchObject({ code: "decision_check_failed" });
    expect(await decisionSettings(f.db, f.org.id)).toBeNull();
  });

  test("an endpoint changed while the probe runs is not saved either", async () => {
    f = await setup();
    const endpoint = await customKey();
    const fake = fakeDecision();
    let first = true;
    const racing = (async (input: string | URL | Request, init?: RequestInit) => {
      if (first) {
        first = false;
        const [row] = await f.db
          .select()
          .from(schema.providerCredentials)
          .where(eq(schema.providerCredentials.id, endpoint.id));
        const previous = row?.options ?? {};
        if (!previous.endpoint) throw new Error("the endpoint is missing");
        await f.db
          .update(schema.providerCredentials)
          .set({
            options: {
              ...previous,
              endpoint: { ...previous.endpoint, baseURL: "https://changed.example.com/v1" },
            },
          })
          .where(eq(schema.providerCredentials.id, endpoint.id));
      }
      return fake.fetch(input, init);
    }) as typeof globalThis.fetch;
    await expect(
      decisionsFor(racing).save(f.org.id, f.owner.id, {
        credentialId: endpoint.id,
        model: "custom/decision-v1",
        visionModel: null,
      }),
    ).rejects.toMatchObject({ code: "decision_check_failed" });
    expect(await decisionSettings(f.db, f.org.id)).toBeNull();
  });

  test("a custom decision probe without a reported cost is saved: the cost is optional there", async () => {
    f = await setup();
    const endpoint = await customKey();
    const fetch = (async () =>
      Response.json({
        model: "decision-v1",
        answers: { ok: { noul: 1 }, pick: { choice: "ok" }, level: { score: 1 } },
      })) as unknown as typeof globalThis.fetch;
    const view = await decisionsFor(fetch).save(f.org.id, f.owner.id, {
      credentialId: endpoint.id,
      model: "decision-v1",
      visionModel: null,
    });
    expect(view.settings).toMatchObject({ credentialId: endpoint.id, model: "decision-v1" });
  });

  test("a refused probe says which side failed, not only that the model could not be tested", async () => {
    f = await setup();
    const endpoint = await customKey();
    const refuse = (status: number, fetch?: typeof globalThis.fetch) =>
      decisionsFor(fetch ?? fakeDecision({ status }).fetch).save(f.org.id, f.owner.id, {
        credentialId: endpoint.id,
        model: "custom/decision-v1",
        visionModel: null,
      });
    await expect(refuse(401)).rejects.toMatchObject({ code: "decision_check_refused" });
    await expect(refuse(402)).rejects.toMatchObject({ code: "decision_check_no_credit" });
    await expect(refuse(404)).rejects.toMatchObject({ code: "decision_check_no_route" });
    await expect(refuse(429)).rejects.toMatchObject({ code: "decision_check_rate_limited" });
    await expect(refuse(503)).rejects.toMatchObject({ code: "decision_check_endpoint_error" });
    await expect(refuse(422)).rejects.toMatchObject({ code: "decision_check_request_refused" });
    const unreachable = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof globalThis.fetch;
    await expect(refuse(0, unreachable)).rejects.toMatchObject({ code: "decision_check_unreachable" });
    expect(await decisionSettings(f.db, f.org.id)).toBeNull();
  });

  test("a probe that answers in the wrong shape, or with no box for the image, says so", async () => {
    f = await setup();
    const endpoint = await customKey();
    await expect(
      decisionsFor(fakeDecision({ bad: true }).fetch).save(f.org.id, f.owner.id, {
        credentialId: endpoint.id,
        model: "custom/decision-v1",
        visionModel: null,
      }),
    ).rejects.toMatchObject({ code: "decision_check_format" });
    const noBox = (async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { assets?: unknown };
      return body.assets
        ? Response.json({ model: "decision-v1", answers: { target: {} }, usage: { input_tokens: 1 } })
        : Response.json({
            model: "decision-v1",
            answers: { ok: { noul: 1 }, pick: { choice: "ok" }, level: { score: 1 } },
            usage: { input_tokens: 1 },
          });
    }) as unknown as typeof globalThis.fetch;
    await expect(
      decisionsFor(noBox).save(f.org.id, f.owner.id, {
        credentialId: endpoint.id,
        model: "decision-v1",
        visionModel: "decision-vision-v1",
      }),
    ).rejects.toMatchObject({ code: "decision_check_vision" });
    expect(await decisionSettings(f.db, f.org.id)).toBeNull();
  });

  const setStanding = (state: "hold" | "suspended", reason: string) =>
    f.db
      .update(schema.organizations)
      .set({ standing: state, standingReason: reason, standingNotice: "shown", standingChangedAt: new Date() })
      .where(eq(schema.organizations.id, f.org.id));

  test("a billing hold refuses a decision save before the provider is called, keeping the previous setup", async () => {
    f = await setup();
    const credential = await openRouterKey();
    const first = await decisionsFor(fakeDecision().fetch).save(f.org.id, f.owner.id, {
      credentialId: credential.id,
      model: "jaredpalmer/kev-4b",
      visionModel: null,
    });
    await setStanding("hold", "payment");
    const blocked = fakeDecision();
    await expect(
      decisionsFor(blocked.fetch).save(f.org.id, f.owner.id, {
        credentialId: credential.id,
        model: "jaredpalmer/other-kev",
        visionModel: null,
      }),
    ).rejects.toMatchObject({ code: "org.paused" });
    expect(blocked.calls).toEqual([]);
    expect(await decisionSettings(f.db, f.org.id)).toEqual(first.settings);
  });

  test("a suspended workspace calls no provider and keeps its decision setup", async () => {
    f = await setup();
    const credential = await openRouterKey();
    const first = await decisionsFor(fakeDecision().fetch).save(f.org.id, f.owner.id, {
      credentialId: credential.id,
      model: "jaredpalmer/kev-4b",
      visionModel: null,
    });
    await setStanding("suspended", "abuse");
    const blocked = fakeDecision();
    await expect(
      decisionsFor(blocked.fetch).save(f.org.id, f.owner.id, {
        credentialId: credential.id,
        model: "jaredpalmer/other-kev",
        visionModel: null,
      }),
    ).rejects.toMatchObject({ code: "org.suspended" });
    expect(blocked.calls).toEqual([]);
    expect(await decisionSettings(f.db, f.org.id)).toEqual(first.settings);
  });

  test("reset stays allowed on a billing hold: it makes no provider call", async () => {
    f = await setup();
    const credential = await openRouterKey();
    await decisionsFor(fakeDecision().fetch).save(f.org.id, f.owner.id, {
      credentialId: credential.id,
      model: "jaredpalmer/kev-4b",
      visionModel: null,
    });
    await setStanding("hold", "payment");
    const blocked = fakeDecision();
    expect(await decisionsFor(blocked.fetch).save(f.org.id, f.owner.id, null)).toEqual({
      settings: null,
      available: false,
    });
    expect(blocked.calls).toEqual([]);
    expect(await decisionSettings(f.db, f.org.id)).toBeNull();
  });

  test("a hold set while the probe runs keeps the new setup from landing", async () => {
    f = await setup();
    const credential = await openRouterKey();
    const first = await decisionsFor(fakeDecision().fetch).save(f.org.id, f.owner.id, {
      credentialId: credential.id,
      model: "jaredpalmer/kev-4b",
      visionModel: null,
    });
    const fake = fakeDecision();
    let firstCall = true;
    const racing = (async (input: string | URL | Request, init?: RequestInit) => {
      if (firstCall) {
        firstCall = false;
        await setStanding("hold", "payment");
      }
      return fake.fetch(input, init);
    }) as typeof globalThis.fetch;
    await expect(
      decisionsFor(racing).save(f.org.id, f.owner.id, {
        credentialId: credential.id,
        model: "jaredpalmer/other-kev",
        visionModel: null,
      }),
    ).rejects.toMatchObject({ code: "org.paused" });
    expect(fake.calls).toHaveLength(1);
    expect(await decisionSettings(f.db, f.org.id)).toEqual(first.settings);
  });
});
