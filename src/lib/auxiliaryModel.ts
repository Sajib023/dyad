import type { UserSettings } from "./schemas";

/** Retired: helper tasks used to be re-routed through Pro billing. Every
 * request uses the user's own key now, so helpers inherit settings unchanged.
 */
export function getAuxiliarySettings(settings: UserSettings): UserSettings {
  return settings;
}
