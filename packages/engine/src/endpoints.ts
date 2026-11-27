import { randomInt } from "node:crypto";
import { OutboundAddressError } from "@agenteschat/adapters";
import { and, type Database, type Executor, eq, isNull, schema } from "@agenteschat/db";
import {
  customModelId,
  ENDPOINT_STYLES,
  type EndpointStyle,
  listEndpointModels,
  type ModelInfo,
  mergeEndpointDiscovery,
  normalizeEndpointDiscovery,
  ProviderError,
  parseCustomModel,
  setCustomModels,
  shouldProbeAttachment,
  type ToolSpec,
} from "@agenteschat/providers";
import { recordAudit } from "./audit";
import { caches } from "./cache";
import { enrichEndpointModel, loadEndpointCatalog } from "./endpoint-catalog";
import { probeImage, probePdf } from "./endpoint-probe-assets";
import { NotFoundError, ValidationError } from "./errors";
import type { ModelGateway } from "./gateway";
import { assertPublicHttpsUrl, internalAddress, publicHttpsFetch, type ResolveHost } from "./net-guard";
import { requirePermission } from "./organizations";
import { isAgentesCloud } from "./telemetry";
import { redactCredentials } from "./tool-detail";

/**
 * A workspace's own model endpoint (ADR 0146): an OpenAI- or Anthropic-compatible server (a gateway, Ollama, vLLM,
 * LM Studio, LiteLLM), kept as a `custom` credential whose options hold its address, API style and the models an
 * admin chose, each with optional prices. Its models are `custom:<credentialId>:<model>`, offered only to its
 * workspace.
 */
export type StoredEndpoint = schema.StoredEndpoint;
export type EndpointModel = StoredEndpoint["models"][number];
export type EndpointCheck = { model: string; check: NonNullable<EndpointModel["check"]>; error?: string };

/** How this server reaches endpoints people type. */
export interface EndpointNet {
  /** Addresses on this server's network and http allowed (`MODEL_ENDPOINTS_PRIVATE`). */
  allowPrivate: boolean;
  /** Outbound HTTP (tests: a fake); absent: plain `fetch` when private addresses are allowed, else the guarded one. */
  fetch?: typeof fetch;
  resolveHost?: ResolveHost;
}

export const MAX_ENDPOINT_MODELS = 100;
const MODEL_ID = /^[\w.:/@+-]{1,200}$/;
/** What a key-less server (a local Ollama) is sent: the SDKs need some key. */
export const ENDPOINT_NO_KEY = "none";

/**
 * Whether this server lets endpoints be private or http: `MODEL_ENDPOINTS_PRIVATE`, else everywhere but the Cloud and
 * a server open to anyone's sign-up (`ALLOW_SIGNUP`), where a stranger's workspace would reach this server's network.
 */
export const allowsPrivateEndpoints = (config: {
  MODEL_ENDPOINTS_PRIVATE?: boolean;
  PUBLIC_URL: string;
  ALLOW_SIGNUP?: boolean;
}) => config.MODEL_ENDPOINTS_PRIVATE ?? (!isAgentesCloud(config.PUBLIC_URL) && !config.ALLOW_SIGNUP);

/** The fetch endpoint calls go through: private addresses allowed or not, every request checked at connect time. */
export const endpointFetch = (net: EndpointNet): typeof fetch =>
  net.fetch ?? (net.allowPrivate ? fetch : publicHttpsFetch());

/**
 * The checks every endpoint address goes through before it is used: without `allowPrivate`, https only and every
 * address the host resolves to public (`assertPublicHttpsUrl`). The address is returned as typed (trimmed), which is
 * what a full decision URL needs; `endpointAddress` normalizes it for the chat SDKs afterwards.
 */
export async function validatedEndpointUrl(raw: string, net: EndpointNet): Promise<string> {
  const address = raw.trim();
  if (net.allowPrivate) {
    let url: URL;
    try {
      url = new URL(address);
    } catch {
      throw new ValidationError("Invalid address", "url.invalid");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:")
      throw new ValidationError("Use an https:// or http:// address", "url.invalid");
    if (url.username || url.password)
      throw new ValidationError("The address can't have a user or password", "url.credentials");
  } else await assertPublicHttpsUrl(address, net.resolveHost);
  return address;
}

/**
 * An endpoint's address as its API's SDK takes it: no query, no trailing slash, and the path the SDK adds left out
 * (`/chat/completions`; `/v1` or `/v1/messages` for Anthropic's). The same checks as `validatedEndpointUrl` run first;
 * each call is checked again when it connects.
 */
export async function endpointAddress(raw: string, style: EndpointStyle, net: EndpointNet): Promise<string> {
  if (!ENDPOINT_STYLES.includes(style)) throw new ValidationError("Pick the API the server speaks", "endpoint.style");
  const address = await validatedEndpointUrl(raw, net);
  const url = new URL(address);
  const path = url.pathname.replace(/\/+$/, "");
  const base =
    style === "anthropic" ? path.replace(/\/v1(\/messages)?$/, "") : path.replace(/\/chat\/completions$/, "");
  return `${url.origin}${base}`;
}

type EndpointPrices = NonNullable<EndpointModel["prices"]>;
type EndpointOverrides = NonNullable<EndpointModel["overrides"]>;

function validateEndpointPrices(prices?: Partial<EndpointPrices>) {
  if (prices && Object.values(prices).some((v) => !Number.isSafeInteger(v) || v < 0))
    throw new ValidationError("Prices must be nonnegative", "endpoint.prices");
}

function validateEndpointLimits({ contextWindow, maxOutputTokens }: EndpointOverrides) {
  if ([contextWindow, maxOutputTokens].some((v) => v !== undefined && (!Number.isSafeInteger(v) || v <= 0)))
    throw new ValidationError("Token limits must be positive integers", "endpoint.limits");
}

/** Validates the selected models and carries forward metadata omitted by older clients. */
export function cleanEndpointModels(models: EndpointModel[], previous: EndpointModel[] = []): EndpointModel[] {
  if (models.length === 0) throw new ValidationError("Choose at least one model", "endpoint.no_models");
  if (models.length > MAX_ENDPOINT_MODELS)
    throw new ValidationError(`At most ${MAX_ENDPOINT_MODELS} models`, "endpoint.too_many_models");
  const seen = new Set<string>();
  return models.map((m) => {
    const id = m.id.trim();
    if (!MODEL_ID.test(id)) throw new ValidationError(`"${id}" doesn't look like a model id`, "endpoint.model_id");
    if (seen.has(id)) throw new ValidationError(`${id} is listed twice`, "endpoint.model_id");
    seen.add(id);
    const label = m.label?.trim().slice(0, 120);
    const before = previous.find((o) => o.id === id);
    const overrides = m.overrides ?? before?.overrides;
    const discovered = mergeEndpointDiscovery(before?.discovered, m.discovered);
    validateEndpointPrices(m.prices);
    if (overrides) {
      validateEndpointLimits(overrides);
      validateEndpointPrices(overrides.prices);
    }
    if (discovered) {
      validateEndpointLimits({
        contextWindow: discovered.contextWindow?.value,
        maxOutputTokens: discovered.maxOutputTokens?.value,
      });
      validateEndpointPrices(
        Object.fromEntries(
          (["input", "output", "cacheRead", "cacheWrite"] as const).flatMap((key) => {
            const field = discovered.prices?.[key];
            return field ? [[key, field.value]] : [];
          }),
        ),
      );
    }
    const {
      id: _id,
      label: _label,
      prices: _prices,
      overrides: _overrides,
      discovered: _discovered,
      check: _check,
      ...storedExtra
    } = before ?? { id };
    const {
      id: _incomingId,
      label: _incomingLabel,
      prices: _incomingPrices,
      overrides: _incomingOverrides,
      discovered: _incomingDiscovered,
      check: _incomingCheck,
      ...incomingExtra
    } = m;
    return {
      ...storedExtra,
      ...incomingExtra,
      id,
      ...(label ? { label } : {}),
      ...(m.prices ? { prices: m.prices } : {}),
      ...(overrides ? { overrides } : {}),
      ...(discovered ? { discovered } : {}),
      ...(before?.check ? { check: before.check } : {}),
    };
  });
}

/** An endpoint model as the gateway and the pickers read it: never a pick for routing, the judge or summaries. */
const infoOf = (endpointName: string, m: EndpointModel): ModelInfo => {
  const { overrides } = m;
  const discovered = normalizeEndpointDiscovery(m.discovered);
  const contextWindow = overrides?.contextWindow ?? discovered?.contextWindow?.value;
  const maxOutputTokens = overrides?.maxOutputTokens ?? discovered?.maxOutputTokens?.value;
  const image = overrides?.image ?? discovered?.image?.value;
  const pdf = overrides?.pdf ?? discovered?.pdf?.value;
  const { input, output, cacheRead, cacheWrite } = {
    ...Object.fromEntries(
      (["input", "output", "cacheRead", "cacheWrite"] as const).flatMap((key) => {
        const field = discovered?.prices?.[key];
        return field ? [[key, field.value]] : [];
      }),
    ),
    ...m.prices,
    ...overrides?.prices,
  };
  const priced = input !== undefined && output !== undefined;
  return {
    provider: "custom",
    label: m.label ?? m.id,
    endpoint: endpointName,
    prices: priced
      ? { input, output, cacheRead: cacheRead ?? input, cacheWrite: cacheWrite ?? input }
      : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...(priced ? {} : { unpriced: true as const }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    ...(image === undefined && pdf === undefined ? {} : { reads: { image, pdf } }),
    serverSideFallback: false,
    structuredOutput: false,
  };
};

/**
 * Puts an organization's endpoint models in memory (`setCustomModels`) from its live `custom` credentials, read like
 * other credential rows (cached 30 s, dropped by `invalidateDefaults` on any key change).
 */
export async function loadEndpointModels(db: Executor, orgId: string) {
  const rows = (await caches.credentials.getOrLoad(`${orgId}:endpoints`, () =>
    db
      .select({
        id: schema.providerCredentials.id,
        label: schema.providerCredentials.label,
        options: schema.providerCredentials.options,
      })
      .from(schema.providerCredentials)
      .where(
        and(
          eq(schema.providerCredentials.orgId, orgId),
          eq(schema.providerCredentials.provider, "custom"),
          isNull(schema.providerCredentials.revokedAt),
        ),
      ),
  )) as { id: string; label: string; options: { endpoint?: StoredEndpoint } }[];
  registerEndpointModels(orgId, rows);
}

function registerEndpointModels(
  orgId: string,
  rows: { id: string; label: string; options: { endpoint?: StoredEndpoint } }[],
) {
  setCustomModels(
    orgId,
    Object.fromEntries(
      rows.flatMap((r) =>
        (r.options.endpoint?.models ?? []).map((m) => [customModelId(r.id, m.id), infoOf(r.label, m)] as const),
      ),
    ),
  );
}

/** Backfill metadata away from the model call path. Compare the row before writing to preserve concurrent edits. */
function needsEndpointCatalog(model: EndpointModel): boolean {
  const discovery = model.discovered;
  if (!discovery || "discoveredAt" in discovery) return true;
  if (
    [
      discovery.contextWindow,
      discovery.maxOutputTokens,
      discovery.image,
      discovery.pdf,
      ...Object.values(discovery.prices ?? {}),
    ].some((field) => field?.source === "catalog")
  )
    return true;
  return (
    !discovery.contextWindow || !discovery.maxOutputTokens || !discovery.prices?.input || !discovery.prices?.output
  );
}

export async function backfillEndpointCatalog(db: Executor, orgId: string, read?: typeof fetch) {
  const { providerCredentials } = schema;
  const where = and(
    eq(providerCredentials.orgId, orgId),
    eq(providerCredentials.provider, "custom"),
    isNull(providerCredentials.revokedAt),
  );
  const rows = await db
    .select({ id: providerCredentials.id, options: providerCredentials.options })
    .from(providerCredentials)
    .where(where);
  const legacy = rows.filter(({ options }) => options.endpoint?.models.some(needsEndpointCatalog));
  if (!legacy.length) return;
  const catalog = await loadEndpointCatalog(read);
  if (!catalog) return;
  for (const { id, options } of legacy) {
    const endpoint = options.endpoint;
    if (!endpoint) continue;
    const models = endpoint.models.map((model) =>
      needsEndpointCatalog(model) ? enrichEndpointModel(model, endpoint.baseURL, catalog) : model,
    );
    if (models.every((model, index) => model === endpoint.models[index])) continue;
    await db
      .update(providerCredentials)
      .set({ options: { ...options, endpoint: { ...endpoint, models } } })
      .where(and(where, eq(providerCredentials.id, id), eq(providerCredentials.options, options)));
    caches.credentials.delete(`${orgId}:${id}`);
    caches.credentials.delete(`${orgId}:endpoints`);
  }
}

/**
 * What an endpoint lists, before anything is stored (admins): its cleaned address and model ids, or the reason it
 * listed none (the admin then types ids by hand). An address this server won't reach is refused.
 */
export async function listEndpoint(
  db: Database,
  actorId: string,
  orgId: string,
  input: { style: EndpointStyle; baseURL: string; apiKey?: string },
  net: EndpointNet,
): Promise<{ baseURL: string; models: EndpointModel[]; error?: string }> {
  await requirePermission(db, actorId, orgId, "manage_credentials");
  const baseURL = await endpointAddress(input.baseURL, input.style, net);
  try {
    const models = await listEndpointModels(
      { style: input.style, baseURL },
      input.apiKey?.trim() || ENDPOINT_NO_KEY,
      endpointFetch(net),
    );
    const catalog = models.length ? await loadEndpointCatalog(net.fetch) : undefined;
    const discoveredAt = new Date().toISOString();
    const source = "endpoint" as const;
    return {
      baseURL,
      models: models
        .map(
          ({ caps, ...model }): EndpointModel =>
            caps
              ? {
                  ...model,
                  discovered: {
                    ...(caps.limits?.contextWindow === undefined
                      ? {}
                      : { contextWindow: { source, value: caps.limits.contextWindow, discoveredAt } }),
                    ...(caps.limits?.maxOutputTokens === undefined
                      ? {}
                      : { maxOutputTokens: { source, value: caps.limits.maxOutputTokens, discoveredAt } }),
                    ...(caps.prices
                      ? {
                          prices: Object.fromEntries(
                            Object.entries(caps.prices)
                              .filter(([, value]) => value !== undefined)
                              .map(([key, value]) => [key, { source, value: Math.round(value * 1000), discoveredAt }]),
                          ),
                        }
                      : {}),
                    ...(caps.image === undefined ? {} : { image: { source, value: caps.image, discoveredAt } }),
                    ...(caps.pdf === undefined ? {} : { pdf: { source, value: caps.pdf, discoveredAt } }),
                  },
                }
              : model,
        )
        .map((model) => (catalog ? enrichEndpointModel(model, baseURL, catalog) : model)),
    };
  } catch (error) {
    if (error instanceof OutboundAddressError) throw internalAddress(new URL(baseURL).hostname);
    return { baseURL, models: [], error: redactCredentials(error instanceof Error ? error.message : String(error)) };
  }
}

/** The tool the test call asks for: agents work through tools, so a model that never calls one can't do their work. */
const CHECK_TOOL: ToolSpec = {
  name: "report_status",
  description: "Report that the connection works.",
  inputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
};
const CHECK_TIMEOUT_MS = 60_000;

/**
 * One small call per model of an endpoint (admins), through the Model Gateway (recorded as a `summary` call with its
 * tokens and cost): `ok` when it called the tool it was asked to, `no_tools` when it answered without, `failed` with
 * the server's words. Each model keeps its last result.
 */
export async function checkEndpoint(
  db: Database,
  gateway: Pick<ModelGateway, "complete">,
  actorId: string,
  orgId: string,
  credentialId: string,
): Promise<EndpointCheck[]> {
  await requirePermission(db, actorId, orgId, "manage_credentials");
  const where = and(
    eq(schema.providerCredentials.id, credentialId),
    eq(schema.providerCredentials.orgId, orgId),
    eq(schema.providerCredentials.provider, "custom"),
    isNull(schema.providerCredentials.revokedAt),
  );
  const [row] = await db.select().from(schema.providerCredentials).where(where);
  const endpoint = row?.options.endpoint;
  if (!row || !endpoint) throw new NotFoundError("Credential not found");
  const results = await Promise.all(
    endpoint.models.map(async (m): Promise<EndpointCheck> => {
      try {
        const r = await gateway.complete({
          orgId,
          kind: "summary",
          model: customModelId(credentialId, m.id),
          system: "You are checking that a connection works.",
          messages: [{ role: "user", content: "Call the report_status tool with ok set to true." }],
          maxTokens: 1024,
          tools: [CHECK_TOOL],
          signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
        });
        return { model: m.id, check: r.content.some((b) => b.type === "tool_use") ? "ok" : "no_tools" };
      } catch (error) {
        return { model: m.id, check: "failed", error: error instanceof Error ? error.message : String(error) };
      }
    }),
  );
  await db.transaction(async (tx) => {
    const [latest] = await tx.select().from(schema.providerCredentials).where(where).for("update");
    const current = latest?.options.endpoint;
    if (!current || latest.secretCiphertext !== row.secretCiphertext) return;
    const models = current.models.map((m) => ({
      ...m,
      check: results.find((r) => r.model === m.id)?.check ?? m.check,
    }));
    await tx
      .update(schema.providerCredentials)
      .set({ options: { ...latest.options, endpoint: { ...current, models } } })
      .where(where);
  });
  caches.credentials.delete(`${orgId}:${credentialId}`);
  caches.credentials.delete(`${orgId}:endpoints`);
  return results;
}

const PROBE_TOOL: ToolSpec = {
  name: "get_attachments",
  description: "Return the attachments to inspect",
  inputSchema: { type: "object", properties: {} },
};
type Attachment = "image" | "pdf";
const ATTACHMENTS: Attachment[] = ["image", "pdf"];

function containsProbeCode(text: string, code: string): boolean {
  const word = (char: string | undefined) =>
    char !== undefined &&
    ((char >= "0" && char <= "9") || (char >= "A" && char <= "Z") || (char >= "a" && char <= "z") || char === "_");
  for (let start = 0; start < text.length; start++) {
    if (text[start] !== code[0] || word(text[start - 1])) continue;
    let at = start + 1;
    let index = 1;
    while (index < code.length) {
      while (text[at] !== undefined && (text[at] === "-" || text[at]?.trim() === "")) at++;
      if (text[at] !== code[index]) break;
      at++;
      index++;
    }
    if (index === code.length && !word(text[at])) return true;
  }
  return false;
}

async function testAttachments(
  gateway: Pick<ModelGateway, "complete">,
  orgId: string,
  model: string,
  types: Attachment[],
): Promise<Partial<Record<Attachment, boolean>>> {
  const codes = { image: String(randomInt(100000, 500000)), pdf: String(randomInt(500000, 999999)) };
  try {
    const response = await gateway.complete({
      orgId,
      kind: "summary",
      model,
      system: "Transcribe the six-digit codes visible in the tool attachments. Return only the codes you can see.",
      messages: [
        { role: "user", content: "Read the codes in the attachments." },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "call_endpoint_probe", name: PROBE_TOOL.name, input: {} }],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              toolUseId: "call_endpoint_probe",
              content: "Read each attachment.",
              images: types.map((type) => (type === "image" ? probeImage(codes.image) : probePdf(codes.pdf))),
            },
          ],
        },
      ],
      endpointReads: Object.fromEntries(types.map((type) => [type, true])),
      tools: [PROBE_TOOL],
      maxTokens: 256,
      signal: AbortSignal.timeout(18_000),
    });
    return Object.fromEntries(
      types.flatMap((type) => (containsProbeCode(response.text, codes[type]) ? [[type, true]] : [])),
    );
  } catch (error) {
    if (!(error instanceof ProviderError) || error.status !== 415) return {};
    if (types.length === 1 && types[0]) return { [types[0]]: false };
    const [image, pdf] = await Promise.all([
      testAttachments(gateway, orgId, model, ["image"]),
      testAttachments(gateway, orgId, model, ["pdf"]),
    ]);
    return { ...image, ...pdf };
  }
}

export async function probeEndpoint(
  db: Database,
  gateway: Pick<ModelGateway, "complete">,
  actorId: string,
  orgId: string,
  credentialId: string,
  input: { models?: string[]; force?: boolean },
): Promise<EndpointModel[]> {
  await requirePermission(db, actorId, orgId, "manage_credentials");
  const where = and(
    eq(schema.providerCredentials.id, credentialId),
    eq(schema.providerCredentials.orgId, orgId),
    eq(schema.providerCredentials.provider, "custom"),
    isNull(schema.providerCredentials.revokedAt),
  );
  const [row] = await db.select().from(schema.providerCredentials).where(where);
  const endpoint = row?.options.endpoint;
  if (!endpoint) throw new NotFoundError("Credential not found");
  const selected = input.models ? new Set(input.models) : undefined;
  const jobs = endpoint.models.flatMap((model) => {
    if (selected && !selected.has(model.id)) return [];
    if (!input.force && (!model.check || model.check === "failed")) return [];
    const types = ATTACHMENTS.filter((type) =>
      shouldProbeAttachment(model.discovered?.[type], model.overrides?.[type], input.force),
    );
    return types.length ? [{ model, types }] : [];
  });
  if (!jobs.length) return endpoint.models;
  const results = new Map<string, Partial<Record<Attachment, boolean>>>();
  await Promise.all(
    Array.from({ length: Math.min(4, jobs.length) }, async () => {
      for (let job = jobs.shift(); job; job = jobs.shift()) {
        results.set(
          job.model.id,
          await testAttachments(gateway, orgId, customModelId(credentialId, job.model.id), job.types),
        );
      }
    }),
  );
  const models = await db.transaction(async (tx) => {
    const [latest] = await tx.select().from(schema.providerCredentials).where(where).for("update");
    const current = latest?.options.endpoint;
    if (!current) throw new NotFoundError("Credential not found");
    if (
      latest.secretCiphertext !== row.secretCiphertext ||
      current.baseURL !== endpoint.baseURL ||
      current.style !== endpoint.style
    )
      return current.models;
    const discoveredAt = new Date().toISOString();
    const source = "probe" as const;
    const updated = current.models.map((model) => {
      const result = results.get(model.id);
      if (result?.image === undefined && result?.pdf === undefined) return model;
      const image =
        result.image !== undefined &&
        model.overrides?.image === undefined &&
        model.discovered?.image?.source !== "endpoint";
      const pdf =
        result.pdf !== undefined && model.overrides?.pdf === undefined && model.discovered?.pdf?.source !== "endpoint";
      if (!image && !pdf) return model;
      return {
        ...model,
        discovered: mergeEndpointDiscovery(model.discovered, {
          ...(image ? { image: { source, value: result.image as boolean, discoveredAt } } : {}),
          ...(pdf ? { pdf: { source, value: result.pdf as boolean, discoveredAt } } : {}),
        }),
      };
    });
    await tx
      .update(schema.providerCredentials)
      .set({ options: { ...latest.options, endpoint: { ...current, models: updated } } })
      .where(where);
    return updated;
  });
  caches.credentials.delete(`${orgId}:${credentialId}`);
  caches.credentials.delete(`${orgId}:endpoints`);
  return models;
}

/** Changes which models an endpoint offers and their prices (admins); checks are run again by the caller. */
export async function updateEndpointModels(
  db: Database,
  actorId: string,
  orgId: string,
  credentialId: string,
  models: EndpointModel[],
) {
  await requirePermission(db, actorId, orgId, "manage_credentials");
  const where = and(
    eq(schema.providerCredentials.id, credentialId),
    eq(schema.providerCredentials.orgId, orgId),
    eq(schema.providerCredentials.provider, "custom"),
    isNull(schema.providerCredentials.revokedAt),
  );
  const { row, next } = await db.transaction(async (tx) => {
    const [row] = await tx.select().from(schema.providerCredentials).where(where).for("update");
    const endpoint = row?.options.endpoint;
    if (!row || !endpoint) throw new NotFoundError("Credential not found");
    const next = { ...endpoint, models: cleanEndpointModels(models, endpoint.models) };
    await tx
      .update(schema.providerCredentials)
      .set({ options: { ...row.options, endpoint: next } })
      .where(where);
    return { row, next };
  });
  await recordAudit(db, {
    orgId,
    actor: { type: "person", id: actorId },
    action: "credential.models_changed",
    target: { type: "credential", id: credentialId },
    details: { provider: "custom", label: row.label, models: next.models.map((m) => m.id) },
  });
  caches.credentials.delete(`${orgId}:${credentialId}`);
  caches.credentials.delete(`${orgId}:endpoints`);
  return next;
}

/** The organizations of `userId` that have a live endpoint: whose models `GET /models` adds for them. */
export async function endpointOrgsOf(db: Executor, userId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ orgId: schema.providerCredentials.orgId })
    .from(schema.providerCredentials)
    .innerJoin(
      schema.organizationMembers,
      and(
        eq(schema.organizationMembers.orgId, schema.providerCredentials.orgId),
        eq(schema.organizationMembers.userId, userId),
      ),
    )
    .where(and(eq(schema.providerCredentials.provider, "custom"), isNull(schema.providerCredentials.revokedAt)));
  return rows.map((r) => r.orgId);
}

/** Prices as people type them (US dollars per million tokens) in nano-USD per token; a cache price absent is the input's. */
export function endpointPricesFromUsd(p: { input: number; output: number; cacheRead?: number; cacheWrite?: number }) {
  const nano = (usd: number) => Math.round(usd * 1000);
  return {
    input: nano(p.input),
    output: nano(p.output),
    cacheRead: nano(p.cacheRead ?? p.input),
    cacheWrite: nano(p.cacheWrite ?? p.input),
  };
}

/** Nano-USD per token back in US dollars per million tokens. */
export const endpointPricesToUsd = (p: NonNullable<EndpointModel["prices"]>) => ({
  input: p.input / 1000,
  output: p.output / 1000,
  cacheRead: p.cacheRead / 1000,
  cacheWrite: p.cacheWrite / 1000,
});

/** What the pickers add for an endpoint's model (ADR 0146): whose credential, its name, and whether it has prices. */
export function pickerEndpoint(id: string, info: ModelInfo) {
  const credentialId = parseCustomModel(id)?.credentialId;
  if (!credentialId) return {};
  return {
    endpoint: { credentialId, name: info.endpoint ?? "" },
    ...(info.unpriced ? { unpriced: true } : {}),
  };
}
