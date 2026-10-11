/**
 * Environment defaults for the Dyad web server.
 *
 * Imported before any Dyad module (see `main.ts`) so that everything reading
 * `process.env` during module evaluation — most importantly
 * `src/paths/paths.ts`, which only honours `DYAD_DEV_USER_DATA_DIR` when
 * `NODE_ENV === "development"` — sees a consistent picture.
 *
 * Only applies defaults; values already present in the environment (Docker
 * `-e`, compose `environment:`, `.env`) always win.
 */
import path from "node:path";

process.env.NODE_ENV ??= "development";
process.env.DYAD_WEB ??= "1";
process.env.DYAD_DEV_USER_DATA_DIR ??= path.resolve("./userData");
