/**
 * Channel -> handler / listener maps populated by the `ipcMain` shim.
 *
 * The web server and `web/server/electron_shim.ts` must observe the *same*
 * maps, which they do because both resolve this module by absolute path (the
 * `electron` alias in `web/server/register.cjs` points at the shim, and the
 * shim imports this file directly).
 */

export type IpcHandler = (
  event: unknown,
  ...args: unknown[]
) => unknown | Promise<unknown>;

export const ipcHandlers = new Map<string, IpcHandler>();

export const ipcListeners = new Map<
  string,
  Array<(...args: unknown[]) => void>
>();

export function resetIpcRegistry(): void {
  ipcHandlers.clear();
  ipcListeners.clear();
}
