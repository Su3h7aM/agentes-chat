import type { KeyWrapper } from "@agenteschat/adapters";
import { and, type Database, type Executor, eq, isNull, schema } from "@agenteschat/db";
import { decisionEndpointFromBase } from "@agenteschat/providers";
import { recordAudit } from "./audit";
import { type DecryptedCredential, decryptCredential, decryptCredentialRow, lockCredential } from "./credentials";
import { type EndpointNet, endpointFetch, validatedEndpointUrl } from "./endpoints";
import { ValidationError } from "./errors";
import type { ModelGateway } from "./gateway";
import type { JevTarget, JevTransport } from "./jev-key";
import { createJevJudge, type Judge, type JudgeQuestion, judgeName, withJudgeFallback } from "./judge";
import { requirePermission } from "./organizations";
import { assertCanWork } from "./standing";

export interface DecisionSettings {
  credentialId: string;
  model: string;
  /** Null: this workspace sends no images or Box questions. */
  visionModel: string | null;
  /** A custom endpoint's full decision URL, used exactly; absent derives it from the endpoint base. */
  endpoint?: string;
}

export interface DecisionSettingsView {
  settings: DecisionSettings | null;
  /** The chosen credential still exists, is live, and can reach a decision route. */
  available: boolean;
}

/** Any non-empty model id without whitespace: OpenRouter namespaced ids, a release, or a custom endpoint's id. */
export const DECISION_MODEL_ID = /^\S{1,200}$/;

/** A synthetic 280 x 280 white PNG, within the vision service's minimum image size. */
const VISION_PROBE =
  "iVBORw0KGgoAAAANSUhEUgAAARgAAAEYAQAAAACv9dQhAAAAN0lEQVRo3u3KMQEAAAwCIPuX1ggLMLhJb3Ecx3Ecx3Ecx3Ecx3Ecx3Ecx3Ecx3Ecx3Ecx3GcZ2f9LSPziZSvhgAAAABJRU5ErkJggg==";

/** A probe step that got an answer, but not the one a decision model must give (the probe's own check). */
class DecisionProbeError extends Error {
  constructor(readonly code: "decision_check_format" | "decision_check_vision") {
    super(code);
  }
}

/**
 * Why the probe refused a candidate, named by where the failure happened: this server, the endpoint, or its answer.
 * A call that failed carries its HTTP status and state (`callJev`); one that got a 2xx but no usable answer does not.
 */
function probeCodeOf(error: unknown): string {
  if (error instanceof DecisionProbeError) return error.code;
  const call = error as { status?: unknown; state?: unknown } | null;
  if (typeof call?.status !== "number") return "decision_check_format";
  const status = call.status;
  if (status === 0) return call.state === null ? "decision_check_timeout" : "decision_check_unreachable";
  if (call.state === "no_credit") return "decision_check_no_credit";
  if (status === 401 || status === 403) return "decision_check_refused";
  if (status === 404) return "decision_check_no_route";
  if (status === 429) return "decision_check_rate_limited";
  if (status >= 500) return "decision_check_endpoint_error";
  if (status >= 200 && status < 300) return "decision_check_format";
  return "decision_check_request_refused";
}

/** What the workspace is told for each refusal: one direction to look, never the endpoint's own error text. */
const PROBE_REFUSALS: Record<string, string> = {
  decision_check_unreachable:
    "This server could not reach the address. Check the address and that the endpoint is online.",
  decision_check_timeout: "The endpoint did not answer in time. Check that it answers quickly, then try again.",
  decision_check_refused: "The endpoint refused this account's key. Check the key under Provider keys.",
  decision_check_no_credit: "This account has no credit left at the endpoint.",
  decision_check_no_route: "The endpoint has no decision route at this address. Check the address.",
  decision_check_rate_limited: "The endpoint is limiting requests right now. Try again in a moment.",
  decision_check_endpoint_error: "The endpoint failed on its side. Try again later.",
  decision_check_request_refused: "The endpoint refused the request. Check the model ID.",
  decision_check_format:
    "The endpoint answered, but not in the decision format. Its decision route must answer in that format.",
  decision_check_vision:
    "The endpoint answered the text question but gave no box for the image. Choose a vision model that accepts images, or none.",
};
/** A refusal no step above names: the probe failed, and nothing more is known. */
const PROBE_REFUSED_OTHERWISE = "The decision service could not verify this model. Try again.";

export async function decisionSettings(db: Database, orgId: string): Promise<DecisionSettings | null> {
  const [row] = await db
    .select({ decisions: schema.organizationSettings.decisions })
    .from(schema.organizationSettings)
    .where(eq(schema.organizationSettings.orgId, orgId));
  if (!row?.decisions) return null;
  return cleanSavedSettings(row.decisions);
}

/** Stored settings as callers see them: an empty or absent override is absent, and vision is explicit. */
function cleanSavedSettings(settings: DecisionSettings): DecisionSettings {
  const endpoint = settings.endpoint?.trim();
  return {
    credentialId: settings.credentialId,
    model: settings.model,
    visionModel: settings.visionModel ?? null,
    ...(endpoint ? { endpoint } : {}),
  };
}

type CredentialRow = typeof schema.providerCredentials.$inferSelect;

/** The live row, read fresh: a decision target and a probe must describe the credential as it is now. */
async function activeCredentialRow(db: Executor, orgId: string, credentialId: string) {
  const [row] = await db
    .select()
    .from(schema.providerCredentials)
    .where(
      and(
        eq(schema.providerCredentials.orgId, orgId),
        eq(schema.providerCredentials.id, credentialId),
        isNull(schema.providerCredentials.revokedAt),
      ),
    );
  return row ?? null;
}

/** What the probe actually tested: a rotated key, changed endpoint or revocation makes this differ. */
const credentialStamp = (row: CredentialRow) =>
  JSON.stringify([
    row.provider,
    row.secretCiphertext,
    row.wrappedDataKey,
    row.kekId,
    row.workspaceId ?? null,
    row.options ?? null,
    row.revokedAt?.toISOString() ?? null,
  ]);

export async function decisionSettingsView(
  db: Database,
  orgId: string,
  keyWrappers: KeyWrapper[],
): Promise<DecisionSettingsView> {
  const settings = await decisionSettings(db, orgId);
  if (!settings) return { settings: null, available: false };
  const credential = await decryptCredential(db, keyWrappers, orgId, settings.credentialId).catch(() => null);
  if (!credential) return { settings, available: false };
  const available =
    credential.provider === "openrouter" ||
    (credential.provider === "custom" && Boolean(settings.endpoint ?? credential.options?.endpoint?.baseURL));
  return { settings, available };
}

/** The model id and vision model a workspace saved, normalized; an invalid saved value is refused before any call. */
function cleanSettings(input: DecisionSettings): DecisionSettings {
  const model = input.model.trim();
  const vision = input.visionModel?.trim() || null;
  const endpoint = input.endpoint?.trim() || undefined;
  if (!DECISION_MODEL_ID.test(model))
    throw new ValidationError("Choose a valid decision model ID.", "decision_model_invalid");
  if (vision !== null && !DECISION_MODEL_ID.test(vision))
    throw new ValidationError("Choose a valid vision model ID.", "decision_model_invalid");
  return { credentialId: input.credentialId, model, visionModel: vision, ...(endpoint ? { endpoint } : {}) };
}

/**
 * How an existing credential reaches a decision route. OpenRouter has its own fixed route; a custom
 * credential is a chat endpoint whose base names the same service, and its decision URL is derived
 * unless the workspace saved a complete one. Any other provider is not a decision account.
 */
function destinationOf(
  settings: DecisionSettings,
  credential: DecryptedCredential,
  net: EndpointNet,
): { transport: JevTransport; baseURL?: string; fetch?: typeof fetch } | null {
  if (credential.provider === "openrouter") return { transport: "openrouter" };
  if (credential.provider !== "custom") return null;
  const baseURL =
    settings.endpoint?.trim() ||
    (credential.options?.endpoint?.baseURL ? decisionEndpointFromBase(credential.options.endpoint.baseURL) : undefined);
  if (!baseURL) return null;
  return { transport: "systemone", baseURL, fetch: endpointFetch(net) };
}

export function createWorkspaceDecisions(deps: {
  db: Database;
  keyWrappers: KeyWrapper[];
  gateway: Pick<ModelGateway, "recordExternalUsage">;
  /** Outbound HTTP for decision calls (tests: a fake). */
  fetch?: typeof fetch;
  /** How a custom endpoint may be reached (private networks, guarded DNS). */
  net?: EndpointNet;
  timeoutMs: number;
  visionTimeoutMs?: number;
}) {
  const net = () => deps.net ?? { allowPrivate: false };

  const targetFor = async (orgId: string, settings: DecisionSettings): Promise<JevTarget> => {
    const broken: JevTarget = { key: "", credentialId: settings.credentialId };
    const row = await activeCredentialRow(deps.db, orgId, settings.credentialId);
    if (!row) return broken;
    const credential = await decryptCredentialRow(deps.keyWrappers, row).catch(() => null);
    if (!credential) return broken;
    const destination = destinationOf(settings, credential, net());
    if (!destination) return broken;
    return {
      key: credential.apiKey,
      transport: destination.transport,
      ...(destination.baseURL ? { baseURL: destination.baseURL } : {}),
      fetch: deps.fetch ?? destination.fetch,
      timeoutMs: deps.timeoutMs,
      model: settings.model,
      visionModel: settings.visionModel,
      credentialId: settings.credentialId,
    };
  };

  const target = async (orgId: string): Promise<JevTarget | null> => {
    const settings = await decisionSettings(deps.db, orgId);
    return settings ? targetFor(orgId, settings) : null;
  };

  const probe = async (
    orgId: string,
    settings: DecisionSettings,
    credential: Pick<DecryptedCredential, "apiKey">,
    destination: { transport: JevTransport; baseURL?: string; fetch?: typeof fetch },
  ) => {
    const judge = createJevJudge({
      key: credential.apiKey,
      fetch: deps.fetch ?? destination.fetch,
      baseURL: destination.baseURL,
      transport: destination.transport,
      model: settings.model,
      visionModel: settings.visionModel ?? undefined,
      credentialId: settings.credentialId,
      gateway: deps.gateway,
      timeoutMs: Math.max(5000, deps.timeoutMs),
      visionTimeoutMs: Math.max(6000, deps.visionTimeoutMs ?? 0),
    });
    const questions = {
      ok: {
        type: "noul",
        instructions: "Is the state ok?",
        criteria: { true: "The state is ok.", false: "The state is something else." },
      },
      pick: { type: "choice", instructions: "Choose the state.", criteria: { ok: "ok", other: "Other" } },
      level: {
        type: "score",
        instructions: "How well does the state match ok?",
        criteria: ["Does not match", "Matches"],
      },
    } satisfies Record<string, JudgeQuestion>;
    const text = await judge.ask({ orgId, kind: "decision_probe", state: { state: "ok" }, questions });
    if (text.pick?.choice !== "ok") throw new DecisionProbeError("decision_check_format");
    if (settings.visionModel === null) return;
    const vision = await judge
      .ask({
        orgId,
        kind: "decision_probe_vision",
        state: { image: "probe" },
        images: { probe: { data: VISION_PROBE, format: "png" } },
        questions: { target: { type: "box", instructions: "the entire white image" } },
      })
      // An answer that isn't a box is the image question's refusal, not the text one's (a call that failed keeps its own).
      .catch((error: unknown) => {
        throw probeCodeOf(error) === "decision_check_format" ? new DecisionProbeError("decision_check_vision") : error;
      });
    if (!vision.target?.box) throw new DecisionProbeError("decision_check_vision");
  };

  return {
    target,
    view: (orgId: string) => decisionSettingsView(deps.db, orgId, deps.keyWrappers),
    async vision(orgId: string) {
      const view = await decisionSettingsView(deps.db, orgId, deps.keyWrappers);
      return view.settings ? view.available && view.settings.visionModel !== null : null;
    },
    judge(fallback: Judge, llm: Judge): Judge {
      return {
        get name() {
          return fallback.name;
        },
        async nameFor(orgId) {
          const view = await decisionSettingsView(deps.db, orgId, deps.keyWrappers);
          if (!view.settings) return judgeName(fallback, orgId);
          return view.available ? "jev" : judgeName(llm, orgId);
        },
        async ask(request) {
          const resolved = await target(request.orgId);
          if (!resolved) return fallback.ask(request);
          if (typeof resolved.key === "string" && !resolved.key) return llm.ask(request);
          const wantsImages =
            Object.keys(request.images ?? {}).length > 0 ||
            Object.values(request.questions).some((q) => q.type === "box");
          if (wantsImages && resolved.visionModel === null) throw new Error("judge: no vision decision model selected");
          const primary = createJevJudge({
            key: resolved.key,
            transport: resolved.transport,
            baseURL: resolved.baseURL,
            model: resolved.model,
            visionModel: resolved.visionModel ?? undefined,
            credentialId: resolved.credentialId,
            gateway: deps.gateway,
            fetch: resolved.fetch,
            timeoutMs: deps.timeoutMs,
            visionTimeoutMs: deps.visionTimeoutMs,
          });
          return withJudgeFallback(primary, llm).ask(request);
        },
      };
    },
    async save(orgId: string, actorId: string, input: DecisionSettings | null): Promise<DecisionSettingsView> {
      await requirePermission(deps.db, actorId, orgId, "manage_credentials");
      const settings = input ? cleanSettings(input) : null;
      let probedStamp: string | null = null;
      if (settings) {
        await assertCanWork(deps.db, orgId);
        const row = await activeCredentialRow(deps.db, orgId, settings.credentialId);
        if (!row)
          throw new ValidationError(
            "Choose an active decision account from this workspace.",
            "decision_account_invalid",
          );
        const credential = await decryptCredentialRow(deps.keyWrappers, row).catch(() => null);
        if (!credential) throw new ValidationError("This decision account is unavailable.", "decision_account_invalid");
        if (credential.provider === "openrouter" && settings.endpoint)
          throw new ValidationError(
            "OpenRouter decides at its own route. Remove the address to use this key.",
            "decision_endpoint_unsupported",
          );
        if (credential.provider === "custom" && settings.endpoint)
          settings.endpoint = await validatedEndpointUrl(settings.endpoint, net());
        const destination = destinationOf(settings, credential, net());
        if (!destination)
          throw new ValidationError("This decision account is unavailable.", "decision_account_invalid");
        probedStamp = credentialStamp(row);
        try {
          await probe(orgId, settings, credential, destination);
        } catch (error) {
          const code = probeCodeOf(error);
          throw new ValidationError(PROBE_REFUSALS[code] ?? PROBE_REFUSED_OTHERWISE, code);
        }
      }
      await deps.db.transaction(async (tx) => {
        if (settings) {
          // A probe bills a model call: a hold or suspension set while it ran still keeps the setting from landing.
          await assertCanWork(tx, orgId);
          await lockCredential(tx, orgId, settings.credentialId);
          const current = await activeCredentialRow(tx, orgId, settings.credentialId);
          if (!current) throw new ValidationError("This decision account is unavailable.", "decision_account_invalid");
          if (credentialStamp(current) !== probedStamp)
            throw new ValidationError(
              "The decision account changed while it was being checked. Check it again.",
              "decision_check_failed",
            );
        }
        await tx
          .insert(schema.organizationSettings)
          .values({ orgId, decisions: settings })
          .onConflictDoUpdate({
            target: schema.organizationSettings.orgId,
            set: { decisions: settings, updatedAt: new Date() },
          });
        await recordAudit(tx, {
          orgId,
          actor: { type: "person", id: actorId },
          action: "decisions.changed",
          target: { type: "organization", id: orgId },
          details: settings
            ? {
                credentialId: settings.credentialId,
                model: settings.model,
                visionModel: settings.visionModel,
                ...(settings.endpoint ? { endpoint: settings.endpoint } : {}),
              }
            : { settings: null },
        });
      });
      return decisionSettingsView(deps.db, orgId, deps.keyWrappers);
    },
  };
}

export type WorkspaceDecisions = ReturnType<typeof createWorkspaceDecisions>;
