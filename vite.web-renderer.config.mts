import fs from "node:fs";
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const ReactCompilerConfig = {};

/**
 * Vite config for the self-hosted web build of Dyad.
 *
 * Identical to `vite.renderer.config.mts` (which builds the Electron
 * renderer) except that the entry HTML is `index.web.html`, which additionally
 * loads `web/renderer/ipc_client.ts` — the WebSocket replacement for
 * `src/preload.ts` — before `src/renderer.tsx`.
 *
 * Output is normalised to `dist-web/index.html` so the web server can serve a
 * root-relative SPA without caring which entry HTML was used.
 */
function renameHtmlEntry(): Plugin {
  return {
    name: "dyad-rename-web-entry",
    closeBundle() {
      const outDir = path.resolve(__dirname, "dist-web");
      const from = path.join(outDir, "index.web.html");
      const to = path.join(outDir, "index.html");
      if (fs.existsSync(from)) {
        fs.renameSync(from, to);
      }
    },
  };
}

export default defineConfig({
  plugins: [
    react({
      babel: {
        plugins: [["babel-plugin-react-compiler", ReactCompilerConfig]],
      },
    }),
    tailwindcss(),
    renameHtmlEntry(),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    outDir: "dist-web",
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
    rollupOptions: {
      input: path.resolve(__dirname, "index.web.html"),
    },
  },
});
