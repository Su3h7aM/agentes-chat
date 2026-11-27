export type DiscoverySource = "endpoint" | "probe" | "catalog";
export type Discovered<T> = { value: T; source: DiscoverySource; discoveredAt: string };
export type DiscoveryPrice = "input" | "output" | "cacheRead" | "cacheWrite";
export interface EndpointModelDiscovery {
  contextWindow?: Discovered<number>;
  maxOutputTokens?: Discovered<number>;
  prices?: Partial<Record<DiscoveryPrice, Discovered<number>>>;
  image?: Discovered<boolean>;
  pdf?: Discovered<boolean>;
}
export function shouldProbeAttachment(
  discovered: { source: DiscoverySource } | undefined,
  manual: boolean | undefined,
  force = false,
): boolean {
  return (
    manual === undefined &&
    discovered?.source !== "endpoint" &&
    (force || !discovered || discovered.source === "catalog")
  );
}
type LegacyField<T> = { source: DiscoverySource; value: T; discoveredAt?: string };
export interface LegacyEndpointDiscovery {
  discoveredAt: string;
  limits?: LegacyField<{ contextWindow?: number; maxOutputTokens?: number }>;
  prices?: LegacyField<Partial<Record<DiscoveryPrice, number>>>;
  image?: LegacyField<boolean>;
  pdf?: LegacyField<boolean>;
}
const prices: DiscoveryPrice[] = ["input", "output", "cacheRead", "cacheWrite"];
const rank: Record<DiscoverySource, number> = { endpoint: 3, probe: 2, catalog: 1 };
function choose<T>(a?: Discovered<T>, b?: Discovered<T>): Discovered<T> | undefined {
  if (!a) return b;
  if (!b) return a;
  return rank[b.source] > rank[a.source] ||
    (b.source === a.source && Date.parse(b.discoveredAt) > Date.parse(a.discoveredAt))
    ? b
    : a;
}
export function normalizeEndpointDiscovery(
  value?: EndpointModelDiscovery | LegacyEndpointDiscovery,
): EndpointModelDiscovery | undefined {
  if (!value) return undefined;
  if (!("discoveredAt" in value)) return value;
  const legacy = value as LegacyEndpointDiscovery & EndpointModelDiscovery;
  const { discoveredAt: date, limits, ...rest } = legacy;
  const groupedPrices =
    legacy.prices && "value" in legacy.prices ? (legacy.prices as LegacyEndpointDiscovery["prices"]) : undefined;
  const result: EndpointModelDiscovery = { ...rest, ...(groupedPrices ? { prices: undefined } : {}) };
  if (limits?.value) {
    for (const [key, item] of Object.entries(limits.value)) {
      if (key !== "contextWindow" && key !== "maxOutputTokens" && !(key in result))
        Object.assign(result, { [key]: item });
    }
  }
  if (groupedPrices?.value) {
    for (const [key, item] of Object.entries(groupedPrices.value)) {
      if (!prices.includes(key as DiscoveryPrice)) {
        result.prices ??= {};
        Object.assign(result.prices, {
          [key]: { value: item, source: groupedPrices.source, discoveredAt: groupedPrices.discoveredAt ?? date },
        });
      }
    }
  }
  for (const key of ["contextWindow", "maxOutputTokens"] as const) {
    const n = limits?.value[key];
    if (!result[key] && n !== undefined)
      result[key] = { value: n, source: limits?.source ?? "catalog", discoveredAt: date };
  }
  for (const key of prices) {
    const n = groupedPrices?.value[key];
    if (n !== undefined) {
      result.prices ??= {};
      result.prices[key] ??= {
        value: n,
        source: groupedPrices?.source ?? "catalog",
        discoveredAt: groupedPrices?.discoveredAt ?? date,
      };
    }
  }
  for (const key of ["image", "pdf"] as const) {
    const entry = legacy[key];
    if (entry) result[key] = { ...entry, discoveredAt: entry.discoveredAt ?? date };
  }
  return result;
}
export function mergeEndpointDiscovery(
  a?: EndpointModelDiscovery | LegacyEndpointDiscovery,
  b?: EndpointModelDiscovery | LegacyEndpointDiscovery,
): EndpointModelDiscovery | undefined {
  const first = normalizeEndpointDiscovery(a);
  const second = normalizeEndpointDiscovery(b);
  if (!first && !second) return undefined;
  const result: EndpointModelDiscovery = {
    ...first,
    ...second,
    ...(first?.prices || second?.prices ? { prices: { ...first?.prices, ...second?.prices } } : {}),
  };
  for (const key of ["contextWindow", "maxOutputTokens", "image", "pdf"] as const) {
    const chosen = choose(
      first?.[key] as Discovered<number | boolean> | undefined,
      second?.[key] as Discovered<number | boolean> | undefined,
    );
    if (chosen) Object.assign(result, { [key]: chosen });
  }
  for (const key of prices) {
    const chosen = choose(first?.prices?.[key], second?.prices?.[key]);
    if (chosen) {
      result.prices ??= {};
      result.prices[key] = chosen;
    }
  }
  return result;
}
