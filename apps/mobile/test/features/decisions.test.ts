import { describe, expect, test } from "bun:test";
import { decisionEndpointFromBase } from "@agenteschat/client/lib/decisions";
import { translator } from "./fixtures";

const source = (path: string) => Bun.file(new URL(`../../src/${path}`, import.meta.url).pathname).text();

describe("decision models on the phone", () => {
  test("one card offers the same three providers without creating credentials", async () => {
    const screen = await source("features/ai/AiAccountsScreen.tsx");
    const card = await source("features/ai/DecisionSettings.tsx");
    expect(screen).toContain("<DecisionSettingsCard />");
    expect(card).toContain('const allowed = can(org, "manage_credentials")');
    expect(card).toContain("useDecisionSettings(orgId, allowed)");
    expect(card).toContain("if (!allowed || !view.isSuccess || !credentials.isSuccess) return null;");
    expect(card).toContain("decisionCredentials(credentials)");
    expect(card).toContain('key: "jev"');
    expect(card).toContain('key: "openrouter"');
    expect(card).toContain('key: "custom"');
    expect(card).toContain("decisionEndpointOf");
    expect(card).toMatch(/decisionInputOf\(\s*\{[^}]*endpoint: modeDraft\.endpoint[^}]*\},\s*mode,?\s*\)/s);
    expect(card).not.toContain("EndpointForm");
    expect(card).not.toContain("createEndpoint");
    expect(card).not.toContain("protocol");

    // A draft whose account was removed keeps its words and can't be saved.
    expect(card).toMatch(/const draftCredential = modeDraft\s*\? eligible\.find/);
    expect(card).toContain("disabled={!ready || busy}");
    expect(card).toContain('t("jev.decision.accountGone")');
    // A model id of up to 200 characters shows whole instead of ending in "…".
    expect(card).toContain("maxLength={200}");
    expect(card).toContain("subLines={0}");
    // A failed probe keeps the editor and its draft.
    expect(card).toMatch(/onError: \(e\) => setError\(decisionErrorText\(t, e\)\)/);
    expect(card).toContain('errorCode(error) === "decision_endpoint_unsupported"');
    expect(card).toContain('t("jev.decision.error.endpoint")');
    expect(card).toMatch(/onSuccess: \(\) => setSaved\(true\)/);
    // Drafts are separate by mode; a reset is confirmed and keeps the mode on failure.
    expect(card).toContain("Record<ProviderMode, ProviderDraft>");
    expect(card).toContain("confirmAction({");
    expect(card).toMatch(/onSuccess: \(\) => setMode\("jev"\)/);
    expect(card).toMatch(/onError: \(e\) => setError\(decisionErrorText\(t, e\)\)/);
    // Jev's key setup is not rebuilt here: the phone says honestly where it lives.
    expect(card).toContain('t("jev.decision.jevMobile")');
  });

  test("the custom address follows the shared derivation and the full endpoint is optional", async () => {
    const card = await source("features/ai/DecisionSettings.tsx");
    expect(decisionEndpointFromBase("https://magpie.example/v1/")).toBe("https://magpie.example/v1/systemone");
    expect(decisionEndpointFromBase("https://magpie.example/systemone")).toBe("https://magpie.example/systemone");
    expect(decisionEndpointFromBase("https://magpie.example/api")).toBe("https://magpie.example/api/v1/systemone");
    // The notice shows the effective address, override included; the derived one stays the placeholder.
    expect(card).toContain("decisionEndpointOf(draftCredential, modeDraft.endpoint)");
    expect(card).toContain("{effectiveEndpoint}");
    expect(card).toContain('placeholder={derived || "https://…"}');
    // Any draft or account edit makes the last success stale.
    expect(card).toMatch(/const setDraft =[\s\S]*?setSaved\(false\);[\s\S]*?setDrafts/);
    expect(card).toMatch(/setSaved\(false\);\s*setDrafts\(\(all\) => \(\{ \.\.\.all, \[mode\]: next \}\)\);/);
    expect(card).toContain('t("jev.decision.fullEndpoint")');
    expect(card).toContain('keyboardType="url"');
  });

  test("chat endpoint forms and pickers are not decisions-only", async () => {
    const form = await source("features/ai/EndpointForm.tsx");
    const screen = await source("features/ai/AiAccountsScreen.tsx");
    expect(form).not.toContain("systemone");
    expect(form).not.toContain("protocol");
    expect(screen).not.toContain("isSystemOneEndpoint");
  });

  test("the copy says the three modes and the Jev limitation in both languages", async () => {
    const pt = await translator("pt-BR");
    const en = await translator("en");
    expect(pt("jev.decision.provider")).toBe("Provedor de decisões");
    expect(pt("jev.decision.jevTypeSafe")).toBe("Jev (TypeSafe)");
    expect(pt("jev.decision.custom")).toBe("Personalizado");
    expect(pt("jev.decision.otherModel")).toBe("Outro modelo…");
    expect(pt("jev.decision.jevMobile")).toContain("site");
    expect(en("jev.decision.provider")).toBe("Decision provider");
    expect(en("jev.decision.jevTypeSafe")).toBe("Jev (TypeSafe)");
    expect(en("jev.decision.custom")).toBe("Custom");
    expect(en("jev.decision.otherModel")).toBe("Other model…");
  });
});
