import { useState, useCallback } from "react";
import { useSettings } from "@/hooks/useSettings";
import { detectIsMac } from "@/hooks/useChatModeToggle";
import { useWebMode } from "@/hooks/useWebMode";

function sendTestNotification() {
  if (
    typeof window.Notification !== "undefined" &&
    window.Notification.permission === "granted"
  ) {
    new window.Notification("Dyad", {
      body: "Notifications are working! You'll be notified when responses finish or input is needed.",
    });
  }
}

export function useEnableNotifications() {
  const { settings, updateSettings } = useSettings();
  const [showMacGuide, setShowMacGuide] = useState(false);
  const isEnabled = settings?.enableChatEventNotifications === true;
  const isMac = detectIsMac();
  const isWebMode = useWebMode();
  const openMacGuide = useCallback(() => {
    // Self-hosted web: macOS System Settings instructions don't apply.
    if (isMac && !isWebMode) {
      setShowMacGuide(true);
    }
  }, [isMac, isWebMode]);

  const enable = useCallback(async () => {
    if (typeof window.Notification === "undefined") return;
    if (window.Notification.permission === "denied") {
      openMacGuide();
      return;
    }
    if (window.Notification.permission === "default") {
      const permission = await window.Notification.requestPermission();
      if (permission !== "granted") {
        openMacGuide();
        return;
      }
    }
    await updateSettings({ enableChatEventNotifications: true });
    sendTestNotification();
    openMacGuide();
  }, [updateSettings, openMacGuide]);

  const disable = useCallback(async () => {
    await updateSettings({ enableChatEventNotifications: false });
  }, [updateSettings]);

  return { isEnabled, enable, disable, showMacGuide, setShowMacGuide };
}
