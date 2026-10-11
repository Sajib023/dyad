import { expect, it } from "vitest";
import type { UserSettings } from "./schemas";
import { getAuxiliarySettings } from "./auxiliaryModel";

it.each(["anthropic", "google", "ollama", "custom"])(
  "passes %s helper settings through unchanged (no Pro rerouting)",
  (provider) => {
    const settings = {
      providerSettings: { openai: { apiKey: { value: "user-key" } } },
      proModelUsage: "api-key",
      selectedModel: { provider, name: "chosen", connection: "api-key" },
    } as unknown as UserSettings;
    expect(getAuxiliarySettings(settings)).toBe(settings);
  },
);

it.each(["pro", "subscription", undefined] as const)(
  "ignores legacy billing source %s",
  (proModelUsage) => {
    const settings = { proModelUsage } as unknown as UserSettings;
    expect(getAuxiliarySettings(settings)).toBe(settings);
  },
);
