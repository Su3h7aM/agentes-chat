import { decisionEndpointFromBase } from "@agenteschat/providers/decision-endpoint";
import type { Credential, DecisionSettings } from "../api/types";
import { CUSTOM_PROVIDER } from "./endpoints";

export { decisionEndpointFromBase };

/** How a workspace decides: the installation's Jev, an existing OpenRouter key, or an existing custom endpoint. */
export type DecisionMode = "jev" | "openrouter" | "custom";

/** The mode a credential can serve, or null for a provider that has no decision route. */
export const decisionProviderOf = (
  credential: Pick<Credential, "provider"> | null | undefined,
): Exclude<DecisionMode, "jev"> | null =>
  credential?.provider === "openrouter" ? "openrouter" : credential?.provider === CUSTOM_PROVIDER ? "custom" : null;

/** A live key this workspace may choose for decisions: an OpenRouter key or any custom chat endpoint. */
export const isDecisionCredential = (credential: Credential): boolean =>
  !credential.revokedAt && decisionProviderOf(credential) !== null;

/** The rows the decision picker shows: live eligible keys, once per saved key (a copy's `copyOf` row stays out). */
export const decisionCredentials = (credentials: readonly Credential[]): Credential[] =>
  credentials.filter((credential) => isDecisionCredential(credential) && !credential.copyOf);

/** The row a list shows for an id: a copy's `copyOf` row stands for both. */
export const credentialRowOf = <C extends Pick<Credential, "id" | "copyOf">>(
  credentials: readonly C[],
  id: string | null | undefined,
): C | undefined => {
  const row = id ? credentials.find((credential) => credential.id === id) : undefined;
  return row?.copyOf ? (credentials.find((credential) => credential.id === row.copyOf) ?? row) : row;
};

/**
 * The mode saved settings are in, for the UI's three choices. A revoked key that is still listed keeps
 * its mode so the UI can show it unavailable; null means the named key is unknown (removed). No
 * settings means the installation's Jev.
 */
export const decisionModeOf = (
  settings: DecisionSettings | null,
  credentials: readonly Credential[],
): DecisionMode | null => {
  if (!settings) return "jev";
  return decisionProviderOf(credentialRowOf(credentials, settings.credentialId));
};

/**
 * Where a custom credential's decision calls go: the saved full URL, else the address derived from
 * its chat endpoint base. Null for a credential with neither.
 */
export const decisionEndpointOf = (
  credential: Pick<Credential, "endpoint"> | null | undefined,
  endpoint?: string,
): string | null => {
  const override = endpoint?.trim();
  if (override) return override;
  const base = credential?.endpoint?.baseURL;
  return base ? decisionEndpointFromBase(base) : null;
};

/** The editable decision form; model ids and an endpoint stay exactly as typed until saved. */
export interface DecisionDraft {
  credentialId: string;
  model: string;
  visionModel: string;
  /** Empty: derive it from the custom credential's endpoint base. */
  endpoint: string;
}

export const decisionDraftOf = (settings: DecisionSettings | null): DecisionDraft => ({
  credentialId: settings?.credentialId ?? "",
  model: settings?.model ?? "",
  visionModel: settings?.visionModel ?? "",
  endpoint: settings?.endpoint ?? "",
});

/** Any non-empty id without whitespace, as the server takes OpenRouter's namespaced ids and a release id. */
export const decisionModelIdValid = (value: string): boolean => {
  const id = value.trim();
  return id.length > 0 && id.length <= 200 && !/\s/.test(id);
};

/**
 * The API input; null for Jev, a missing account/model, or an invalid model id. A custom endpoint
 * travels only in custom mode: a draft that still holds one after switching to OpenRouter never
 * sends it.
 */
export const decisionInputOf = (draft: DecisionDraft, mode: DecisionMode): DecisionSettings | null => {
  if (mode === "jev") return null;
  const credentialId = draft.credentialId.trim();
  const model = draft.model.trim();
  const visionModel = draft.visionModel.trim() || null;
  const endpoint = mode === "custom" ? draft.endpoint.trim() : "";
  if (!credentialId || !decisionModelIdValid(model) || (visionModel !== null && !decisionModelIdValid(visionModel)))
    return null;
  return { credentialId, model, visionModel, ...(endpoint ? { endpoint } : {}) };
};
