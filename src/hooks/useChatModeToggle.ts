import { useCallback, useMemo } from "react";
import { useShortcut } from "./useShortcut";
import { usePostHog } from "posthog-js/react";
import { ChatModeSchema, type ChatMode } from "../lib/schemas";
import { useChatMode } from "./useChatMode";
import { useRouterState } from "@tanstack/react-router";
import { useSetAtom } from "jotai";
import { hasManuallySelectedChatModeAtom } from "@/atoms/chatAtoms";

export function getNextAvailableChatMode({
  currentMode,
  canUseBasicAgent,
  canUseBuild,
}: {
  currentMode: ChatMode;
  canUseBasicAgent: boolean;
  canUseBuild: boolean;
}): ChatMode {
  const modes = ChatModeSchema.options;
  const currentIndex = modes.indexOf(currentMode);

  for (let offset = 1; offset <= modes.length; offset += 1) {
    const candidate = modes[(currentIndex + offset) % modes.length];
    if (candidate === "local-agent" && !canUseBasicAgent) continue;
    if (candidate === "build" && !canUseBuild) continue;
    return candidate;
  }

  return currentMode;
}

export function useChatModeToggle() {
  const routerState = useRouterState();
  const routeChatId =
    routerState.location.pathname === "/chat"
      ? (routerState.location.search.id as number | undefined)
      : null;
  const { selectedMode, setChatMode, settings } = useChatMode(routeChatId);
  const setHasManuallySelectedChatMode = useSetAtom(
    hasManuallySelectedChatModeAtom,
  );
  const posthog = usePostHog();

  // Detect if user is on mac
  const isMac = useIsMac();

  // Memoize the modifiers object to prevent re-registration
  const modifiers = useMemo(
    () => ({
      ctrl: !isMac,
      meta: isMac,
    }),
    [isMac],
  );

  // Function to toggle between chat modes
  const toggleChatMode = useCallback(() => {
    if (!settings || !selectedMode) return;

    const currentMode = selectedMode;
    // No tiers anymore: every mode is always available.
    const newMode = getNextAvailableChatMode({
      currentMode,
      canUseBasicAgent: true,
      canUseBuild: true,
    });

    if (routeChatId == null) {
      setHasManuallySelectedChatMode(true);
    }
    void setChatMode(newMode).catch(() => {});
    posthog.capture("chat:mode_toggle", {
      from: currentMode,
      to: newMode,
      trigger: "keyboard_shortcut",
    });
  }, [
    selectedMode,
    setChatMode,
    settings,
    routeChatId,
    setHasManuallySelectedChatMode,
    posthog,
  ]);

  // Add keyboard shortcut with memoized modifiers
  useShortcut(
    ".",
    modifiers,
    toggleChatMode,
    true, // Always enabled since we're not dependent on component selector
  );

  return { toggleChatMode, isMac };
}

// Add this function at the top
type NavigatorWithUserAgentData = Navigator & {
  userAgentData?: {
    platform?: string;
  };
};

export function detectIsMac(): boolean {
  const nav = navigator as NavigatorWithUserAgentData;
  // Try modern API first
  if ("userAgentData" in nav && nav.userAgentData?.platform) {
    return nav.userAgentData.platform.toLowerCase().includes("mac");
  }

  // Fallback to user agent check
  return /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);
}
// Export the utility function and hook for use elsewhere
export function useIsMac(): boolean {
  return useMemo(() => detectIsMac(), []);
}
