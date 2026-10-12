import { useEffect } from "react";
import { Check, X } from "lucide-react";
import { useSettings } from "@/hooks/useSettings";
import { useLanguageModelProviders } from "@/hooks/useLanguageModelProviders";
import { useLoadApps } from "@/hooks/useLoadApps";
import { useWebMode } from "@/hooks/useWebMode";
import { cn } from "@/lib/utils";

/**
 * A small horizontal "X / Y" pill shown at the top of the home page until
 * the user has completed all three first-run steps (or dismisses it). The
 * first two steps are observed from existing hooks; the third (ran first
 * build) is observed by `HomePage.handleSubmit`.
 *
 * Persistence: the checklist state is stored on the user-settings blob
 * under `webOnboarding` (added in `src/lib/schemas.ts`). That way a
 * returning user who has finished onboarding doesn't see it again.
 */
export function OnboardingChecklist() {
  const { settings, updateSettings } = useSettings();
  const isWebMode = useWebMode();
  const { isAnyProviderSetup, isLoading: providersLoading } =
    useLanguageModelProviders();
  const { apps, loading: appsLoading } = useLoadApps();

  // Pull the persisted slice. Falls back to all-false for a fresh install.
  const persisted = settings?.webOnboarding;
  const state = {
    connectedProvider: persisted?.connectedProvider || false,
    createdFirstApp: persisted?.createdFirstApp || false,
    ranFirstBuild: persisted?.ranFirstBuild || false,
    dismissed: persisted?.dismissed || false,
  };

  // Auto-mark steps the user has already completed. Done in an effect so
  // we don't call a state-mutating function during render. The condition
  // gates the write, so this is a no-op after the first time it fires.
  useEffect(() => {
    if (!isWebMode) return;
    if (providersLoading || state.connectedProvider) return;
    if (!isAnyProviderSetup()) return;
    void updateSettings({
      webOnboarding: { ...state, connectedProvider: true },
    });
    // We intentionally depend on the booleans, not the whole `state` object,
    // so we don't re-fire when the user closes the checklist.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    isWebMode,
    providersLoading,
    state.connectedProvider,
    isAnyProviderSetup,
  ]);

  useEffect(() => {
    if (!isWebMode) return;
    if (appsLoading || state.createdFirstApp) return;
    if (apps.length === 0) return;
    void updateSettings({
      webOnboarding: { ...state, createdFirstApp: true },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isWebMode, appsLoading, state.createdFirstApp, apps.length]);

  if (!isWebMode) return null;
  if (state.dismissed) return null;
  if (state.connectedProvider && state.createdFirstApp && state.ranFirstBuild) {
    return null;
  }

  const completedCount = [
    state.connectedProvider,
    state.createdFirstApp,
    state.ranFirstBuild,
  ].filter(Boolean).length;

  const steps = [
    {
      id: "provider",
      label: "Connect an AI provider",
      done: state.connectedProvider,
    },
    { id: "app", label: "Create your first app", done: state.createdFirstApp },
    { id: "build", label: "Run your first build", done: state.ranFirstBuild },
  ];

  return (
    <div
      className="mx-auto flex w-full max-w-3xl items-center justify-between gap-3 rounded-full border border-border bg-card/60 px-4 py-2 text-xs shadow-sm backdrop-blur supports-[backdrop-filter]:bg-card/40"
      role="status"
      aria-label="Onboarding progress"
    >
      <div className="flex items-center gap-3">
        <span className="font-medium text-foreground">
          Getting started · {completedCount}/3
        </span>
        <ul className="flex items-center gap-3 text-muted-foreground">
          {steps.map((step) => (
            <li
              key={step.id}
              className={cn(
                "flex items-center gap-1",
                step.done && "text-foreground line-through decoration-1",
              )}
            >
              {step.done ? (
                <Check className="size-3 text-primary" aria-hidden="true" />
              ) : (
                <span
                  className="inline-block size-1.5 rounded-full bg-muted-foreground/40"
                  aria-hidden="true"
                />
              )}
              {step.label}
            </li>
          ))}
        </ul>
      </div>
      <button
        type="button"
        onClick={() =>
          updateSettings({ webOnboarding: { ...state, dismissed: true } })
        }
        aria-label="Dismiss onboarding checklist"
        className="rounded-full p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
