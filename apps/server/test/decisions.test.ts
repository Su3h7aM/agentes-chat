import { afterEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { sealSecret } from "@agenteschat/engine";
import { type Browser, browser, createTestServer, signUp, type TestServer } from "./harness";

let t: TestServer | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const org = async (b: Browser, name: string) =>
  ((await (await b("/api/app/organizations", { json: { name } })).json()) as { organization: { id: string } })
    .organization.id;

async function providerKey(
  server: TestServer,
  orgId: string,
  provider: string,
  apiKey: string,
  endpoint?: { style: "openai" | "anthropic"; baseURL: string; models: { id: string }[] },
) {
  const id = crypto.randomUUID();
  const sealed = await sealSecret(server.adapters.keyWrapper, apiKey, `provider-credential|${orgId}|${id}`);
  await server.db.insert(schema.providerCredentials).values({
    id,
    orgId,
    provider,
    label: provider,
    secretCiphertext: sealed.ciphertext,
    wrappedDataKey: sealed.wrappedDataKey,
    kekId: sealed.kekId,
    keyHint: apiKey.slice(-4),
    ...(endpoint ? { options: { endpoint } } : {}),
  });
  return id;
}

function fakeDecision(options: { bad?: boolean } = {}) {
  const calls: { url: string; body: { model?: string; assets?: unknown } }[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string; assets?: unknown };
    calls.push({ url: String(input), body });
    if (options.bad) return Response.json({ answers: { ok: { noul: "high" }, pick: { choice: "other" } } });
    return Response.json({
      model: body.model,
      answers: { ok: { noul: 1 }, pick: { choice: "ok" }, level: { score: 1 } },
      usage: { input_tokens: 4.5, output_tokens: 1.5, cost: 0 },
    });
  }) as unknown as typeof globalThis.fetch;
  return { fetch: fetcher, calls };
}

async function server(fetch: typeof globalThis.fetch, signups = 2) {
  t = await createTestServer({
    env: { ALLOW_SIGNUP: "true" },
    jevFetch: fetch,
    resolveHost: async () => ["93.184.216.34"],
  });
  const browsers = [];
  for (let i = 0; i < signups; i++) {
    const b = browser(t);
    await signUp(b, `person${i}@example.com`);
    browsers.push(b);
  }
  return { t, owner: browsers[0] as Browser, other: browsers[1] as Browser };
}

async function member(server: TestServer, orgId: string, email: string) {
  const [user] = await server.db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, email));
  if (!user) throw new Error("no user");
  await server.db
    .insert(schema.organizationMembers)
    .values({ orgId, userId: user.id, role: "member" })
    .onConflictDoNothing();
}

test("a decision model is probed, saved per workspace, and needs manage_credentials", async () => {
  const fake = fakeDecision();
  const { t, owner, other } = await server(fake.fetch);
  const acme = await org(owner, "Acme");
  const beta = await org(other, "Beta");
  await member(t, acme, "person1@example.com");
  const credentialId = await providerKey(t, acme, "openrouter", "sk-or-v1-workspace_secret_1234");

  const saved = await owner(`/api/app/organizations/${acme}/decisions`, {
    method: "PUT",
    json: { settings: { credentialId, model: "jaredpalmer/kev-4b", visionModel: null } },
  });
  expect(saved.status).toBe(200);
  const text = await saved.text();
  expect(text).not.toContain("workspace_secret");
  expect(JSON.parse(text)).toEqual({
    settings: { credentialId, model: "jaredpalmer/kev-4b", visionModel: null },
    available: true,
  });
  expect(fake.calls).toEqual([
    {
      url: "https://openrouter.ai/api/alpha/decisions",
      body: expect.objectContaining({ model: "jaredpalmer/kev-4b" }),
    },
  ]);
  const [audit] = await t.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "decisions.changed"));
  expect(audit?.details).toMatchObject({ credentialId, model: "jaredpalmer/kev-4b" });
  expect(JSON.stringify(audit)).not.toContain("workspace_secret");

  const status = await owner(`/api/app/organizations/${acme}/ai-status`);
  expect(await status.json()).toMatchObject({ routing: { by: "jev", model: "jaredpalmer/kev-4b" } });

  expect((await other(`/api/app/organizations/${acme}/decisions`)).status).toBe(403);
  expect(
    (
      await other(`/api/app/organizations/${acme}/decisions`, {
        method: "PUT",
        json: { settings: { credentialId, model: "jaredpalmer/kev-4b", visionModel: null } },
      })
    ).status,
  ).toBe(403);
  expect((await owner(`/api/app/organizations/${beta}/decisions`)).status).toBe(403);

  expect((await owner(`/api/app/organizations/${acme}/credentials/${credentialId}`, { method: "DELETE" })).status).toBe(
    409,
  );

  const reset = await owner(`/api/app/organizations/${acme}/decisions`, { method: "DELETE" });
  expect(reset.status).toBe(200);
  expect(await reset.json()).toEqual({ settings: null, available: false });
  expect((await owner(`/api/app/organizations/${acme}/decisions`)).status).toBe(200);
  expect(await (await owner(`/api/app/organizations/${acme}/decisions`)).json()).toEqual({
    settings: null,
    available: false,
  });
});

test("a failed probe keeps nothing and answers with a stable code", async () => {
  const fake = fakeDecision({ bad: true });
  const { t, owner } = await server(fake.fetch, 1);
  const acme = await org(owner, "Acme");
  const credentialId = await providerKey(t, acme, "openrouter", "sk-or-v1-bad_probe_5678");
  const res = await owner(`/api/app/organizations/${acme}/decisions`, {
    method: "PUT",
    json: { settings: { credentialId, model: "jaredpalmer/kev-4b", visionModel: null } },
  });
  expect(res.status).toBe(400);
  expect(await res.json()).toMatchObject({ error: { code: "decision_check_format" } });
  expect(await (await owner(`/api/app/organizations/${acme}/decisions`)).json()).toEqual({
    settings: null,
    available: false,
  });
});

test("a custom chat key derives /systemone, and a full endpoint override is saved exactly", async () => {
  const fake = fakeDecision();
  const { t, owner } = await server(fake.fetch, 1);
  const acme = await org(owner, "Acme");
  const credentialId = await providerKey(t, acme, "custom", "custom-key-1234", {
    style: "openai",
    baseURL: "https://gateway.example/v1",
    models: [{ id: "chat-model" }],
  });
  const derived = await owner(`/api/app/organizations/${acme}/decisions`, {
    method: "PUT",
    json: { settings: { credentialId, model: "jev-compatible", visionModel: null } },
  });
  expect(derived.status).toBe(200);
  expect(await derived.json()).toEqual({
    settings: { credentialId, model: "jev-compatible", visionModel: null },
    available: true,
  });
  expect(fake.calls[0]?.url).toBe("https://gateway.example/v1/systemone");

  const override = "https://decisions.example.com/api/decisions/?tenant=acme";
  const exact = await owner(`/api/app/organizations/${acme}/decisions`, {
    method: "PUT",
    json: { settings: { credentialId, model: "jev-compatible", visionModel: null, endpoint: override } },
  });
  expect(exact.status).toBe(200);
  expect(await exact.json()).toMatchObject({ settings: { endpoint: override } });
  expect(fake.calls[1]?.url).toBe(override);

  const rejected = await owner(`/api/app/organizations/${acme}/decisions`, {
    method: "PUT",
    json: { settings: { credentialId, model: "jev-compatible", visionModel: null, endpoint: "https://127.0.0.1/v1" } },
  });
  expect(rejected.status).toBe(400);
  expect(await rejected.json()).toMatchObject({ error: { code: "url.internal" } });
  expect(fake.calls).toHaveLength(2);
});
