import "@testing-library/jest-dom/vitest";
import { beforeEach, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SetupBanner } from "./SetupBanner";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  settingsLoading: false,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
}));
vi.mock("posthog-js/react", () => ({
  usePostHog: () => ({ capture: vi.fn() }),
}));
vi.mock("@/first_prompt/FirstPromptProvider", () => ({
  useFirstPromptSaga: () => ({ hasArmedPayload: true }),
}));
vi.mock("@/routes/settings/providers/$provider", () => ({
  providerSettingsRoute: { id: "/settings/providers/$provider" },
}));
vi.mock("@/hooks/useLanguageModelProviders", () => ({
  useLanguageModelProviders: () => ({
    isAnyProviderSetup: () => false,
    isLoading: false,
  }),
}));
vi.mock("@/hooks/useScrollAndNavigateTo", () => ({
  useScrollAndNavigateTo: () => mocks.navigate,
}));
vi.mock("@/hooks/useSettings", () => ({
  useSettings: () => ({
    settings: mocks.settingsLoading ? undefined : { providerSettings: {} },
  }),
}));
vi.mock("@/ipc/types", () => ({
  ipc: {
    system: { openExternalUrl: vi.fn() },
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.settingsLoading = false;
});
function setup() {
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <SetupBanner variant="dialog" />
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

it("offers OpenRouter and other providers without subscriptions", async () => {
  const user = setup();
  expect(
    screen.getByRole("button", { name: "OpenRouter OpenRouter Free" }),
  ).toBeVisible();
  expect(screen.getByText(/Your prompt is saved/)).toBeVisible();
  expect(screen.queryByText("ChatGPT subscription")).not.toBeInTheDocument();
  expect(screen.queryByText(/Pro trial/)).not.toBeInTheDocument();
  await user.click(
    screen.getByRole("button", { name: "OpenRouter OpenRouter Free" }),
  );
  expect(mocks.navigate).toHaveBeenCalledWith({
    to: "/settings/providers/$provider",
    params: { provider: "openrouter" },
  });
  await user.click(screen.getByRole("button", { name: "Other providers" }));
  expect(mocks.navigate).toHaveBeenCalled();
});

it("shows the API-key heading instead of Pro copy", () => {
  setup();
  expect(screen.getByText("Use your own API key")).toBeVisible();
});
