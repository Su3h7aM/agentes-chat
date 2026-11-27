import { mergeEndpointApiRefresh, shouldProbeAttachment } from "@agenteschat/providers/endpoint-discovery";
import type {
  EndpointApi,
  EndpointAttachment,
  EndpointCheck,
  EndpointCheckResult,
  EndpointModel,
  EndpointOverrides,
  EndpointStyle,
} from "../api/types";

/**
 * "Outro provedor" (ADR 0146), web and phone: a workspace's own OpenAI- or Anthropic-compatible endpoint (a gateway,
 * Ollama, vLLM, LM Studio, LiteLLM) as the form holds it while an admin fills it in.
 */
export const CUSTOM_PROVIDER = "custom";

export const ENDPOINT_STYLES: readonly EndpointStyle[] = ["openai", "anthropic"];
export const ENDPOINT_API_LABELS = {
  chat: "Chat Completions",
  messages: "Anthropic Messages",
  responses: "OpenAI Responses",
} as const satisfies Record<EndpointApi, string>;

export const ENDPOINT_LIMITS = ["contextWindow", "maxOutputTokens"] as const;
export const ENDPOINT_PRICES = ["input", "output", "cacheRead", "cacheWrite"] as const;
export const ENDPOINT_ATTACHMENTS = ["image", "pdf"] as const;
export type EndpointNumberField = (typeof ENDPOINT_LIMITS)[number] | (typeof ENDPOINT_PRICES)[number];

export interface EndpointModelDraft extends Pick<EndpointModel, "id" | "label" | "discovered" | "apiCheckedAt"> {
  on: boolean;
  /** Typed by hand and absent from the provider's list: the one kind of model the form lets its person remove. */
  typed?: true;
  manual?: Partial<Record<EndpointNumberField, string> & Record<EndpointAttachment, boolean>> & { api?: EndpointApi };
}

export interface EndpointDraft {
  name: string;
  style: EndpointStyle;
  listingStyle?: EndpointStyle;
  baseURL: string;
  apiKey: string;
  models: EndpointModelDraft[];
}

export const emptyEndpointDraft = (): EndpointDraft => ({
  name: "",
  style: "openai",
  baseURL: "",
  apiKey: "",
  models: [],
});

/** The address field's example, as each API's SDK takes it. */
export const endpointBaseExample = (style: EndpointStyle) =>
  style === "anthropic" ? "https://api.example.com/anthropic" : "https://api.example.com/v1";

const MODEL_ID = /^[\w.:/@+-]{1,200}$/;
export const MAX_ENDPOINT_MODELS = 100;

/** Evidence belongs to the address that produced it, while manual choices survive edits. */
export function withEndpointAddress(draft: EndpointDraft, baseURL: string): EndpointDraft {
  if (baseURL === draft.baseURL) return draft;
  return {
    ...draft,
    baseURL,
    listingStyle: undefined,
    models: draft.models.map(({ discovered: _discovered, apiCheckedAt: _apiCheckedAt, ...model }) => model),
  };
}

/**
 * Refresh metadata, keeping the selection, typed values and any previous attachment test. A model typed by hand that the
 * provider now lists is the provider's from then on.
 */
export function withListedModels(
  draft: EndpointDraft,
  listed: readonly Pick<EndpointModel, "id" | "label" | "discovered" | "apiCheckedAt">[],
): EndpointDraft {
  const byId = new Map(listed.map((m) => [m.id, m]));
  const models = draft.models.map((m) => {
    const found = byId.get(m.id);
    if (!found) return m;
    byId.delete(m.id);
    const { typed: _typed, ...kept } = m;
    return {
      ...kept,
      label: found.label ?? m.label,
      apiCheckedAt:
        found.apiCheckedAt && (!m.apiCheckedAt || Date.parse(found.apiCheckedAt) > Date.parse(m.apiCheckedAt))
          ? found.apiCheckedAt
          : m.apiCheckedAt,
      discovered: mergeEndpointApiRefresh(m.discovered, found.discovered, m.apiCheckedAt, found.apiCheckedAt),
    };
  });
  return { ...draft, models: [...models, ...[...byId.values()].map((m) => ({ ...m, on: false }))] };
}

/** A model id typed by hand, added on; null when it doesn't look like one. Already there: switched on. */
export function withTypedModel(draft: EndpointDraft, typed: string): EndpointDraft | null {
  const id = typed.trim();
  if (!MODEL_ID.test(id)) return null;
  if (draft.models.some((m) => m.id === id))
    return { ...draft, models: draft.models.map((m) => (m.id === id ? { ...m, on: true } : m)) };
  return { ...draft, models: [...draft.models, { id, on: true, typed: true }] };
}

/** A model the provider lists stays listed (unticking leaves it out), so only one typed by hand goes. */
export const withoutModel = (draft: EndpointDraft, id: string): EndpointDraft => ({
  ...draft,
  models: draft.models.filter((m) => m.id !== id || !m.typed),
});

/** A typed price: empty is none, a comma reads as the decimal point; null when it isn't a price. */
export function parsePrice(text: string): number | undefined | null {
  const t = text.trim().replace(",", ".");
  if (!t) return undefined;
  const n = Number(t);
  return /^\d+(\.\d+)?$/.test(t) && Number.isFinite(n) && n <= 10_000 ? n : null;
}

export function discoveredNumber(m: EndpointModelDraft, field: EndpointNumberField): number | undefined {
  switch (field) {
    case "contextWindow":
    case "maxOutputTokens":
      return m.discovered?.[field]?.value;
    default: {
      const prices = m.discovered?.prices;
      // Cache prices default to the effective input price, as they do on the server.
      return (
        prices?.[field]?.value ??
        (field === "cacheRead" || field === "cacheWrite"
          ? (parsePrice(m.manual?.input ?? "") ?? prices?.input?.value)
          : undefined)
      );
    }
  }
}

export function parseLimit(value: string): number | undefined | null {
  const raw = value.trim();
  if (!raw) return undefined;
  const n = Number(raw);
  return /^\d+$/.test(raw) && Number.isSafeInteger(n) && n > 0 ? n : null;
}

export function modelUnpricedInDraft(m: EndpointModelDraft): boolean {
  return ENDPOINT_PRICES.slice(0, 2).some(
    (field) => parsePrice(m.manual?.[field] ?? "") === undefined && discoveredNumber(m, field) === undefined,
  );
}

export function numberFieldLabel(field: EndpointNumberField) {
  if (field === "input") return "endpoint.priceInShort";
  if (field === "output") return "endpoint.priceOutShort";
  return `endpoint.capabilities.${field}` as const;
}

export function editNumber(m: EndpointModelDraft, field: EndpointNumberField, raw: string) {
  const parse = field === "contextWindow" || field === "maxOutputTokens" ? parseLimit : parsePrice;
  const auto = discoveredNumber(m, field);
  return { ...m.manual, [field]: parse(raw) === auto ? undefined : raw };
}

/** A compact status stays visible even when another editor is open. */
export function modelSummary(
  m: EndpointModelDraft,
  t: (key: "endpoint.modelInvalidValues" | "endpoint.modelMissingPrice" | "endpoint.capabilities.automatic") => string,
): string {
  const invalid =
    ENDPOINT_LIMITS.some((field) => parseLimit(m.manual?.[field] ?? "") === null) ||
    ENDPOINT_PRICES.some((field) => parsePrice(m.manual?.[field] ?? "") === null);
  const status = [
    m.on && invalid ? t("endpoint.modelInvalidValues") : "",
    m.on && modelUnpricedInDraft(m) ? t("endpoint.modelMissingPrice") : "",
  ].filter(Boolean);
  if (status.length) return status.join(" · ");
  const api = m.manual?.api ?? m.discovered?.api?.value;
  return api ? ENDPOINT_API_LABELS[api] : t("endpoint.capabilities.automatic");
}

/** Only write manual fields. An explicit empty object clears the previous overrides. */
export function endpointModelsOf(draft: Pick<EndpointDraft, "models">): EndpointModel[] | null {
  const on = draft.models.filter((m) => m.on);
  if (on.length === 0 || on.length > MAX_ENDPOINT_MODELS) return null;
  const models: EndpointModel[] = [];
  for (const { id, label, discovered, apiCheckedAt, manual } of on) {
    const overrides: EndpointOverrides = {};
    for (const field of ENDPOINT_LIMITS) {
      const value = parseLimit(manual?.[field] ?? "");
      if (value === null) return null;
      if (value !== undefined) overrides[field] = value;
    }
    for (const field of ENDPOINT_PRICES) {
      const value = parsePrice(manual?.[field] ?? "");
      if (value === null) return null;
      if (value !== undefined) {
        overrides.prices ??= {};
        overrides.prices[field] = value;
      }
    }
    for (const field of ENDPOINT_ATTACHMENTS) {
      const value = manual?.[field];
      if (value !== undefined) overrides[field] = value;
    }
    if (manual?.api !== undefined) overrides.api = manual.api;
    models.push({
      id,
      ...(label ? { label } : {}),
      ...(discovered ? { discovered } : {}),
      ...(apiCheckedAt ? { apiCheckedAt } : {}),
      ...(manual ? { overrides } : {}),
    });
  }
  return models;
}

/** The automatic test skips manually set and previously discovered attachments, as the server does. */
export function pendingAttachments(model: EndpointModel, force = false): EndpointAttachment[] {
  if (!force && (!model.check || model.check === "failed")) return [];
  return ENDPOINT_ATTACHMENTS.filter((field) =>
    shouldProbeAttachment(model.discovered?.[field], model.overrides?.[field], force),
  );
}

export function attachmentValue(model: EndpointModel, field: EndpointAttachment): boolean | undefined {
  return model.overrides?.[field] ?? model.discovered?.[field]?.value;
}

export function attachmentLabel(value: boolean | undefined) {
  if (value === undefined) return "endpoint.capabilities.unknown";
  return value ? "endpoint.capabilities.yes" : "endpoint.capabilities.no";
}

/** The address as the person typed it is worth sending: http(s), with a host. */
export function endpointAddressLooksValid(raw: string): boolean {
  try {
    const url = new URL(raw.trim());
    return (url.protocol === "https:" || url.protocol === "http:") && url.hostname.length > 0;
  } catch {
    return false;
  }
}

/** Ready to save: a name, an address and at least one model with fine prices. */
export const endpointReady = (draft: EndpointDraft) =>
  draft.name.trim().length > 0 && endpointAddressLooksValid(draft.baseURL) && endpointModelsOf(draft) !== null;

/** A saved endpoint back in the form (changing its models and prices). */
export function draftOfEndpoint(
  label: string,
  endpoint: { style: EndpointStyle; listingStyle?: EndpointStyle; baseURL: string; models: EndpointModel[] },
): EndpointDraft {
  return {
    name: label,
    style: endpoint.style,
    listingStyle: endpoint.listingStyle,
    baseURL: endpoint.baseURL,
    apiKey: "",
    models: endpoint.models.map(({ id, label, prices, overrides, discovered, apiCheckedAt }) => {
      const { prices: manualPrices, ...manual } = overrides ?? {};
      const numericPrices = { ...prices, ...manualPrices };
      const typed: NonNullable<EndpointModelDraft["manual"]> = {};
      for (const field of ENDPOINT_PRICES) {
        const value = numericPrices[field];
        if (value !== undefined) typed[field] = String(value);
      }
      for (const field of ENDPOINT_LIMITS) {
        const value = manual[field];
        if (value !== undefined) typed[field] = String(value);
      }
      return {
        id,
        label,
        discovered,
        apiCheckedAt,
        on: true,
        manual: { ...typed, image: manual.image, pdf: manual.pdf, api: manual.api },
      };
    }),
  };
}

/** What a test result says, as a message key, and how it reads (good, a warning, a failure). */
export const CHECK_VIEW = {
  ok: { key: "endpoint.check.ok", tone: "ok" },
  no_tools: { key: "endpoint.check.noTools", tone: "warn" },
  failed: { key: "endpoint.check.failed", tone: "error" },
} as const satisfies Record<EndpointCheckResult, { key: string; tone: "ok" | "warn" | "error" }>;

/** The results in the form's model order; a model with none yet is left out. */
export const checksInOrder = (draft: Pick<EndpointDraft, "models">, checks: readonly EndpointCheck[]) =>
  draft.models.flatMap((m) => checks.filter((c) => c.model === m.id));

/** A saved endpoint key with its models' tests just run written in, as the server keeps them (`keyThinks` reads them). */
export function withChecks<K extends { endpoint?: { models: EndpointModel[] } }>(
  key: K,
  checks: readonly EndpointCheck[],
): K {
  if (!key.endpoint) return key;
  const models = key.endpoint.models.map((m) => {
    const check = checks.find((c) => c.model === m.id)?.check;
    return check ? { ...m, check } : m;
  });
  return { ...key, endpoint: { ...key.endpoint, models } };
}

/** An endpoint's model list longer than this gets a search field over it. */
export const ENDPOINT_SEARCH_FROM = 12;

/**
 * The form's models a search shows: the ones ticked when its words last changed first, whatever is typed, then the
 * others whose id has the words. `pinned` is taken when the words change, never on a tick: a row never moves under the
 * pointer.
 */
export function modelsShown<M extends { id: string }>(
  models: readonly M[],
  query: string,
  pinned: ReadonlySet<string>,
) {
  const q = query.trim().toLocaleLowerCase();
  return [
    ...models.filter((m) => pinned.has(m.id)),
    ...models.filter((m) => !pinned.has(m.id) && m.id.toLocaleLowerCase().includes(q)),
  ];
}

/** Whether an agent's model is an endpoint's without prices: its budget then can't count its spend. */
export const modelUnpriced = (models: readonly { id: string; unpriced?: boolean }[] | undefined, model: string) =>
  models?.find((m) => m.id === model)?.unpriced === true;
