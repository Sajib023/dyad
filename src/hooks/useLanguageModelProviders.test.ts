import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useLanguageModelProviders } from "./useLanguageModelProviders";

const mocks = vi.hoisted(() => ({
  providerSettings: {} as Record<string, { apiKey: { value: string } }>,
  selectedModel: {
    provider: "ollama",
    name: "llama3",
  },
  useQueryResult: {
    data: undefined,
    isLoading: true,
  },
  subscriptionLoading: false,
  subscription: {
    connected: false,
    pending: false,
    setupError: undefined as string | undefined,
    models: ["subscription-model"],
  },
}));
vi.mock("./useSubscriptionAccount", () => ({
  useSubscriptionAccount: () => ({
    data: mocks.subscriptionLoading ? undefined : mocks.subscription,
    isLoading: mocks.subscriptionLoading,
  }),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => mocks.useQueryResult,
}));

vi.mock("@/ipc/types", () => ({
  ipc: {
    languageModel: {
      getProviders: vi.fn(),
    },
  },
}));

vi.mock("./useSettings", () => ({
  useSettings: () => ({
    envVars: {},
    settings: {
      providerSettings: mocks.providerSettings,
      selectedModel: mocks.selectedModel,
    },
  }),
}));

describe("useLanguageModelProviders", () => {
  beforeEach(() => {
    mocks.providerSettings = {};
    mocks.subscriptionLoading = false;
    mocks.subscription = {
      connected: false,
      pending: false,
      setupError: undefined as string | undefined,
      models: ["subscription-model"],
    };
    mocks.selectedModel = {
      provider: "ollama",
      name: "llama3",
    };
    mocks.useQueryResult = {
      data: undefined,
      isLoading: true,
    };
  });

  it("decides provider readiness from API keys without subscriptions", () => {
    mocks.selectedModel = { provider: "openai", name: "gpt-5" };
    mocks.useQueryResult.isLoading = false;
    // No key anywhere: not ready, even with a connected subscription.
    mocks.subscription.connected = true;
    const { result, rerender } = renderHook(() => useLanguageModelProviders());
    expect(result.current.isAnyProviderSetup()).toBe(false);
    // Adding the provider key makes it ready.
    mocks.providerSettings = { openai: { apiKey: { value: "k" } } };
    rerender();
    expect(result.current.isAnyProviderSetup()).toBe(true);
    expect(result.current.isProviderSetup("openai")).toBe(true);
  });
  it("treats a selected Ollama model as a configured provider while provider data is loading", () => {
    const { result } = renderHook(() => useLanguageModelProviders());

    expect(result.current.isAnyProviderSetup()).toBe(true);
  });

  it("treats a selected LM Studio model as a configured provider", () => {
    mocks.selectedModel = {
      provider: "lmstudio",
      name: "local-model",
    };

    const { result } = renderHook(() => useLanguageModelProviders());

    expect(result.current.isAnyProviderSetup()).toBe(true);
  });
  it("ignores subscription state when deciding readiness", () => {
    mocks.selectedModel = { provider: "openai", name: "gpt-5" };
    mocks.subscription.connected = true;
    mocks.subscription.pending = true;
    const { result, rerender } = renderHook(() => useLanguageModelProviders());
    expect(result.current.isAnyProviderSetup()).toBe(false);
    mocks.subscription.pending = false;
    rerender();
    expect(result.current.isAnyProviderSetup()).toBe(false);
    expect(result.current.isProviderSetup("openai")).toBe(false);
    mocks.subscription.connected = false;
    rerender();
    expect(result.current.isAnyProviderSetup()).toBe(false);
  });
});

it.each([
  { provider: "auto", name: "auto" },
  { provider: "openai", name: "subscription-model" },
])("does not resume after incomplete subscription setup (%j)", (model) => {
  mocks.selectedModel = model;
  mocks.subscription.connected = true;
  mocks.subscription.setupError = "Catalog unavailable";
  mocks.useQueryResult.isLoading = false;
  const { result } = renderHook(() => useLanguageModelProviders());
  expect(result.current.isAnyProviderSetup()).toBe(false);
});
