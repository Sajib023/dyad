#!/usr/bin/env node
/**
 * Builds the auxiliary worker bundles the Dyad main process forks at runtime:
 *
 *   - code_explorer_worker.js          (codebase indexing / @dyad symbols)
 *   - supabase_dependency_analysis_worker.js
 *   - sandbox_worker.js                (SQL sandbox execution)
 *
 * Electron packaging emits these next to `main.js` in `.vite/build/`. The web
 * server runs from source, so `web/server/electron_shim.ts` looks for them in
 * `dist/` (this script's output) when resolving `utilityProcess.fork`.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const CONFIGS = [
  "vite.code-explorer-worker.config.mts",
  "vite.sandbox-worker.config.mts",
  "vite.supabase-dependency-analysis-worker.config.mts",
];

// Every worker config uses Vite's default `outDir: dist`, and Vite empties
// that directory before each build — so building them in sequence would leave
// only the last worker on disk. Build into a staging directory and move the
// results into `dist/` ourselves.
const stagingRoot = path.join(repoRoot, "dist-staging");
fs.rmSync(stagingRoot, { recursive: true, force: true });

CONFIGS.forEach((config, index) => {
  const outDir = path.join(stagingRoot, String(index));
  process.stdout.write(`building ${config} ... `);
  const result = spawnSync(
    process.execPath,
    [
      path.join(repoRoot, "node_modules", "vite", "bin", "vite.js"),
      "build",
      "--config",
      path.join(repoRoot, config),
      "--outDir",
      outDir,
    ],
    { cwd: repoRoot, stdio: "inherit" },
  );
  if (result.status !== 0) {
    console.error(`\nfailed: ${config}`);
    process.exit(result.status ?? 1);
  }
  console.log("ok");

  const distDir = path.join(repoRoot, "dist");
  fs.mkdirSync(distDir, { recursive: true });
  for (const entry of fs.readdirSync(outDir)) {
    fs.renameSync(path.join(outDir, entry), path.join(distDir, entry));
  }
});

fs.rmSync(stagingRoot, { recursive: true, force: true });

console.log("worker bundles written to dist/");
console.log(
  fs
    .readdirSync(path.join(repoRoot, "dist"))
    .filter((entry) => !entry.endsWith(".map"))
    .map((entry) => `  dist/${entry}`)
    .join("\n"),
);
