import { useSettings } from "@/hooks/useSettings";
import { useWebMode } from "@/hooks/useWebMode";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { ipc } from "@/ipc/types";
import { useTranslation } from "react-i18next";

export function AutoUpdateSwitch() {
  const { settings, updateSettings } = useSettings();
  const { t } = useTranslation("settings");
  const isWebMode = useWebMode();

  if (isWebMode) {
    // Self-hosted web build: the Electron updater doesn't run here.
    return null;
  }

  if (!settings) {
    return null;
  }

  return (
    <div className="flex items-center space-x-2">
      <Switch
        id="enable-auto-update"
        aria-label="Auto-update"
        checked={settings.enableAutoUpdate}
        onCheckedChange={(checked) => {
          updateSettings({ enableAutoUpdate: checked });
          toast("Auto-update settings changed", {
            description:
              "You will need to restart Dyad for your settings to take effect.",
            action: {
              label: "Restart Dyad",
              onClick: () => {
                ipc.system.restartDyad();
              },
            },
          });
        }}
      />
      <Label htmlFor="enable-auto-update">{t("general.autoUpdate")}</Label>
    </div>
  );
}
