import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { OnboardingChecklist } from "./OnboardingChecklist";

const mocks = vi.hoisted(() => ({
  isWebMode: false,
  settings: {} as Record<string, unknown>,
  updateSettings: vi.fn(),
  isAnyProviderSetup: vi.fn(() => false),
  providersLoading: false,
  apps: [] as unknown[],
  appsLoading: false,
}));

vi.mock("@/hooks/useWebMode", () => ({
  useWebMode: () => mocks.isWebMode,
}));

vi.mock("@/hooks/useSettings", () => ({
  useSettings: () => ({
    settings: mocks.settings,
    updateSettings: mocks.updateSettings,
  }),
}));

vi.mock("@/hooks/useLanguageModelProviders", () => ({
  useLanguageModelProviders: () => ({
    isAnyProviderSetup: mocks.isAnyProviderSetup,
    isLoading: mocks.providersLoading,
  }),
}));

vi.mock("@/hooks/useLoadApps", () => ({
  useLoadApps: () => ({
    apps: mocks.apps,
    loading: mocks.appsLoading,
  }),
}));

describe("OnboardingChecklist", () => {
  it("renders nothing when not in web mode", () => {
    mocks.isWebMode = false;
    const { container } = render(<OnboardingChecklist />);
    expect(container.firstChild).toBeNull();
  });

  it("renders checklist when in web mode and not dismissed", () => {
    mocks.isWebMode = true;
    mocks.settings = { webOnboarding: { dismissed: false } };
    render(<OnboardingChecklist />);
    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.getByText(/Getting started/)).toBeTruthy();
  });

  it("renders nothing when dismissed", () => {
    mocks.isWebMode = true;
    mocks.settings = { webOnboarding: { dismissed: true } };
    const { container } = render(<OnboardingChecklist />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when all steps are completed", () => {
    mocks.isWebMode = true;
    mocks.settings = {
      webOnboarding: {
        connectedProvider: true,
        createdFirstApp: true,
        ranFirstBuild: true,
        dismissed: false,
      },
    };
    const { container } = render(<OnboardingChecklist />);
    expect(container.firstChild).toBeNull();
  });
});
