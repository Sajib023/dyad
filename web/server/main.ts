/**
 * Entry point for the Dyad self-hosted web server.
 *
 *   node --enable-source-maps web/server/start.cjs
 *
 * Environment (all optional, defaults shown):
 *   PORT=3000                  TCP port
 *   HOST=0.0.0.0               bind address
 *   DYAD_WEB_RENDERER_DIR      static renderer bundle (default ./dist-web)
 *   DYAD_WEB_PUBLIC_ORIGIN     absolute origin the browser uses; drives the
 *                              renderer trust policy and preview URL rewrites
 *                              (default http://localhost:$PORT)
 *   DYAD_WEB_TOKEN             if set, every request/WS upgrade must present
 *                              it via ?token=, Authorization: Bearer or cookie
 *   DYAD_DEV_USER_DATA_DIR     sqlite + settings directory (default ./userData)
 *   HOME                       also determines the default `dyad-apps` folder
 */
import "./env";
import path from "node:path";
import { startWebServer } from "./app";

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? "0.0.0.0";
  const rendererDir = path.resolve(
    process.env.DYAD_WEB_RENDERER_DIR ?? "./dist-web",
  );
  const publicOrigin =
    process.env.DYAD_WEB_PUBLIC_ORIGIN ?? `http://localhost:${port}`;
  const token = process.env.DYAD_WEB_TOKEN?.trim() || null;

  await startWebServer({ port, host, rendererDir, publicOrigin, token });
}

main().catch((error) => {
  console.error("[dyad-web] failed to start", error);
  process.exit(1);
});
