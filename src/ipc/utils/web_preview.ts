/**
 * Web-mode preview URL mapping.
 *
 * Dyad's Electron shell loads an app preview on its own origin
 * (`http://app-<appId>.localhost:<proxyPort>`), which is what keeps the app's
 * root-absolute URLs and cookies isolated from the Dyad shell.
 *
 * A self-hosted web build cannot do that: `*.localhost` resolves to the
 * *browser's* loopback, and publishing one port per app is not a reasonable
 * requirement of a reverse proxy in front of the shell. Instead the web server
 * mounts each preview under a path prefix:
 *
 *     http://<dyad-origin>/__dyad_preview/<appId>/…
 *        → http://127.0.0.1:<proxyPort>/…   (Host: app-<appId>.localhost:<port>)
 *
 * `rewriteAppUrlForWeb` is the single choke point that swaps the URL Dyad
 * hands to the renderer for that path form. See `web/server/app.ts` for the
 * proxy that serves it.
 */

export const WEB_PREVIEW_PATH_PREFIX = "/__dyad_preview/";

/** True when Dyad runs behind `web/server` rather than Electron. */
export function isWebMode(): boolean {
  return process.env.DYAD_WEB === "1";
}

/** Absolute URL of the Dyad web shell, e.g. `http://localhost:3000`. */
export function getWebPublicOrigin(): string | undefined {
  const origin = String(process.env.DYAD_WEB_PUBLIC_ORIGIN ?? "")
    .trim()
    .replace(/\/+$/, "");
  return origin || undefined;
}

/** Path prefix (no origin) under which an app's preview is mounted. */
export function getWebPreviewPath(appId: number): string {
  return `${WEB_PREVIEW_PATH_PREFIX}${appId}`;
}

/**
 * Rewrites a run URL for web mode. Outside web mode, or when the public origin
 * is not configured, the URL is returned unchanged.
 */
export function rewriteAppUrlForWeb(appUrl: string, appId: number): string {
  if (!isWebMode()) return appUrl;
  const origin = getWebPublicOrigin();
  if (!origin) return appUrl;
  return `${origin}${getWebPreviewPath(appId)}/`;
}
