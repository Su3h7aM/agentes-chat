import { expect, test } from "bun:test";
import type { Credential } from "@agenteschat/client";
import type { TFunction } from "i18next";
import { DEFAULT_KEY, keyOptions } from "../src/components/AgentFields";

const key = (over: Partial<Credential>): Credential => ({
  id: "k1",
  provider: "anthropic",
  label: "Claude",
  keyHint: "1234",
  createdAt: "2026-11-16T00:00:00.000Z",
  revokedAt: null,
  ...over,
});

test("a chat key picker offers every live chat key, including a custom endpoint used for decisions", () => {
  const main = key({ id: "main" });
  const other = key({ id: "other", label: "Outra" });
  const custom = key({
    id: "custom",
    provider: "custom",
    label: "Gateway",
    endpoint: {
      style: "openai",
      baseURL: "https://llm.example.com/v1",
      models: [{ id: "gateway/model" }],
    },
  });
  const revoked = key({ id: "gone", revokedAt: "2026-11-16T00:00:00.000Z" });
  const t = ((k: string) => k) as unknown as TFunction;
  expect(keyOptions(t, [main, other, custom, revoked], main.id).map((option) => option.value)).toEqual([
    DEFAULT_KEY,
    other.id,
    custom.id,
  ]);
});
