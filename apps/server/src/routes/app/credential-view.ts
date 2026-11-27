import { endpointPricesFromUsd, endpointPricesToUsd, type listCredentials } from "@agenteschat/engine";
import {
  type EndpointModelDiscovery,
  type LegacyEndpointDiscovery,
  normalizeEndpointDiscovery,
} from "@agenteschat/providers";
import type { z } from "@hono/zod-openapi";
import { iso } from "./context";
import type { EndpointModel } from "./schemas";

type ModelIn = z.infer<typeof EndpointModel>;
type CredentialRow = Awaited<ReturnType<typeof listCredentials>>[number];

type PartialPrices = NonNullable<NonNullable<ModelIn["overrides"]>["prices"]>;

function mapPrices(prices: PartialPrices, convert: (value: number) => number): PartialPrices {
  return {
    ...(prices.input === undefined ? {} : { input: convert(prices.input) }),
    ...(prices.output === undefined ? {} : { output: convert(prices.output) }),
    ...(prices.cacheRead === undefined ? {} : { cacheRead: convert(prices.cacheRead) }),
    ...(prices.cacheWrite === undefined ? {} : { cacheWrite: convert(prices.cacheWrite) }),
  };
}

function mapCapabilities(
  {
    overrides,
    discovered,
  }: { overrides?: ModelIn["overrides"]; discovered?: EndpointModelDiscovery | LegacyEndpointDiscovery },
  convert: (value: number) => number,
) {
  const normalized = normalizeEndpointDiscovery(discovered);
  return {
    ...(overrides
      ? { overrides: { ...overrides, ...(overrides.prices ? { prices: mapPrices(overrides.prices, convert) } : {}) } }
      : {}),
    ...(normalized
      ? {
          discovered: {
            ...normalized,
            ...(normalized.prices
              ? {
                  prices: {
                    ...normalized.prices,
                    ...Object.fromEntries(
                      (["input", "output", "cacheRead", "cacheWrite"] as const).flatMap((key) => {
                        const field = normalized.prices?.[key];
                        return field ? [[key, { ...field, value: convert(field.value) }]] : [];
                      }),
                    ),
                  },
                }
              : {}),
          },
        }
      : {}),
  };
}

export const modelIn = ({ prices, overrides, discovered, check: _check, ...m }: ModelIn) => ({
  ...m,
  ...(prices ? { prices: endpointPricesFromUsd(prices) } : {}),
  ...mapCapabilities({ overrides, discovered }, (usd) => Math.round(usd * 1000)),
});
export const modelOut = ({
  prices,
  overrides,
  discovered,
  ...m
}: NonNullable<CredentialRow["endpoint"]>["models"][number]) => ({
  ...m,
  ...(prices ? { prices: endpointPricesToUsd(prices) } : {}),
  ...mapCapabilities({ overrides, discovered }, (nanoUsd) => nanoUsd / 1000),
});

/** A credential as the API shows it: dates as text, an endpoint's prices per million tokens. */
export const credentialOut = ({ endpoint, ...r }: CredentialRow) => ({
  ...r,
  ...(endpoint ? { endpoint: { ...endpoint, models: endpoint.models.map(modelOut) } } : {}),
  createdAt: r.createdAt.toISOString(),
  revokedAt: iso(r.revokedAt),
});
