import { expect, test } from "bun:test";
import { enrichEndpointModel, indexEndpointCatalog, loadEndpointCatalog } from "../src/endpoint-catalog";

const fixture = {
  one: {
    api: "https://example.com/v1",
    models: {
      shared: {
        limit: { context: 64_000, output: 8_000 },
        cost: { input: 1.5, output: 0 },
        modalities: { input: ["text", "image"] },
      },
    },
  },
  two: { models: { shared: { limit: { context: 128_000, output: 8_000 } } } },
};

test("endpoint metadata takes precedence, and catalog prices require the provider URL", () => {
  const catalog = indexEndpointCatalog(fixture);
  const endpoint = enrichEndpointModel(
    { id: "shared", discovered: { image: { discoveredAt: "2026-01-01T00:00:00Z", source: "probe", value: false } } },
    "https://example.com/v1/proxy",
    catalog,
  );
  expect(endpoint.discovered?.prices?.input?.value).toBe(1500);
  expect(endpoint.discovered?.prices?.output?.value).toBe(0);
  expect(endpoint.discovered?.image).toEqual({ source: "probe", value: false, discoveredAt: "2026-01-01T00:00:00Z" });
  expect(endpoint.discovered?.contextWindow?.value).toBe(64_000);
  const unknown = enrichEndpointModel({ id: "shared" }, "https://example.com/v11", catalog);
  expect(unknown.discovered?.prices).toBeUndefined();
  expect(unknown.discovered?.contextWindow?.value).toBeUndefined();
  expect(unknown.discovered?.maxOutputTokens).toBeUndefined();
});

test("concurrent discoveries share a catalog download", async () => {
  let calls = 0;
  const read = (async () => {
    calls++;
    return Response.json(fixture);
  }) as unknown as typeof fetch;
  const [first, second] = await Promise.all([loadEndpointCatalog(read), loadEndpointCatalog(read)]);
  expect(first?.providers).toHaveLength(2);
  expect(second).toBe(first);
  expect(calls).toBe(1);
});

test("partial endpoint metadata is backfilled per field with provenance", () => {
  const discoveredAt = "2026-01-01T00:00:00Z";
  const endpoint = enrichEndpointModel(
    { id: "shared", discovered: { contextWindow: { value: 32_000, source: "endpoint", discoveredAt } } },
    "https://example.com/v1",
    indexEndpointCatalog(fixture),
  );
  expect(endpoint.discovered?.contextWindow).toEqual({ value: 32_000, source: "endpoint", discoveredAt });
  expect(endpoint.discovered?.maxOutputTokens?.value).toBe(8_000);
  expect(endpoint.discovered?.prices?.output?.value).toBe(0);
});

test("api-less identity uses a qualified provider and never borrows colliding prices", () => {
  const catalog = indexEndpointCatalog({
    alpha: { models: { shared: { cost: { input: 1 }, limit: { context: 100 } } } },
    beta: { models: { shared: { cost: { input: 7 }, limit: { context: 100 } } } },
  });
  const alpha = enrichEndpointModel({ id: "alpha/shared" }, "https://gateway.example/v1", catalog);
  expect(alpha.discovered?.prices?.input?.value).toBe(1000);
  const unknown = enrichEndpointModel({ id: "shared" }, "https://gateway.example/v1", catalog);
  expect(unknown.discovered?.prices).toBeUndefined();
  expect(unknown.discovered?.contextWindow).toBeUndefined();
});

test("a model qualified for another provider cannot inherit a URL provider's bare-name price", () => {
  const catalog = indexEndpointCatalog({
    alpha: { api: "https://alpha.example/v1", models: { shared: { cost: { input: 1 } } } },
    beta: { models: { shared: { cost: { input: 7 } } } },
  });
  expect(
    enrichEndpointModel({ id: "beta/shared" }, "https://alpha.example/v1", catalog).discovered?.prices,
  ).toBeUndefined();
});

test("an api-less provider name in an unrelated subdomain does not establish price identity", () => {
  const catalog = indexEndpointCatalog({ alpha: { models: { shared: { cost: { input: 1 } } } } });
  expect(
    enrichEndpointModel({ id: "shared" }, "https://alpha.attacker.example/v1", catalog).discovered?.prices,
  ).toBeUndefined();
});

test("incomplete catalog modality lists leave absent attachment capabilities unknown", () => {
  const catalog = indexEndpointCatalog({
    alpha: {
      api: "https://alpha.example/v1",
      models: {
        partial: { modalities: { input: ["file"] } },
        complete: { modalities: { input: ["text"] } },
      },
    },
  });
  const partial = enrichEndpointModel({ id: "partial" }, "https://alpha.example/v1", catalog);
  expect(partial.discovered?.image).toBeUndefined();
  expect(partial.discovered?.pdf).toBeUndefined();
  const complete = enrichEndpointModel({ id: "complete" }, "https://alpha.example/v1", catalog);
  expect(complete.discovered?.image?.value).toBe(false);
  expect(complete.discovered?.pdf?.value).toBe(false);
});

test("identified model does not inherit other providers' missing capabilities", () => {
  const catalog = indexEndpointCatalog({
    alpha: { api: "https://api.alpha.example/v1", models: { model: { modalities: { input: ["image"] } } } },
    beta: { models: { model: { modalities: { input: ["text", "pdf"] }, limit: { context: 500 } } } },
  });
  const known = enrichEndpointModel({ id: "model" }, "https://api.alpha.example/v1", catalog);
  expect(known.discovered?.image?.value).toBe(true);
  expect(known.discovered?.pdf).toBeUndefined();
  expect(known.discovered?.contextWindow).toBeUndefined();
  const qualified = enrichEndpointModel({ id: "gamma/model" }, "https://gateway.example", catalog);
  expect(qualified.discovered?.contextWindow).toBeUndefined();
  expect(qualified.discovered?.pdf).toBeUndefined();
});

test("only explicit hosts identify api-less providers", () => {
  const catalog = indexEndpointCatalog({
    alpha: { models: { model: { cost: { input: 1 } } } },
    openai: { models: { model: { cost: { input: 2 } } } },
  });
  for (const url of ["https://api.alpha.example/v1", "https://api.alpha.co/v1"])
    expect(enrichEndpointModel({ id: "model" }, url, catalog).discovered?.prices).toBeUndefined();
  expect(
    enrichEndpointModel({ id: "model" }, "https://api.openai.com/v1", catalog).discovered?.prices?.input?.value,
  ).toBe(2000);
});

test("enrichment is idempotent when only discovery key order differs", () => {
  const date = "2026-01-01T00:00:00.000Z";
  const catalog = indexEndpointCatalog({ alpha: { api: "https://alpha.example/v1", models: { m: {} } } });
  const model = {
    id: "m",
    discovered: {
      image: { value: true, source: "endpoint" as const, discoveredAt: date },
      contextWindow: { value: 100, source: "endpoint" as const, discoveredAt: date },
    },
  };
  expect(enrichEndpointModel(model, "https://alpha.example/v1", catalog)).toBe(model);
});

test("unknown gateways cannot inherit colliding model metadata", () => {
  const catalog = indexEndpointCatalog({
    openai: { models: { "gpt-4o": { limit: { context: 128000 }, modalities: { input: ["image", "pdf"] } } } },
    other: { models: { "gpt-4o": { limit: { context: 128000 }, modalities: { input: ["image", "pdf"] } } } },
  });
  expect(enrichEndpointModel({ id: "gpt-4o" }, "https://random.example/v1", catalog).discovered).toBeUndefined();
});

test("canonical aliases require one provider and one model", () => {
  const catalog = indexEndpointCatalog({
    alpha: {
      api: "https://alpha.example/v1",
      models: {
        one: { canonical_model_id: "alias", limit: { context: 100 } },
        two: { canonical_model_id: "ambiguous", limit: { context: 200 } },
        three: { canonical_model_id: "ambiguous", limit: { context: 200 } },
      },
    },
  });
  expect(
    enrichEndpointModel({ id: "alias" }, "https://alpha.example/v1", catalog).discovered?.contextWindow?.value,
  ).toBe(100);
  expect(enrichEndpointModel({ id: "ambiguous" }, "https://alpha.example/v1", catalog).discovered).toBeUndefined();
});

test("endpoint text-only capabilities beat catalog attachment support", () => {
  const date = "2026-01-01T00:00:00.000Z";
  const catalog = indexEndpointCatalog({
    alpha: {
      api: "https://alpha.example/v1",
      models: {
        m: { modalities: { input: ["text", "image", "pdf"] } },
      },
    },
  });
  const model = {
    id: "m",
    discovered: {
      image: { source: "endpoint" as const, value: false, discoveredAt: date },
      pdf: { source: "endpoint" as const, value: false, discoveredAt: date },
    },
  };
  expect(enrichEndpointModel(model, "https://alpha.example/v1", catalog).discovered).toEqual(model.discovered);
});

test("unidentified models discard only stale catalog discovery", () => {
  const date = "2026-01-01T00:00:00.000Z";
  const catalog = indexEndpointCatalog({
    openai: { models: { "gpt-4o": { limit: { context: 100 }, modalities: { input: ["text", "image", "pdf"] } } } },
  });
  const field = <T>(value: T, source: "catalog" | "endpoint" | "probe") => ({ value, source, discoveredAt: date });
  const model = {
    id: "gpt-4o",
    overrides: { image: true },
    discovered: {
      contextWindow: field(100, "catalog"),
      maxOutputTokens: field(20, "endpoint"),
      image: field(true, "catalog"),
      pdf: field(false, "probe"),
      prices: { input: field(1, "catalog"), output: field(2, "endpoint") },
    },
  };
  expect(enrichEndpointModel(model, "https://random.example/v1", catalog)).toEqual({
    id: model.id,
    overrides: model.overrides,
    discovered: {
      maxOutputTokens: model.discovered.maxOutputTokens,
      pdf: model.discovered.pdf,
      prices: { output: model.discovered.prices.output },
    },
  });
  expect(
    enrichEndpointModel(
      { id: "gpt-4o", discovered: { image: field(true, "catalog") } },
      "https://random.example/v1",
      catalog,
    ),
  ).toEqual({ id: "gpt-4o" });
  expect(enrichEndpointModel(model, "https://api.openai.com/v1", catalog).discovered?.contextWindow).toEqual(
    model.discovered.contextWindow,
  );
});

test("identified catalog discovery refreshes changed values, drops absent values and keeps stronger evidence", () => {
  const date = "2020-01-01T00:00:00.000Z";
  const field = <T>(value: T, source: "catalog" | "endpoint" | "probe") => ({ value, source, discoveredAt: date });
  const catalog = indexEndpointCatalog({
    alpha: {
      api: "https://alpha.example/v1",
      models: {
        m: {
          limit: { context: 200, output: 30 },
          cost: { input: 0, output: 4 },
          modalities: { input: ["text", "pdf"] },
        },
      },
    },
  });
  const model = {
    id: "m",
    overrides: { image: true },
    discovered: {
      contextWindow: field(100, "catalog"),
      maxOutputTokens: field(30, "catalog"),
      image: field(true, "catalog"),
      pdf: field(false, "catalog"),
      prices: {
        input: field(0, "catalog"),
        output: field(2, "endpoint"),
        cacheRead: field(3, "catalog"),
        cacheWrite: field(4, "probe"),
      },
    },
  };
  const result = enrichEndpointModel(model, "https://alpha.example/v1", catalog);
  expect(result.overrides).toEqual(model.overrides);
  expect(result.discovered?.contextWindow).toMatchObject({ value: 200, source: "catalog" });
  expect(result.discovered?.contextWindow?.discoveredAt).not.toBe(date);
  expect(result.discovered?.image).toMatchObject({ value: false, source: "catalog" });
  expect(result.discovered?.image?.discoveredAt).not.toBe(date);
  expect(result.discovered?.pdf).toMatchObject({ value: true, source: "catalog" });
  expect(result.discovered?.pdf?.discoveredAt).not.toBe(date);
  expect(result.discovered?.maxOutputTokens).toEqual(model.discovered.maxOutputTokens);
  expect(result.discovered?.prices?.input).toEqual(model.discovered.prices.input);
  expect(result.discovered?.prices?.output).toEqual(model.discovered.prices.output);
  expect(result.discovered?.prices?.cacheWrite).toEqual(model.discovered.prices.cacheWrite);
  expect(result.discovered?.prices?.cacheRead).toBeUndefined();
  expect(enrichEndpointModel(result, "https://alpha.example/v1", catalog)).toBe(result);
});

test("endpoint and probe values beat changed catalog limits and modalities", () => {
  const date = "2020-01-01T00:00:00.000Z";
  const catalog = indexEndpointCatalog({
    alpha: {
      api: "https://alpha.example/v1",
      models: {
        m: {
          limit: { context: 200 },
          modalities: { input: ["text", "pdf"] },
        },
      },
    },
  });
  const discovered = {
    contextWindow: { value: 100, source: "endpoint" as const, discoveredAt: date },
    image: { value: true, source: "probe" as const, discoveredAt: date },
    pdf: { value: false, source: "endpoint" as const, discoveredAt: date },
  };
  expect(enrichEndpointModel({ id: "m", discovered }, "https://alpha.example/v1", catalog).discovered).toEqual(
    discovered,
  );
});
