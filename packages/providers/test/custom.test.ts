import { afterEach, describe, expect, test } from "bun:test";
import {
  boundedFetch,
  costNanoUsd,
  createCustomProvider,
  createModelProviders,
  customModelId,
  customModelOf,
  endpointModelId,
  isOpenRouterModel,
  listEndpointModels,
  maxCostNanoUsd,
  modelInfo,
  modelProvider,
  outputTokensWithin,
  ProviderError,
  parseCustomModel,
  parseEndpointModels,
  setCustomModels,
} from "../src";
import { scripted, sse } from "./scripted";

const CRED = "0b9c8a52-4c1f-4f7e-9a11-7d0f2b6c3e10";
const ORG = "org-a";
const id = customModelId(CRED, "meta-llama/llama-4:70b");

afterEach(() => setCustomModels(ORG, {}));

const unpriced = {
  provider: "custom" as const,
  label: "llama",
  prices: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  serverSideFallback: false,
  unpriced: true as const,
};

describe("ids and the registry", () => {
  test("the endpoint model picked when none is named: the best last test, the admin's order among equals", () => {
    const pick = (models: { id: string; check?: "ok" | "no_tools" | "failed" }[]) => endpointModelId(CRED, models);
    expect(pick([])).toBeNull();
    expect(pick([{ id: "a" }, { id: "b" }])).toBe(customModelId(CRED, "a"));
    expect(
      pick([
        { id: "a", check: "no_tools" },
        { id: "b", check: "ok" },
        { id: "c", check: "ok" },
      ]),
    ).toBe(customModelId(CRED, "b"));
    expect(pick([{ id: "a", check: "failed" }, { id: "b" }])).toBe(customModelId(CRED, "b"));
    expect(
      pick([
        { id: "a", check: "failed" },
        { id: "b", check: "no_tools" },
      ]),
    ).toBe(customModelId(CRED, "b"));
    expect(pick([{ id: "a", check: "failed" }])).toBe(customModelId(CRED, "a"));
  });

  test("a custom id keeps its credential and the endpoint's own id, slashes and colons included", () => {
    expect(parseCustomModel(id)).toEqual({ credentialId: CRED, model: "meta-llama/llama-4:70b" });
    expect(parseCustomModel("claude-sonnet-5-5")).toBeNull();
    expect(modelProvider(id)).toBe("custom");
    expect(isOpenRouterModel(id)).toBe(false);
    expect(isOpenRouterModel("~z-ai/glm-latest")).toBe(true);
  });

  test("an organization's models are its own; an unpriced one costs 0 and never limits the output by money", () => {
    setCustomModels(ORG, { [id]: unpriced });
    expect(customModelOf(ORG, id)?.label).toBe("llama");
    expect(customModelOf("org-b", id)).toBeUndefined();
    expect(modelInfo(id)?.unpriced).toBe(true);
    const usage = { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 };
    expect(costNanoUsd(id, usage)).toBe(0);
    expect(maxCostNanoUsd(id, 1000, 4000)).toBe(0);
    expect(outputTokensWithin(id, 1000, 1)).toBe(Number.POSITIVE_INFINITY);
    expect(outputTokensWithin(id, 1000, 0)).toBe(0);
    setCustomModels(ORG, {});
    expect(customModelOf(ORG, id)).toBeUndefined();
    // A call that started before the model was removed still settles its cost.
    expect(costNanoUsd(id, usage)).toBe(0);
  });

  test("the server registers one custom adapter", () => {
    expect(createModelProviders().custom?.id).toBe("custom");
  });
});

describe("model lists", () => {
  test("OpenAI's and Anthropic's shape, Ollama's own, junk and repeats dropped", () => {
    expect(
      parseEndpointModels({
        data: [{ id: "gpt-x" }, { id: "claude-y", display_name: "Claude Y" }, { id: "bad id" }, { id: "gpt-x" }, 3],
      }),
    ).toEqual([{ id: "gpt-x" }, { id: "claude-y", label: "Claude Y" }]);
    expect(parseEndpointModels({ models: [{ name: "llama3:8b" }, { model: "qwen3" }] })).toEqual([
      { id: "llama3:8b" },
      { id: "qwen3" },
    ]);
    expect(parseEndpointModels("nope")).toEqual([]);
  });

  test("API discovery requires one unambiguous native endpoint", () => {
    expect(
      parseEndpointModels({
        data: [
          { id: "chat", native_endpoints: ["/v1/chat/completions"] },
          { id: "messages", native_endpoints: ["/v1/messages"] },
          { id: "responses", native_endpoints: ["/v1/responses"] },
          { id: "unknown" },
          { id: "ambiguous", native_endpoints: ["/v1/messages", "/v1/responses"] },
          { id: "unrecognized", native_endpoints: ["/v1/messages", "/other"] },
          ...[
            "https://host/v1/messages",
            "//host/v1/messages",
            "/v1/messages?x=1",
            "/v1/messages#x",
            "v1/messages",
            "/v1/messages//",
            "toString",
          ].map((path, index) => ({ id: `invalid${index}`, native_endpoints: [path] })),
        ],
      }),
    ).toEqual([
      { id: "chat", api: "chat" },
      { id: "messages", api: "messages" },
      { id: "responses", api: "responses" },
      { id: "unknown" },
      { id: "ambiguous" },
      { id: "unrecognized" },
      ...Array.from({ length: 7 }, (_, index) => ({ id: `invalid${index}` })),
    ]);
  });

  test("the list's address and key by style; a refusal and an oversized list fail with words", async () => {
    const seen: { url: string; headers: Headers }[] = [];
    const answer = (body: string, status = 200) =>
      (async (url: string | URL | Request, init?: RequestInit) => {
        seen.push({ url: String(url), headers: new Headers(init?.headers) });
        return new Response(body, { status });
      }) as unknown as typeof fetch;
    const ok = answer(JSON.stringify({ data: [{ id: "m1" }] }));
    expect(await listEndpointModels({ style: "openai", baseURL: "https://gw.example/v1" }, "k-123456789", ok)).toEqual([
      { id: "m1" },
    ]);
    await listEndpointModels({ style: "anthropic", baseURL: "https://gw.example/anthropic" }, "k-123456789", ok);
    expect(seen[0]?.url).toBe("https://gw.example/v1/models");
    expect(seen[0]?.headers.get("authorization")).toBe("Bearer k-123456789");
    expect(seen[1]?.url).toBe("https://gw.example/anthropic/v1/models");
    expect(seen[1]?.headers.get("x-api-key")).toBe("k-123456789");
    const refused = listEndpointModels({ style: "openai", baseURL: "https://gw.example/v1" }, "k", answer("", 401));
    await expect(refused).rejects.toThrow("the provider answered 401");
    const huge = answer(JSON.stringify({ data: [{ id: "x".repeat(2_100_000) }] }));
    await expect(listEndpointModels({ style: "openai", baseURL: "https://gw.example/v1" }, "k", huge)).rejects.toThrow(
      "too large",
    );
  });
});

const chat = (chunks: Record<string, unknown>[]) =>
  `${chunks.map((c) => `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, ...c })}\n\n`).join("")}data: [DONE]\n\n`;

describe("calls", () => {
  test("custom Responses isolates catalog capabilities and opaque blocks by credential", async () => {
    const response = {
      id: "r",
      object: "response",
      created_at: 1,
      status: "completed",
      model: "m",
      output: [{ type: "reasoning", id: "rs_1", summary: [], encrypted_content: "sealed" }],
      usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
    };
    const { fetcher, requests } = scripted(
      sse([
        { type: "response.created", response },
        { type: "response.completed", response },
      ]),
    );
    const scope = `custom:${CRED}:responses`;
    const result = await createCustomProvider({ fetch: fetcher, maxRetries: 0 }).stream(
      {
        model: customModelId(CRED, "gpt-6.2-sol"),
        system: "s",
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "opaque",
                provider: scope,
                data: { type: "reasoning", id: "matching", summary: [], encrypted_content: "sealed" },
              },
              { type: "opaque", provider: "openai", data: { type: "reasoning", id: "foreign", summary: [] } },
              {
                type: "opaque",
                provider: "custom:other:responses",
                data: { type: "reasoning", id: "other", summary: [] },
              },
            ],
          },
        ],
        maxTokens: 100,
        effort: "high",
      },
      {
        apiKey: "unused",
        endpoint: { style: "openai", baseURL: "https://gw.example/v1", api: "responses" },
        onDelta() {},
      },
    );
    expect(requests[0]?.body.include).toBeUndefined();
    expect(requests[0]?.body.reasoning).toBeUndefined();
    expect(JSON.stringify(requests[0]?.body.input)).toContain("matching");
    expect(JSON.stringify(requests[0]?.body.input)).not.toContain("foreign");
    expect(JSON.stringify(requests[0]?.body.input)).not.toContain("other");
    expect(result.content).toContainEqual({
      type: "opaque",
      provider: scope,
      data: { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "sealed" },
    });
  });
  test("custom chat and messages replay only opaque blocks from the same credential and API", async () => {
    for (const api of ["chat", "messages"] as const) {
      const body =
        api === "chat"
          ? chat([
              {
                choices: [
                  {
                    delta: { reasoning_details: [{ type: "reasoning.text", text: "output", index: 0 }] },
                    finish_reason: "stop",
                  },
                ],
              },
            ])
          : sse([
              {
                type: "message_start",
                message: {
                  id: "m",
                  type: "message",
                  role: "assistant",
                  content: [],
                  model: "m",
                  usage: { input_tokens: 1, output_tokens: 0 },
                },
              },
              {
                type: "content_block_start",
                index: 0,
                content_block: { type: "thinking", thinking: "", signature: "output" },
              },
              { type: "content_block_stop", index: 0 },
              {
                type: "message_delta",
                delta: { stop_reason: "end_turn", stop_sequence: null },
                usage: { output_tokens: 1 },
              },
              { type: "message_stop" },
            ]);
      const { fetcher, requests } = scripted(body);
      const scope = `custom:${CRED}:${api}`;
      const opaque = (provider: string, marker: string) => ({
        type: "opaque" as const,
        provider,
        data: api === "chat" ? { details: [{ text: marker }] } : { type: "thinking", thinking: "", signature: marker },
      });
      const result = await createCustomProvider({ fetch: fetcher, maxRetries: 0 }).stream(
        {
          model: id,
          system: "s",
          maxTokens: 100,
          messages: [
            {
              role: "assistant",
              content: [
                opaque(scope, "matching"),
                opaque(`custom:other:${api}`, "other"),
                opaque(`custom:${CRED}:responses`, "wrong-api"),
                opaque(api === "chat" ? "openrouter" : "anthropic", "first-party"),
              ],
            },
          ],
        },
        { apiKey: "unused", endpoint: { style: "openai", baseURL: "https://gw.example/v1", api }, onDelta() {} },
      );
      const sent = JSON.stringify(requests[0]?.body.messages);
      expect(sent).toContain("matching");
      expect(sent).not.toContain("other");
      expect(sent).not.toContain("wrong-api");
      expect(sent).not.toContain("first-party");
      expect(result.content.some((block) => block.type === "opaque" && block.provider === scope)).toBe(true);
    }
  });
  test("custom Responses drops unencrypted reasoning in a second tool request", async () => {
    const response = {
      id: "r",
      object: "response",
      created_at: 1,
      status: "completed",
      model: "m",
      output: [
        { type: "reasoning", id: "plain", summary: [] },
        { type: "function_call", id: "fc", call_id: "call1", name: "lookup", arguments: "{}", status: "completed" },
      ],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    };
    const { fetcher, requests } = scripted(
      sse([
        { type: "response.created", response },
        { type: "response.completed", response },
      ]),
    );
    const provider = createCustomProvider({ fetch: fetcher, maxRetries: 0 });
    const opts = {
      apiKey: "unused",
      endpoint: { style: "anthropic" as const, baseURL: "https://gw.example", api: "responses" as const },
      onDelta() {},
    };
    const first = await provider.stream({ model: id, system: "s", messages: [], maxTokens: 100 }, opts);
    await provider.stream(
      {
        model: id,
        system: "s",
        messages: [
          { role: "assistant", content: first.content },
          { role: "user", content: [{ type: "tool_result", toolUseId: "call1", content: "done" }] },
        ],
        maxTokens: 100,
      },
      opts,
    );
    expect(requests[0]?.url).toBe("https://gw.example/v1/responses");
    expect(JSON.stringify(requests[1]?.body.input)).not.toContain("plain");
    expect(JSON.stringify(requests[1]?.body.input)).toContain("call1");
  });
  test("per-model API selects the adapter regardless of legacy style", async () => {
    const cases = [
      {
        api: "chat" as const,
        style: "anthropic" as const,
        baseURL: "https://gw.example",
        path: "/v1/chat/completions",
        body: chat([{ choices: [{ delta: {}, finish_reason: "stop" }] }]),
      },
      {
        api: "messages" as const,
        style: "openai" as const,
        baseURL: "https://gw.example/v1",
        path: "/v1/messages",
        body: sse([
          {
            type: "message_start",
            message: {
              id: "m",
              type: "message",
              role: "assistant",
              content: [],
              model: "m",
              usage: { input_tokens: 1, output_tokens: 0 },
            },
          },
          { type: "message_stop" },
        ]),
      },
      {
        api: "responses" as const,
        style: "openai" as const,
        baseURL: "https://gw.example/v1",
        path: "/v1/responses",
        body: sse([
          {
            type: "response.created",
            response: { id: "r", object: "response", created_at: 1, status: "in_progress", model: "m", output: [] },
          },
          {
            type: "response.completed",
            response: {
              id: "r",
              object: "response",
              created_at: 1,
              status: "completed",
              model: "m",
              output: [],
              usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
            },
          },
        ]),
      },
    ];
    for (const c of cases) {
      const { fetcher, requests } = scripted(c.body);
      await createCustomProvider({ fetch: fetcher, maxRetries: 0 }).stream(
        { model: id, system: "s", messages: [{ role: "user", content: "hi" }], maxTokens: 100 },
        { apiKey: "unused", endpoint: { style: c.style, baseURL: c.baseURL, api: c.api }, onDelta() {} },
      );
      expect(new URL(requests[0]?.url ?? "https://missing.invalid").pathname).toBe(c.path);
      expect(requests[0]?.body.model).toBe("meta-llama/llama-4:70b");
      expect(requests[0]?.body[c.api === "responses" ? "input" : "messages"]).toBeDefined();
    }
  });

  test("Responses honors known and unknown attachment reads", async () => {
    const messages = [
      { role: "user" as const, content: "read" },
      { role: "assistant" as const, content: [{ type: "tool_use" as const, id: "t1", name: "read_file", input: {} }] },
      {
        role: "user" as const,
        content: [
          {
            type: "tool_result" as const,
            toolUseId: "t1",
            content: "file",
            images: [{ mediaType: "image/png", data: "UE5H" }],
          },
        ],
      },
    ];
    const response = {
      id: "r",
      object: "response",
      created_at: 1,
      status: "completed",
      model: "m",
      output: [],
      usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
    };
    for (const enabled of [false, true]) {
      const { fetcher, requests } = scripted(
        sse([
          { type: "response.created", response },
          { type: "response.completed", response },
        ]),
      );
      const result = await createCustomProvider({ fetch: fetcher, maxRetries: 0 }).stream(
        { model: id, system: "s", messages, maxTokens: 100 },
        {
          apiKey: "unused",
          endpoint: {
            style: "openai",
            baseURL: "https://gw.example/v1",
            api: "responses",
            ...(enabled ? { reads: { image: true } } : {}),
          },
          onDelta() {},
        },
      );
      expect(JSON.stringify(requests[0]?.body)).toContain(enabled ? "input_image" : "reads text only");
      expect(result.imagesLeftOut).toBe(enabled ? undefined : true);
    }
  });

  test("Chat Completions: the endpoint's address and model id, no OpenRouter extras, usage asked, its cost ignored", async () => {
    const { fetcher, requests } = scripted(
      chat([
        { model: "claude-sonnet-5-5", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] },
        { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, cost: 9 } },
      ]),
    );
    const result = await createCustomProvider({ fetch: fetcher, maxRetries: 0 }).stream(
      { model: id, system: "s", messages: [{ role: "user", content: "hi" }], maxTokens: 100, effort: "high" },
      { apiKey: "k-123456789", endpoint: { style: "openai", baseURL: "https://gw.example/v1" }, onDelta: () => {} },
    );
    const req = requests[0];
    expect(req?.url).toBe("https://gw.example/v1/chat/completions");
    expect(req?.headers.get("http-referer")).toBeNull();
    expect(req?.body).toMatchObject({ model: "meta-llama/llama-4:70b", stream_options: { include_usage: true } });
    expect(req?.body.reasoning).toBeUndefined();
    // The agent's effort goes as Chat Completions' own field (#432).
    expect(req?.body.reasoning_effort).toBe("high");
    expect(req?.body.provider).toBeUndefined();
    // The endpoint said a catalog id answered: the full id comes back, so the catalog's prices never apply.
    expect(result.model).toBe(id);
    expect(result.costNanoUsd).toBeUndefined();
    expect(result.usage.inputTokens).toBe(10);
    // Any other endpoint: no session of ours, the SDK's own User-Agent.
    expect(req?.headers.get("x-opencode-session")).toBeNull();
    expect(req?.headers.get("user-agent")).not.toStartWith("agentes.chat/");
  });

  test("Chat Completions: an effort the endpoint refuses goes again with the nearest it takes, then stays mapped", async () => {
    // Mistral's own words for a model without `medium` (deepseek-v4-1-flash-1017, seen 2026-11-19).
    const refusal = JSON.stringify({
      object: "error",
      message:
        "reasoning_effort 'medium' is not supported for this model; supported values: ['none', 'low', 'high', 'xhigh', 'max']",
      type: "invalid_request_invalid_args",
      code: "3051",
    });
    const stream = chat([
      { choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } },
    ]);
    const seen: { body: Record<string, unknown>; status: number }[] = [];
    const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      // The model takes no `medium`: only that request is refused, so the second attempt answers.
      const refused = body.reasoning_effort === "medium";
      seen.push({ body, status: refused ? 400 : 200 });
      return refused
        ? new Response(refusal, { status: 400, headers: { "content-type": "application/json" } })
        : new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch;
    const provider = createCustomProvider({ fetch: fetcher, maxRetries: 0 });
    const call = () =>
      provider.stream(
        {
          model: customModelId(CRED, "deepseek-v4.1-flash"),
          system: "s",
          messages: [{ role: "user", content: "hi" }],
          maxTokens: 100,
          effort: "medium",
        },
        { apiKey: "k-123456789", endpoint: { style: "openai", baseURL: "https://gw.example/v1" }, onDelta: () => {} },
      );
    const result = await call();
    expect(result.text).toBe("ok");
    // `medium` sits between `low` and `high`: the tie goes to the stronger one, never to less thinking.
    expect(seen.map((r) => [r.body.reasoning_effort, r.status])).toEqual([
      ["medium", 400],
      ["high", 200],
    ]);
    // The endpoint's list is remembered: the next turn asks for `high` once, with no wasted call.
    seen.length = 0;
    await call();
    expect(seen.map((r) => [r.body.reasoning_effort, r.status])).toEqual([["high", 200]]);
  });

  test("Chat Completions: a 400 that isn't about the effort is the turn's own failure", async () => {
    const fetcher = (async () =>
      new Response(JSON.stringify({ object: "error", message: "Model not found" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const refused = createCustomProvider({ fetch: fetcher, maxRetries: 0 }).stream(
      { model: id, system: "s", messages: [{ role: "user", content: "hi" }], maxTokens: 100, effort: "medium" },
      { apiKey: "k-123456789", endpoint: { style: "openai", baseURL: "https://gw.example/v1" }, onDelta: () => {} },
    );
    await expect(refused).rejects.toThrow("Model not found");
  });

  test("Chat Completions: no effort, or none, sends no reasoning_effort", async () => {
    for (const effort of [undefined, "none"] as const) {
      const { fetcher, requests } = scripted(
        chat([
          { choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] },
          { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } },
        ]),
      );
      await createCustomProvider({ fetch: fetcher, maxRetries: 0 }).stream(
        {
          model: id,
          system: "s",
          messages: [{ role: "user", content: "hi" }],
          maxTokens: 100,
          ...(effort ? { effort } : {}),
        },
        { apiKey: "k-123456789", endpoint: { style: "openai", baseURL: "https://gw.example/v1" }, onDelta: () => {} },
      );
      expect(requests[0]?.body.reasoning_effort).toBeUndefined();
    }
  });

  test("OpenCode (its Go plan): our User-Agent and the conversation's session on every call, both APIs", async () => {
    const done = chat([
      { choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } },
    ]);
    const go = scripted(done);
    const provider = createCustomProvider({ fetch: go.fetcher, maxRetries: 0, version: "2026.11.07.9" });
    const call = (session?: string) =>
      provider.stream(
        {
          model: customModelId(CRED, "deepseek-v4.1-flash"),
          system: "s",
          messages: [{ role: "user", content: "hi" }],
          maxTokens: 100,
        },
        {
          apiKey: "oc_sk_test-key",
          endpoint: { style: "openai", baseURL: "https://opencode.ai/zen/go/v1" },
          ...(session ? { session } : {}),
          onDelta: () => {},
        },
      );
    await call("5f0c2c1e-0000-5000-8000-000000000001");
    await call();
    const [first, second] = go.requests;
    expect(first?.url).toBe("https://opencode.ai/zen/go/v1/chat/completions");
    expect(first?.headers.get("x-opencode-session")).toBe("5f0c2c1e-0000-5000-8000-000000000001");
    expect(first?.headers.get("user-agent")).toBe("agentes.chat/2026.11.07.9");
    // A call of no conversation (the connect dialog's test of each model) is a session of its own.
    expect(second?.headers.get("x-opencode-session")).toMatch(/^[0-9a-f-]{36}$/);
    expect(second?.headers.get("user-agent")).toBe("agentes.chat/2026.11.07.9");
    const messages = scripted(
      sse([
        {
          type: "message_start",
          message: {
            id: "m",
            type: "message",
            role: "assistant",
            model: "x",
            content: [],
            stop_reason: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        },
        { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
        { type: "message_stop" },
      ]),
    );
    await createCustomProvider({ fetch: messages.fetcher, maxRetries: 0 }).stream(
      {
        model: customModelId(CRED, "minimax-m3"),
        system: "s",
        messages: [{ role: "user", content: "hi" }],
        maxTokens: 100,
      },
      {
        apiKey: "oc_sk_test-key",
        endpoint: { style: "anthropic", baseURL: "https://opencode.ai/inference/go/anthropic" },
        session: "conversation-1",
        onDelta() {},
      },
    );
    expect(messages.requests[0]?.headers.get("x-opencode-session")).toBe("conversation-1");
    expect(messages.requests[0]?.headers.get("user-agent")).toBe("agentes.chat/dev");
  });

  test("Anthropic Messages in its compatible mode; a refusal keeps the server's words", async () => {
    const { fetcher, requests } = scripted(
      sse([
        {
          type: "message_start",
          message: {
            id: "m",
            type: "message",
            role: "assistant",
            model: "x",
            content: [],
            stop_reason: null,
            usage: { input_tokens: 5, output_tokens: 1 },
          },
        },
        { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
        { type: "message_stop" },
      ]),
    );
    await createCustomProvider({ fetch: fetcher, maxRetries: 0 }).stream(
      { model: id, system: "s", messages: [{ role: "user", content: "hi" }], maxTokens: 100 },
      {
        apiKey: "k-123456789",
        endpoint: { style: "anthropic", baseURL: "https://gw.example/anthropic" },
        onDelta() {},
      },
    );
    expect(requests[0]?.url).toStartWith("https://gw.example/anthropic/v1/messages");
    expect(requests[0]?.body.model).toBe("meta-llama/llama-4:70b");
    expect(requests[0]?.body.cache_control).toBeUndefined();

    const refused = scripted(JSON.stringify({ error: { message: "model llama-9 not found" } }), 404);
    const error = await createCustomProvider({ fetch: refused.fetcher, maxRetries: 0 })
      .stream(
        { model: id, system: "s", messages: [{ role: "user", content: "hi" }], maxTokens: 100 },
        { apiKey: "k-123456789", endpoint: { style: "openai", baseURL: "https://gw.example/v1" }, onDelta() {} },
      )
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).message).toContain("model llama-9 not found");
  });

  test("Anthropic-compatible models send attachments only with explicit capabilities", async () => {
    const reply = sse([
      {
        type: "message_start",
        message: {
          id: "m",
          type: "message",
          role: "assistant",
          model: "x",
          content: [],
          stop_reason: null,
          usage: { input_tokens: 5, output_tokens: 1 },
        },
      },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ]);
    const messages = [
      { role: "user" as const, content: "what is in the file?" },
      { role: "assistant" as const, content: [{ type: "tool_use" as const, id: "t1", name: "read_file", input: {} }] },
      {
        role: "user" as const,
        content: [
          {
            type: "tool_result" as const,
            toolUseId: "t1",
            content: "shot.png",
            images: [
              { mediaType: "image/png", data: "UE5H" },
              { mediaType: "application/pdf", data: "UERG" },
            ],
          },
        ],
      },
    ];
    const send = async (model: string, reads?: { image?: boolean; pdf?: boolean }) => {
      const { fetcher, requests } = scripted(reply);
      const result = await createCustomProvider({ fetch: fetcher, maxRetries: 0 }).stream(
        { model: customModelId(CRED, model), system: "s", messages, maxTokens: 100 },
        {
          apiKey: "k-123456789",
          endpoint: { style: "anthropic", baseURL: "https://bedrock-runtime.us-east-1.amazonaws.com/anthropic", reads },
          onDelta() {},
        },
      );
      return { body: JSON.stringify(requests[0]?.body.messages), leftOut: result.imagesLeftOut };
    };
    const claude = await send("global.anthropic.claude-sonnet-5-5");
    expect(claude.body).not.toContain('"type":"image"');
    expect(claude.body).not.toContain('"type":"document"');
    expect(claude.leftOut).toBe(true);
    const deepseek = await send("deepseek-flash");
    expect(deepseek.body).not.toContain('"type":"image"');
    expect(deepseek.body).not.toContain('"type":"document"');
    expect(deepseek.leftOut).toBe(true);
    const enabled = await send("global.anthropic.claude-sonnet-5-5", { image: true, pdf: true });
    expect(enabled.body).toContain('"type":"image"');
    expect(enabled.body).toContain('"type":"document"');
    expect(enabled.leftOut).toBeUndefined();
    const other = await send("moonshotai.kimi-k2.5");
    expect(other.leftOut).toBe(true);
    expect(other.body).not.toContain('"type":"image"');
    expect(other.body).toContain("The picture and the PDF are not shown");
    const imageOnly = await send("moonshotai.kimi-k2.5", { image: true });
    expect(imageOnly.body).toContain('"type":"image"');
    expect(imageOnly.body).not.toContain('"type":"document"');
    expect(imageOnly.body).toContain("The PDF is not shown");
    expect(imageOnly.leftOut).toBe(true);
    const disabled = await send("global.anthropic.claude-sonnet-5-5", { image: false, pdf: false });
    expect(disabled.body).not.toContain('"type":"image"');
    expect(disabled.leftOut).toBe(true);
  });

  test("unknown Chat Completions attachments are text-only until manually enabled", async () => {
    const messages = [
      { role: "user" as const, content: "read the files" },
      { role: "assistant" as const, content: [{ type: "tool_use" as const, id: "t1", name: "read_file", input: {} }] },
      {
        role: "user" as const,
        content: [
          {
            type: "tool_result" as const,
            toolUseId: "t1",
            content: "files",
            images: [
              { mediaType: "image/png", data: "UE5H" },
              { mediaType: "application/pdf", data: "UERG" },
            ],
          },
        ],
      },
    ];
    const send = async (reads?: { image?: boolean; pdf?: boolean }) => {
      const { fetcher, requests } = scripted(chat([{ choices: [{ delta: {}, finish_reason: "stop" }] }]));
      const result = await createCustomProvider({ fetch: fetcher, maxRetries: 0 }).stream(
        { model: id, system: "s", maxTokens: 100, messages },
        { apiKey: "unused", endpoint: { style: "openai", baseURL: "https://gw.example/v1", reads }, onDelta() {} },
      );
      return { body: JSON.stringify(requests[0]?.body.messages), leftOut: result.imagesLeftOut };
    };
    const unknown = await send();
    expect(unknown.body).not.toContain('"type":"image_url"');
    expect(unknown.body).not.toContain('"type":"file"');
    expect(unknown.leftOut).toBe(true);
    const enabled = await send({ image: true, pdf: true });
    expect(enabled.body).toContain('"type":"image_url"');
    expect(enabled.body).toContain('"type":"file"');
    expect(enabled.leftOut).toBeUndefined();
  });

  test("compatible Chat Completions sends enabled attachments after all tool replies", async () => {
    const { fetcher, requests } = scripted(chat([{ choices: [{ delta: {}, finish_reason: "stop" }] }]));
    const attachments = [
      { mediaType: "image/png", data: "UE5H" },
      { mediaType: "application/pdf", data: "UERG", name: "report.pdf" },
    ];
    const toolIds = ["t1", "t2"];
    const result = await createCustomProvider({ fetch: fetcher, maxRetries: 0 }).stream(
      {
        model: id,
        system: "s",
        maxTokens: 100,
        messages: [
          { role: "user", content: "read the files" },
          { role: "assistant", content: toolIds.map((id) => ({ type: "tool_use", id, name: "read_file", input: {} })) },
          {
            role: "user",
            content: attachments.map((attachment, index) => ({
              type: "tool_result",
              toolUseId: `t${index + 1}`,
              content: `file ${index + 1}`,
              images: [attachment],
            })),
          },
        ],
      },
      {
        apiKey: "unused",
        endpoint: { style: "openai", baseURL: "https://gw.example/v1", reads: { image: true, pdf: true } },
        onDelta() {},
      },
    );
    expect((requests[0]?.body.messages as unknown[] | undefined)?.slice(-3)).toEqual([
      { role: "tool", tool_call_id: "t1", content: "file 1" },
      { role: "tool", tool_call_id: "t2", content: "file 2" },
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: "data:image/png;base64,UE5H" } },
          { type: "file", file: { filename: "report.pdf", file_data: "data:application/pdf;base64,UERG" } },
        ],
      },
    ]);
    expect(result.imagesLeftOut).toBeUndefined();
  });

  test("tool calls without an index, or with object arguments, stay apart and readable", async () => {
    const { fetcher } = scripted(
      chat([
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  { id: "a", function: { name: "one", arguments: { x: 1 } } },
                  { id: "b", function: { name: "two", arguments: '{"y":' } },
                ],
              },
            },
          ],
        },
        {
          choices: [
            { index: 0, delta: { tool_calls: [{ function: { arguments: "2}" } }] }, finish_reason: "tool_calls" },
          ],
        },
      ]),
    );
    const result = await createCustomProvider({ fetch: fetcher, maxRetries: 0 }).stream(
      { model: id, system: "s", messages: [{ role: "user", content: "hi" }], maxTokens: 100 },
      { apiKey: "k-123456789", endpoint: { style: "openai", baseURL: "https://gw.example/v1" }, onDelta: () => {} },
    );
    expect(result.content.filter((b) => b.type === "tool_use")).toEqual([
      { type: "tool_use", id: "a", name: "one", input: { x: 1 } },
      { type: "tool_use", id: "b", name: "two", input: { y: 2 } },
    ]);
  });

  test("an endpoint's reply is cut past its size and its time", async () => {
    const endless = (async (_url: string | URL | Request, init?: RequestInit) =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (init?.signal?.aborted) controller.error(init.signal.reason);
            else controller.enqueue(new Uint8Array(1000));
          },
        }),
      )) as unknown as typeof fetch;
    const big = await boundedFetch(endless, { maxBytes: 5000, timeoutMs: 60_000 })("https://gw.example/v1");
    await expect(big.text()).rejects.toThrow("too large");
    const silent = (async (_url: string | URL | Request, init?: RequestInit) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason));
          },
        }),
      )) as unknown as typeof fetch;
    const slow = await boundedFetch(silent, { maxBytes: 5000, timeoutMs: 20 })("https://gw.example/v1");
    await expect(slow.text()).rejects.toThrow();
  });

  test("a call without an endpoint fails", async () => {
    const call = createCustomProvider().stream(
      { model: id, system: "s", messages: [{ role: "user", content: "hi" }], maxTokens: 1 },
      { apiKey: "k", onDelta() {} },
    );
    await expect(call).rejects.toThrow("no endpoint");
  });
});

test("model discovery reads explicit capabilities and leaves absent metadata unknown", () => {
  expect(
    parseEndpointModels({
      data: [
        {
          id: "gateway/model",
          context_length: 128000,
          top_provider: { max_completion_tokens: 4096 },
          architecture: { input_modalities: ["text", "image"] },
          pricing: { prompt: "0", completion: "0.0000025", input_cache_read: "0.00000025", input_cache_write: "NaN" },
        },
        { id: "ids-only", context_window: -1, input_modalities: [], pricing: { prompt: "", completion: -1 } },
      ],
    }),
  ).toEqual([
    {
      id: "gateway/model",
      caps: {
        limits: { contextWindow: 128000, maxOutputTokens: 4096 },
        prices: { input: 0, output: 2.5, cacheRead: 0.25 },
        image: true,
        pdf: false,
      },
    },
    { id: "ids-only" },
  ]);
});

test("OpenRouter file input is PDF support", () => {
  const [model] = parseEndpointModels(
    { data: [{ id: "m", architecture: { input_modalities: ["text", "file"] } }] },
    { fileIsPdf: true },
  );
  expect(model?.caps?.pdf).toBe(true);
});

test("discovery merges per field by source and timestamp, preserving zero and false", async () => {
  const { mergeEndpointDiscovery } = await import("../src/endpoint-discovery");
  const old = "2026-01-01T00:00:00.000Z";
  const recent = "2026-02-01T00:00:00.000Z";
  expect(
    mergeEndpointDiscovery(
      {
        contextWindow: { value: 4096, source: "endpoint", discoveredAt: old },
        image: { value: true, source: "probe", discoveredAt: old },
        prices: { input: { value: 2, source: "catalog", discoveredAt: old } },
      },
      {
        contextWindow: { value: 8192, source: "catalog", discoveredAt: recent },
        image: { value: false, source: "probe", discoveredAt: recent },
        prices: { input: { value: 0, source: "catalog", discoveredAt: recent } },
      },
    ),
  ).toEqual({
    contextWindow: { value: 4096, source: "endpoint", discoveredAt: old },
    image: { value: false, source: "probe", discoveredAt: recent },
    prices: { input: { value: 0, source: "catalog", discoveredAt: recent } },
  });
});

test("legacy grouped discovery preserves sources and original dates", async () => {
  const { normalizeEndpointDiscovery } = await import("../src/endpoint-discovery");
  const discoveredAt = "2026-01-01T00:00:00.000Z";
  expect(
    normalizeEndpointDiscovery({
      discoveredAt,
      limits: { source: "endpoint", value: { contextWindow: 100 } },
      prices: { source: "endpoint", value: { input: 0 } },
      image: { source: "probe", value: false },
    }),
  ).toEqual({
    contextWindow: { source: "endpoint", value: 100, discoveredAt },
    prices: { input: { source: "endpoint", value: 0, discoveredAt } },
    image: { source: "probe", value: false, discoveredAt },
  });
});

test("incomplete modality lists report only positive attachment capabilities", () => {
  const models = parseEndpointModels({
    data: [
      { id: "image-only", input_modalities: ["image"] },
      { id: "file-only", architecture: { input_modalities: ["file"] } },
      { id: "complete", input_modalities: ["text"] },
    ],
  });
  expect(models[0]?.caps).toEqual({ image: true });
  expect(models[1]?.caps).toBeUndefined();
  expect(models[2]?.caps).toEqual({ image: false, pdf: false });
});

test("mixed discovery and future fields survive normalization and merge", async () => {
  const { mergeEndpointDiscovery } = await import("../src/endpoint-discovery");
  const date = "2026-01-01T00:00:00.000Z";
  const input = {
    discoveredAt: date,
    limits: { source: "endpoint" as const, value: { contextWindow: 100 } },
    contextWindow: { value: 200, source: "probe" as const, discoveredAt: date },
    future: { retained: true },
    prices: { input: { value: 0, source: "endpoint" as const, discoveredAt: date }, futurePrice: { value: 5 } },
  };
  expect(mergeEndpointDiscovery(input, { image: { value: false, source: "probe", discoveredAt: date } })).toMatchObject(
    {
      contextWindow: input.contextWindow,
      future: input.future,
      prices: input.prices,
      image: { value: false, source: "probe", discoveredAt: date },
    },
  );
});

test("legacy grouped prices preserve unrecognized price fields", async () => {
  const { normalizeEndpointDiscovery } = await import("../src/endpoint-discovery");
  const discoveredAt = "2026-01-01T00:00:00.000Z";
  const value = { discoveredAt, prices: { source: "endpoint" as const, value: { input: 1, futurePrice: 9 } } };
  expect(normalizeEndpointDiscovery(value)).toMatchObject({
    prices: {
      input: { value: 1, source: "endpoint", discoveredAt },
      futurePrice: { value: 9, source: "endpoint", discoveredAt },
    },
  });
});

test("file modality is PDF only for the OpenRouter host", async () => {
  const body = {
    data: [
      { id: "m", input_modalities: ["file"] },
      { id: "p", input_modalities: ["pdf"] },
      { id: "mixed", input_modalities: ["text", "file"] },
    ],
  };
  const http = (async () => Response.json(body)) as unknown as typeof fetch;
  const generic = await listEndpointModels({ style: "openai", baseURL: "https://gateway.example/v1" }, "key", http);
  const openrouter = await listEndpointModels(
    { style: "openai", baseURL: "https://openrouter.ai/api/v1" },
    "key",
    http,
  );
  expect(generic[0]?.caps).toBeUndefined();
  expect(generic[1]?.caps?.pdf).toBe(true);
  expect(openrouter[0]?.caps?.pdf).toBe(true);
  expect(generic[2]?.caps).toEqual({ image: false, pdf: false });
  expect(openrouter[2]?.caps).toEqual({ image: false, pdf: true });
});
