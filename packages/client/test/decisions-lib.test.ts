import { describe, expect, test } from "bun:test";
import type { Credential } from "../src/api/types";
import {
  credentialRowOf,
  decisionCredentials,
  decisionDraftOf,
  decisionEndpointOf,
  decisionInputOf,
  decisionModelIdValid,
  decisionModeOf,
  decisionProviderOf,
  isDecisionCredential,
} from "../src/lib/decisions";

const key = (over: Partial<Credential>): Credential => ({
  id: "k",
  provider: "anthropic",
  label: "Claude",
  keyHint: "1234",
  createdAt: "2026-11-16T00:00:00.000Z",
  revokedAt: null,
  ...over,
});

describe("workspace decision credentials", () => {
  test("a live OpenRouter key or any live custom chat endpoint is eligible", () => {
    const openrouter = key({ provider: "openrouter", label: "OpenRouter" });
    const chatEndpoint = key({
      provider: "custom",
      label: "Gateway",
      endpoint: { style: "openai", baseURL: "https://gw.example/v1", models: [{ id: "chat" }] },
    });
    const revoked = key({ provider: "openrouter", revokedAt: "2026-11-16T00:00:00.000Z" });
    expect(decisionProviderOf(chatEndpoint)).toBe("custom");
    expect(decisionProviderOf(openrouter)).toBe("openrouter");
    expect(decisionProviderOf(key({}))).toBeNull();
    expect(isDecisionCredential(chatEndpoint)).toBe(true);
    expect(isDecisionCredential(openrouter)).toBe(true);
    expect(isDecisionCredential(key({}))).toBe(false);
    expect(isDecisionCredential(revoked)).toBe(false);
    expect(decisionCredentials([openrouter, chatEndpoint, revoked]).map((c) => c.id)).toEqual(["k", "k"]);
    // A copy row is not a second choice.
    expect(decisionCredentials([openrouter, { ...openrouter, id: "copy", copyOf: openrouter.id }])).toEqual([
      openrouter,
    ]);
    expect(credentialRowOf([openrouter, { ...openrouter, id: "copy", copyOf: openrouter.id }], "copy")).toBe(
      openrouter,
    );
  });

  test("the mode follows the chosen credential, and null settings mean Jev", () => {
    const openrouter = key({ id: "or", provider: "openrouter" });
    const custom = key({
      id: "custom",
      provider: "custom",
      endpoint: { style: "openai", baseURL: "https://gw.example/v1", models: [] },
    });
    expect(decisionModeOf(null, [openrouter, custom])).toBe("jev");
    expect(decisionModeOf({ credentialId: openrouter.id, model: "m", visionModel: null }, [openrouter, custom])).toBe(
      "openrouter",
    );
    expect(
      decisionModeOf(
        { credentialId: custom.id, model: "m", visionModel: null, endpoint: "https://x.example/v1/systemone" },
        [openrouter, custom],
      ),
    ).toBe("custom");
    expect(decisionModeOf({ credentialId: "gone", model: "m", visionModel: null }, [openrouter])).toBeNull();
  });

  test("a custom decision URL is the override, else derived from the chat endpoint base", () => {
    const custom = key({
      provider: "custom",
      endpoint: { style: "openai", baseURL: "https://magpie.example/v1", models: [] },
    });
    expect(decisionEndpointOf(custom)).toBe("https://magpie.example/v1/systemone");
    expect(decisionEndpointOf(custom, " https://decisions.example/api/decisions ")).toBe(
      "https://decisions.example/api/decisions",
    );
    expect(decisionEndpointOf(key({}))).toBeNull();
  });

  test("the draft keeps exact ids and saves an empty vision or endpoint as absent", () => {
    expect(
      decisionDraftOf({ credentialId: "cred", model: "vendor/decision-1", visionModel: "vendor/vision-1" }),
    ).toEqual({ credentialId: "cred", model: "vendor/decision-1", visionModel: "vendor/vision-1", endpoint: "" });
    expect(decisionDraftOf(null)).toEqual({ credentialId: "", model: "", visionModel: "", endpoint: "" });
    expect(
      decisionInputOf(
        {
          credentialId: " cred ",
          model: " vendor/model:free ",
          visionModel: "  ",
          endpoint: "  ",
        },
        "custom",
      ),
    ).toEqual({
      credentialId: "cred",
      model: "vendor/model:free",
      visionModel: null,
    });
    expect(
      decisionInputOf(
        {
          credentialId: "cred",
          model: "m",
          visionModel: "",
          endpoint: " https://decisions.example/v1/systemone ",
        },
        "custom",
      ),
    ).toEqual({
      credentialId: "cred",
      model: "m",
      visionModel: null,
      endpoint: "https://decisions.example/v1/systemone",
    });
    expect(decisionInputOf({ credentialId: "", model: "m", visionModel: "", endpoint: "" }, "openrouter")).toBeNull();
    expect(decisionInputOf({ credentialId: "cred", model: " ", visionModel: "", endpoint: "" }, "custom")).toBeNull();
    expect(decisionInputOf({ credentialId: "cred", model: "m", visionModel: "", endpoint: "" }, "jev")).toBeNull();
  });

  test("switching a custom draft to OpenRouter stops sending its endpoint, and custom keeps it", () => {
    const draft = {
      credentialId: "or",
      model: "vendor/model",
      visionModel: "",
      endpoint: "https://decisions.example/v1/systemone",
    };
    expect(decisionInputOf(draft, "openrouter")).toEqual({
      credentialId: "or",
      model: "vendor/model",
      visionModel: null,
    });
    expect(decisionInputOf(draft, "custom")).toEqual({
      credentialId: "or",
      model: "vendor/model",
      visionModel: null,
      endpoint: "https://decisions.example/v1/systemone",
    });
  });

  test("a model id may be namespaced, but never whitespace or over 200 characters", () => {
    expect(decisionModelIdValid("openai/gpt-5:free")).toBe(true);
    expect(decisionModelIdValid("a/b@c+d")).toBe(true);
    expect(decisionModelIdValid("two words")).toBe(false);
    expect(decisionModelIdValid("")).toBe(false);
    expect(decisionModelIdValid("a".repeat(201))).toBe(false);
  });
});
