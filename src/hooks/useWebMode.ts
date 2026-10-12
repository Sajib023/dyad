import { useMemo } from "react";

/**
 * Returns `true` when the renderer is running in the self-hosted web build
 * (Docker container served over HTTP/HTTPS via `web/server/`) rather than the
 * Electron desktop app.
 *
 * The flag is installed by `web/renderer/ipc_client.ts` as
 * `window.electron.isWebBuild = true` before the renderer module graph
 * evaluates; in the desktop build the same property is `undefined` because
 * the Electron preload exposes only the IPC bridge.
 *
 * Use this to gate UI that only makes sense on the desktop (auto-update,
 * native file dialogs, multi-window, app-tests/recording, custom apps
 * folder, Node.js runtime installer, etc.).
 */
export function useWebMode(): boolean {
  return useMemo(() => {
    if (typeof window === "undefined") return false;
    const e = (window as unknown as { electron?: { isWebBuild?: boolean } })
      .electron;
    return e?.isWebBuild === true;
  }, []);
}
