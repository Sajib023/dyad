import { afterEach, describe, expect, test, vi } from "vitest";
import { generateText, streamText } from "ai";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import { DyadErrorKind } from "@/errors/dyad_error";
import type { UserSettings } from "../../lib/schemas";
import {
  getModelClient,
  modelClientSupportsPdfInput,
  setModelClientFetchForTesting,
} from "./get_model_client";
import {
  OPENROUTER_APP_CATEGORIES,
  OPENROUTER_APP_REFERER,
  OPENROUTER_APP_TITLE,
} from "./openrouter_attribution";

vi.mock("electron-log", () => ({
  default: {
    scope: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      log: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  },
}));

vi.mock("./model_effort", () => ({
  resolveModelSelection: vi.fn(async ({ model, preferredEffortLevel }) => ({
    ...model,
    effortLevel: preferredEffortLevel ?? "medium",
  })),
}));

// Mutable custom-provider stand-in: tests flip apiProtocol per case.
// vi.mock factories are hoisted, so the mutable cell lives in vi.hoisted.
const h = vi.hoisted(() => ({ customProtocol: "openai" }));

vi.mock("../shared/language_model_helpers", () => ({
  getLanguageModels: vi.fn(async () => []),
  getLanguageModelProviders: vi.fn(async () => [
    {
      id: "custom",
      name: "custom",
      type: "custom",
      apiBaseUrl: "http://localhost:1234/v1",
      apiProtocol: h.customProtocol,
    },
    ...["lmstudio", "ollama"].map((id) => ({
      id,
      name: id,
      type: "local",
      apiBaseUrl: "http://localhost:1234/v1",
    })),
    {
      id: "openai",
      name: "OpenAI",
      type: "cloud",
    },
    {
      id: "anthropic",
      name: "Anthropic",
      type: "cloud",
    },
    {
      id: "google",
      name: "Google",
      type: "cloud",
    },
    {
      id: "openrouter",
      name: "OpenRouter",
      type: "cloud",
    },
  ]),
}));

afterEach(() => {
  setModelClientFetchForTesting(undefined);
  vi.unstubAllGlobals();
  h.customProtocol = "openai";
});

function apiKeySettings(keys: Record<string, string> = {}): UserSettings {
  return {
    providerSettings: Object.fromEntries(
      Object.entries(keys).map(([provider, value]) => [
        provider,
        { apiKey: { value } },
      ]),
    ),
  } as unknown as UserSettings;
}

describe("getModelClient (BYOK-only)", () => {
  test("sends OpenAI API-key requests to /v1/responses with the settings key", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response("data: [DONE]\n\n", {
          headers: { "content-type": "text/event-stream" },
        }),
    );
    setModelClientFetchForTesting(fetch);
    const { modelClient, isEngineEnabled, isSmartContextEnabled } =
      await getModelClient(
        { provider: "openai", name: "gpt-test" },
        apiKeySettings({ openai: "test-api-key" }),
        {
          provider: "openai",
          name: "gpt-test",
          effortLevel: "medium",
        },
      );
    expect(isEngineEnabled).toBe(false);
    expect(isSmartContextEnabled).toBe(false);
    const result = await (modelClient.model as LanguageModelV3).doStream({
      prompt: [],
    });
    await result.stream.cancel();
    expect(fetch).toHaveBeenCalledOnce();
    expect(String(fetch.mock.calls[0][0])).toBe(
      "https://api.openai.com/v1/responses",
    );
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).not.toHaveProperty(
      "service_tier",
    );
  });

  test("routes an OpenAI-compatible custom provider at its base URL", async () => {
    let capturedUrl: string | undefined;
    let capturedAuth: string | null | undefined;
    setModelClientFetchForTesting(
      vi.fn(async (url, init) => {
        capturedUrl = url.toString();
        capturedAuth = new Headers(init?.headers).get("authorization");
        return new Response(
          JSON.stringify({
            id: "chatcmpl-test",
            choices: [
              {
                message: { role: "assistant", content: "ok" },
                finish_reason: "stop",
              },
            ],
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      }),
    );
    const { modelClient } = await getModelClient(
      { provider: "custom", name: "my-model" },
      apiKeySettings({ custom: "test-custom" }),
    );
    await generateText({
      model: modelClient.model,
      prompt: "hi",
      maxRetries: 0,
    });
    expect(capturedUrl).toBe("http://localhost:1234/v1/chat/completions");
    expect(capturedAuth).toBe("Bearer test-custom");
    expect(modelClient.builtinProviderId).toBe("custom");
  });

  test("routes an Anthropic-compatible custom provider at its base URL", async () => {
    let capturedUrl: string | undefined;
    let capturedAuth: string | null | undefined;
    let capturedBody: Record<string, unknown> | undefined;
    h.customProtocol = "anthropic";
    setModelClientFetchForTesting(
      vi.fn(async (url, init) => {
        capturedUrl = url.toString();
        capturedAuth = new Headers(init?.headers).get("x-api-key");
        capturedBody = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({
            id: "msg-test",
            type: "message",
            role: "assistant",
            model: "my-model",
            content: [{ type: "text", text: "ok" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      }),
    );
    const { modelClient } = await getModelClient(
      { provider: "custom", name: "my-model" },
      apiKeySettings({ custom: "test-custom" }),
    );
    await generateText({
      model: modelClient.model,
      prompt: "hi",
      maxRetries: 0,
    });
    expect(capturedUrl).toBe("http://localhost:1234/v1/messages");
    expect(capturedAuth).toBe("test-custom");
    expect(capturedBody).toMatchObject({ model: "my-model" });
    expect(modelClient.builtinProviderId).toBe("custom");
  });

  test("streams text through a custom provider end to end", async () => {
    setModelClientFetchForTesting(async () => {
      const chunks = [
        {
          id: "test",
          model: "my-model",
          choices: [
            { index: 0, delta: { content: "hello" }, finish_reason: null },
          ],
        },
        {
          id: "test",
          model: "my-model",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        },
      ];
      return new Response(
        chunks.map((c) => "data: " + JSON.stringify(c) + "\n\n").join("") +
          "data: [DONE]\n\n",
        { headers: { "Content-Type": "text/event-stream" } },
      );
    });
    const result = await getModelClient(
      { provider: "custom", name: "my-model" },
      apiKeySettings({ custom: "test-custom" }),
    );
    await expect(
      streamText({ model: result.modelClient.model, prompt: "hello" }).text,
    ).resolves.toBe("hello");
  });

  test("rejects retired auto selections with a validation error", async () => {
    await expect(
      getModelClient(
        { provider: "auto", name: "auto" },
        apiKeySettings({ openai: "test-openai" }),
      ),
    ).rejects.toMatchObject({ kind: DyadErrorKind.Validation });
  });

  test("rejects unknown providers", async () => {
    await expect(
      getModelClient({ provider: "nope", name: "nothing" }, apiKeySettings()),
    ).rejects.toMatchObject({ kind: DyadErrorKind.NotFound });
  });

  test("routes openai models through Responses", async () => {
    let capturedUrl: string | undefined;
    let capturedBody: Record<string, unknown> | undefined;
    setModelClientFetchForTesting(
      vi.fn(async (url, init) => {
        capturedUrl = url.toString();
        capturedBody = JSON.parse(init?.body as string);
        return new Response(
          JSON.stringify({
            id: "resp-test",
            created_at: 1_700_000_000,
            model: "gpt-5.5",
            output: [
              {
                type: "message",
                role: "assistant",
                id: "msg-test",
                content: [{ type: "output_text", text: "ok", annotations: [] }],
              },
            ],
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      }),
    );

    const { modelClient } = await getModelClient(
      { provider: "openai", name: "gpt-5.5" },
      apiKeySettings({ openai: "test-openai" }),
    );

    await generateText({
      model: modelClient.model,
      prompt: "hi",
      maxOutputTokens: 128000,
      maxRetries: 0,
    });

    expect(capturedUrl).toMatch(/\/v1\/responses$/);
    expect(capturedBody).not.toHaveProperty("max_tokens");
    expect(capturedBody).toMatchObject({
      model: "gpt-5.5",
      max_output_tokens: 128000,
      store: false,
    });
    expect((modelClient.model as { modelId: string }).modelId).toBe("gpt-5.5");
  });

  test("sends OpenRouter app attribution headers", async () => {
    let capturedHeaders: Headers | undefined;
    setModelClientFetchForTesting(
      vi.fn(async (_url, init) => {
        capturedHeaders = new Headers(init?.headers);
        return new Response(
          JSON.stringify({
            id: "chatcmpl-test",
            choices: [
              {
                message: { role: "assistant", content: "ok" },
                finish_reason: "stop",
              },
            ],
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      }),
    );

    const { modelClient } = await getModelClient(
      { provider: "openrouter", name: "openrouter/free" },
      apiKeySettings({ openrouter: "openrouter-key" }),
    );

    await generateText({
      model: modelClient.model,
      prompt: "hi",
      maxRetries: 0,
    });

    expect(capturedHeaders?.get("Authorization")).toBe("Bearer openrouter-key");
    expect(capturedHeaders?.get("HTTP-Referer")).toBe(OPENROUTER_APP_REFERER);
    expect(capturedHeaders?.get("X-OpenRouter-Title")).toBe(
      OPENROUTER_APP_TITLE,
    );
    expect(capturedHeaders?.get("X-OpenRouter-Categories")).toBe(
      OPENROUTER_APP_CATEGORIES,
    );
  });
});

describe("modelClientSupportsPdfInput", () => {
  const apiKeySettingsFixture = apiKeySettings({
    openai: "test-openai",
    google: "test-google",
  });

  test.each([
    ["openai", "gpt-5.5", true],
    ["google", "gemini-3.5-flash", true],
    ["anthropic", "claude-sonnet-4-6", true],
    ["openrouter", "qwen/qwen3-coder", true],
    ["custom", "my-model", true],
    ["lmstudio", "local-model", false],
    ["ollama", "local-model", false],
  ] as const)("%s/%s -> %s", async (provider, name, expected) => {
    const { modelClient } = await getModelClient(
      { provider, name },
      apiKeySettingsFixture,
    );
    expect(modelClientSupportsPdfInput(modelClient)).toBe(expected);
  });
});
