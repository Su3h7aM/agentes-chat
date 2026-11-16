import { describe, expect, test } from "bun:test";
import { decisionEndpointFromBase } from "../src/decision-endpoint";

describe("a custom endpoint's decision address", () => {
  test("a normalized /v1 base gets /systemone, never a second /v1", () => {
    expect(decisionEndpointFromBase("https://magpie.example/v1")).toBe("https://magpie.example/v1/systemone");
    expect(decisionEndpointFromBase("https://magpie.example/v1/")).toBe("https://magpie.example/v1/systemone");
    expect(decisionEndpointFromBase("https://magpie.su3h7am.dev.br/v1")).toBe(
      "https://magpie.su3h7am.dev.br/v1/systemone",
    );
  });

  test("any other base gets /v1/systemone, keeping its path prefix", () => {
    expect(decisionEndpointFromBase("https://gateway.example")).toBe("https://gateway.example/v1/systemone");
    expect(decisionEndpointFromBase("https://gateway.example/anthropic")).toBe(
      "https://gateway.example/anthropic/v1/systemone",
    );
    expect(decisionEndpointFromBase("http://localhost:11434")).toBe("http://localhost:11434/v1/systemone");
  });

  test("a base already ending in /systemone is unchanged, trailing slashes aside", () => {
    expect(decisionEndpointFromBase("https://gateway.example/v1/systemone")).toBe(
      "https://gateway.example/v1/systemone",
    );
    expect(decisionEndpointFromBase("https://gateway.example/custom/systemone/")).toBe(
      "https://gateway.example/custom/systemone",
    );
  });
});
