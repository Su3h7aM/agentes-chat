import { afterEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { ProviderError } from "@agenteschat/providers";
import { createCredential, type ModelGateway, probeEndpoint } from "../src";
import { type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(() => f?.close());

async function endpoint() {
  f = await setup();
  const credential = await createCredential(
    f.db,
    f.keyWrapper,
    f.owner.id,
    f.org.id,
    {
      provider: "custom",
      label: "gateway",
      apiKey: "key",
      endpoint: { style: "openai", baseURL: "https://gw.example/v1", models: [{ id: "model" }] },
    },
    { net: { allowPrivate: true } },
  );
  const [row] = await f.db
    .select()
    .from(schema.providerCredentials)
    .where(eq(schema.providerCredentials.id, credential.id));
  if (!row?.options.endpoint) throw new Error("missing endpoint");
  const options = {
    ...row.options,
    endpoint: { ...row.options.endpoint, models: [{ id: "model", check: "ok" as const }] },
  };
  await f.db
    .update(schema.providerCredentials)
    .set({ options })
    .where(eq(schema.providerCredentials.id, credential.id));
  return credential.id;
}
const gateway = (complete: (input: Parameters<ModelGateway["complete"]>[0]) => Promise<unknown>) =>
  ({ complete }) as unknown as Pick<ModelGateway, "complete">;

function pdfCode(input: { messages: unknown[] }): string {
  const messages = input.messages as Array<{
    content?: Array<{ images?: Array<{ mediaType: string; data: string }> }>;
  }>;
  const file = messages
    .flatMap((m) => (Array.isArray(m.content) ? m.content.flatMap((c) => c.images ?? []) : []))
    .find((image) => image.mediaType === "application/pdf");
  const code = file && /\((\d{6})\) Tj/.exec(Buffer.from(file.data, "base64").toString())?.[1];
  if (!code) throw new Error("missing PDF code");
  return code;
}

test("probe accepts formatted exact codes and keeps unsuccessful OCR unknown", async () => {
  const id = await endpoint();
  const withCode = gateway(async (input) => ({
    text: pdfCode(input).split("").join("-\u00a0\u2003"),
    stopReason: "end_turn",
  }));
  const result = await probeEndpoint(f.db, withCode, f.owner.id, f.org.id, id, {});
  expect(result[0]?.discovered?.pdf?.value).toBe(true);
  expect(result[0]?.discovered?.image).toBeUndefined();
  const spaces = gateway(async (input) => ({ text: pdfCode(input).split("").join(" "), stopReason: "end_turn" }));
  const again = await probeEndpoint(f.db, spaces, f.owner.id, f.org.id, id, { force: true });
  expect(again[0]?.discovered?.pdf?.value).toBe(true);
});

test("probe false requires media evidence and excludes ambiguous errors", async () => {
  const id = await endpoint();
  for (const [status, message, expected] of [
    [400, "invalid model", undefined],
    [401, "image unsupported", undefined],
    [403, "image unsupported", undefined],
    [408, "image unsupported", undefined],
    [429, "image unsupported", undefined],
    [500, "image unsupported", undefined],
    [413, "too large", undefined],
    [422, "unprocessable", undefined],
    [404, "model acme/vision-instruct not found", undefined],
    [422, "invalid image", undefined],
    [400, "document unsupported", undefined],
    [415, "unsupported", false],
  ] as const) {
    const failing = gateway(async () => {
      throw new ProviderError(message, false, status);
    });
    const result = await probeEndpoint(f.db, failing, f.owner.id, f.org.id, id, { force: true });
    expect(result[0]?.discovered?.pdf?.value).toBe(expected);
  }
});

test("probe commit preserves concurrent manual and endpoint values", async () => {
  const id = await endpoint();
  let edited = false;
  const concurrent = gateway(async () => {
    if (!edited) {
      edited = true;
      const [row] = await f.db.select().from(schema.providerCredentials).where(eq(schema.providerCredentials.id, id));
      if (!row?.options.endpoint) throw new Error("missing endpoint");
      const model = row.options.endpoint.models[0];
      if (!model) throw new Error("missing model");
      const updated = {
        ...model,
        overrides: { image: true },
        discovered: { pdf: { source: "endpoint" as const, value: true, discoveredAt: "2026-01-01T00:00:00.000Z" } },
      };
      await f.db
        .update(schema.providerCredentials)
        .set({ options: { ...row.options, endpoint: { ...row.options.endpoint, models: [updated] } } })
        .where(eq(schema.providerCredentials.id, id));
    }
    throw new ProviderError("unsupported media", false, 415);
  });
  const result = await probeEndpoint(f.db, concurrent, f.owner.id, f.org.id, id, {});
  expect(result[0]?.overrides?.image).toBe(true);
  expect(result[0]?.discovered?.image).toBeUndefined();
  expect(result[0]?.discovered?.pdf).toEqual({
    source: "endpoint",
    value: true,
    discoveredAt: "2026-01-01T00:00:00.000Z",
  });
});

test("automatic and forced gating skip authoritative and manual values", async () => {
  const id = await endpoint();
  const timestamp = "2026-01-01T00:00:00.000Z";
  const [row] = await f.db.select().from(schema.providerCredentials).where(eq(schema.providerCredentials.id, id));
  if (!row?.options.endpoint) throw new Error("missing endpoint");
  for (const [source, manual, force, expected] of [
    ["endpoint", undefined, false, false],
    ["endpoint", undefined, true, false],
    ["catalog", undefined, false, true],
    ["catalog", undefined, true, true],
    ["probe", undefined, false, false],
    ["probe", undefined, true, true],
    [undefined, undefined, false, true],
    [undefined, undefined, true, true],
    ["catalog", false, false, false],
    [undefined, true, true, false],
  ] as const) {
    const discovered = source ? { pdf: { source, value: false, discoveredAt: timestamp } } : undefined;
    const model = {
      id: "model",
      check: "ok" as const,
      overrides: { image: false, ...(manual === undefined ? {} : { pdf: manual }) },
      ...(discovered ? { discovered } : {}),
    };
    await f.db
      .update(schema.providerCredentials)
      .set({ options: { ...row.options, endpoint: { ...row.options.endpoint, models: [model] } } })
      .where(eq(schema.providerCredentials.id, id));
    let calls = 0;
    const noCode = gateway(async () => {
      calls++;
      return { text: "no code", stopReason: "end_turn" };
    });
    await probeEndpoint(f.db, noCode, f.owner.id, f.org.id, id, { force });
    expect(calls).toBe(expected ? 1 : 0);
  }
});

test("a combined rejection is split and each media result needs its own evidence", async () => {
  const id = await endpoint();
  const seen: string[] = [];
  const split = gateway(async (input) => {
    const types = Object.keys(input.endpointReads ?? {})
      .sort()
      .join(",");
    seen.push(types);
    if (types === "image,pdf") throw new ProviderError("unsupported attachment", false, 415);
    if (types === "pdf") throw new ProviderError("invalid model", false, 400);
    throw new ProviderError("image is unsupported", false, 415);
  });
  const result = await probeEndpoint(f.db, split, f.owner.id, f.org.id, id, {});
  expect(seen.sort()).toEqual(["image", "image,pdf", "pdf"]);
  expect(result[0]?.discovered?.image?.value).toBe(false);
  expect(result[0]?.discovered?.pdf).toBeUndefined();
});

test("a code embedded in another word is not probe evidence", async () => {
  const id = await endpoint();
  const embedded = gateway(async (input) => ({ text: `x${pdfCode(input)}y`, stopReason: "end_turn" }));
  const result = await probeEndpoint(f.db, embedded, f.owner.id, f.org.id, id, {});
  expect(result[0]?.discovered?.pdf).toBeUndefined();
});
