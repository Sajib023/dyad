import {
  getEffectiveDefaultChatMode,
  type ChatMode,
  type UserSettings,
} from "./schemas";

export function getHomeDefaultChatMode(
  settings: UserSettings,
  envVars: Record<string, string | undefined>,
): ChatMode {
  return getEffectiveDefaultChatMode(settings, envVars);
}
