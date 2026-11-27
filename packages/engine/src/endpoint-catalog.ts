import { isDeepStrictEqual } from "node:util";
import { readCapped } from "@agenteschat/adapters";
import {
  type EndpointModelDiscovery,
  inputAttachmentCapabilities,
  mergeEndpointDiscovery,
  normalizeEndpointDiscovery,
} from "@agenteschat/providers";
import type { EndpointModel } from "./endpoints";

type Capabilities = {
  contextWindow?: number;
  maxOutputTokens?: number;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  image?: boolean;
  pdf?: boolean;
};
type Provider = {
  key: string;
  api?: string;
  models: Map<string, Capabilities>;
  canonical: Map<string, Capabilities[]>;
};
const HOST_PROVIDERS: Record<string, string> = {
  "api.openai.com": "openai",
  "api.anthropic.com": "anthropic",
  "generativelanguage.googleapis.com": "google",
  "api.x.ai": "xai",
};
const TTL = 24 * 60 * 60 * 1000;
const RETRY = 60_000;
const LIMIT = 16_000_000;
const URL = "https://models.dev/api.json";

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function tokens(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function price(value: unknown): number | undefined {
  return typeof value === "number" && value >= 0 && value <= 10_000 ? Math.round(value * 1000) : undefined;
}

function apiPrefix(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  try {
    const url = new globalThis.URL(raw);
    if (url.protocol === "https:" || url.protocol === "http:") return url.origin + url.pathname.replace(/\/+$/, "");
  } catch {
    return undefined;
  }
}

export function indexEndpointCatalog(body: unknown) {
  const providers: Provider[] = [];
  const add = (index: Map<string, Capabilities[]>, id: string, caps: Capabilities) => {
    const entries = index.get(id);
    if (entries) entries.push(caps);
    else index.set(id, [caps]);
  };
  for (const [key, rawProvider] of Object.entries(record(body))) {
    const provider = record(rawProvider);
    const models = new Map<string, Capabilities>();
    const providerCanonical = new Map<string, Capabilities[]>();
    providers.push({ key, api: apiPrefix(provider.api), models, canonical: providerCanonical });
    for (const [id, rawModel] of Object.entries(record(provider.models))) {
      const model = record(rawModel);
      const input = record(model.modalities).input;
      const limits = record(model.limit);
      const cost = record(model.cost);
      const caps: Capabilities = {
        contextWindow: tokens(limits.context),
        maxOutputTokens: tokens(limits.output),
        input: price(cost.input),
        output: price(cost.output),
        cacheRead: price(cost.cache_read),
        cacheWrite: price(cost.cache_write),
        ...(Array.isArray(input) && input.every((item) => typeof item === "string")
          ? inputAttachmentCapabilities(input)
          : {}),
      };
      models.set(id, caps);
      if (typeof model.canonical_model_id === "string") {
        add(providerCanonical, model.canonical_model_id, caps);
      }
    }
  }
  return { providers: providers.sort((a, b) => (b.api?.length ?? 0) - (a.api?.length ?? 0)) };
}

type Catalog = ReturnType<typeof indexEndpointCatalog>;
const caches = new WeakMap<
  typeof fetch,
  { catalog?: Catalog; pending?: Promise<Catalog | undefined>; retryAt: number }
>();

export function loadEndpointCatalog(read: typeof fetch = fetch): Promise<Catalog | undefined> {
  const cache = caches.get(read) ?? { retryAt: 0 };
  caches.set(read, cache);
  if (!cache.pending && Date.now() >= cache.retryAt) {
    cache.pending = (async () => {
      try {
        const response = await read(URL, { signal: AbortSignal.timeout(5_000), redirect: "error" });
        const bytes = response.ok ? await readCapped(response, LIMIT) : null;
        if (!bytes) throw new Error("Could not read models.dev");
        const catalog = indexEndpointCatalog(JSON.parse(new TextDecoder().decode(bytes)));
        if (!catalog.providers.some((provider) => provider.models.size)) throw new Error("Empty models.dev catalog");
        cache.catalog = catalog;
        cache.retryAt = Date.now() + TTL;
      } catch {
        cache.retryAt = Date.now() + RETRY;
      }
      return cache.catalog;
    })().finally(() => {
      cache.pending = undefined;
    });
  }
  return cache.catalog ? Promise.resolve(cache.catalog) : (cache.pending ?? Promise.resolve(undefined));
}

function withoutCatalogDiscovery(value: EndpointModelDiscovery | undefined): EndpointModelDiscovery | undefined {
  if (!value) return undefined;
  const kept = Object.fromEntries(
    Object.entries(value).filter(([key, field]) => key !== "prices" && record(field).source !== "catalog"),
  ) as EndpointModelDiscovery;
  if (value.prices) {
    const prices = Object.fromEntries(
      Object.entries(value.prices).filter(([, field]) => record(field).source !== "catalog"),
    );
    if (Object.keys(prices).length) kept.prices = prices;
  }
  return Object.keys(kept).length ? kept : undefined;
}

export function enrichEndpointModel(model: EndpointModel, baseURL: string, catalog: Catalog): EndpointModel {
  const base = apiPrefix(baseURL);
  const slash = model.id.indexOf("/");
  const bare = slash < 0 ? model.id : model.id.slice(slash + 1);
  const urlMatches = catalog.providers.filter(({ api }) => api && (api === base || base?.startsWith(`${api}/`)));
  const longest = urlMatches[0]?.api?.length;
  const urlProviders = urlMatches.filter((p) => p.api?.length === longest);
  let host = "";
  try {
    host = new globalThis.URL(baseURL).hostname.toLowerCase();
  } catch {}
  const nameMatches = catalog.providers.filter(
    (p) => !p.api && ((slash > 0 && model.id.slice(0, slash) === p.key) || HOST_PROVIDERS[host] === p.key),
  );
  const candidates = urlProviders.length ? urlProviders : nameMatches;
  const provider = candidates.length === 1 ? candidates[0] : undefined;
  const lookupId = slash < 0 || model.id.slice(0, slash) === provider?.key ? bare : model.id;
  const exact = provider?.models.get(model.id) ?? provider?.models.get(lookupId);
  const aliases = provider?.canonical.get(model.id) ?? provider?.canonical.get(lookupId);
  const known = exact ?? (aliases?.length === 1 ? aliases[0] : undefined);
  const normalized = normalizeEndpointDiscovery(model.discovered);
  const existing = withoutCatalogDiscovery(normalized);
  const now = new Date().toISOString();
  const discovered: EndpointModelDiscovery = {};
  for (const key of ["contextWindow", "maxOutputTokens", "image", "pdf"] as const) {
    const value = known?.[key];
    if (value !== undefined && !existing?.[key]) {
      const prior = normalized?.[key];
      const field =
        prior?.source === "catalog" && prior.value === value
          ? prior
          : { value, source: "catalog" as const, discoveredAt: now };
      Object.assign(discovered, { [key]: field });
    }
  }
  for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
    const value = known?.[key];
    if (value !== undefined && !existing?.prices?.[key]) {
      discovered.prices ??= {};
      const prior = normalized?.prices?.[key];
      discovered.prices[key] =
        prior?.source === "catalog" && prior.value === value ? prior : { value, source: "catalog", discoveredAt: now };
    }
  }
  const merged = mergeEndpointDiscovery(existing, discovered);
  if (!merged || !Object.keys(merged).length) {
    if (!model.discovered) return model;
    const { discovered: _discarded, ...withoutDiscovery } = model;
    return withoutDiscovery;
  }
  return isDeepStrictEqual(merged, model.discovered) ? model : { ...model, discovered: merged };
}
