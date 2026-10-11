#!/usr/bin/env node
/**
 * Launcher for the Dyad web server.
 *
 * Node loads a `.ts` entry point through its own ESM loader, which would
 * bypass the `require.extensions` hooks installed in `register.cjs`. Starting
 * from this CommonJS file means *every* TypeScript module in the graph —
 * including `main.ts` — goes through the esbuild require hook, so there is
 * exactly one module system in play.
 *
 *   node --enable-source-maps web/server/start.cjs
 */
"use strict";

require("./register.cjs");
require("./main.ts");
