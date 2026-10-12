#!/usr/bin/env node
/**
 * CommonJS require hooks that let the Dyad main-process TypeScript sources run
 * under plain Node for the self-hosted web server.
 *
 * Started with:  node --enable-source-maps -r ./web/server/register.cjs ./web/server/main.ts
 *
 * What it does:
 *   1. Registers `require.extensions` loaders for `.ts/.tsx/.mts/.cts/.jsx`
 *      (and asset/markdown extensions) that transpile on demand with esbuild,
 *      cached on disk keyed by file mtime+size.
 *   2. Rewrites the `electron` specifier to `./electron_shim.ts`, so the whole
 *      main-process handler graph runs against the web shim.
 *   3. Applies the repo's tsconfig `paths` mappings (`@/*` -> `src/*`,
 *      `pg-schema-classifier` -> `packages/...`, and the `*` -> repo-root
 *      fallback) so bare specifiers resolve exactly as `tsgo` resolves them.
 *
 * Deliberately *not* bundling: running from the real source tree keeps every
 * `path.join(__dirname, ...)` resource lookup (drizzle migrations,
 * `worker/proxy_server.js`, worker bundles) resolving where the code expects.
 */
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const esbuild = require("esbuild");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SRC_ROOT = path.join(REPO_ROOT, "src");
const SHIM_PATH = path.resolve(__dirname, "electron_shim.ts");
const PTY_SHIM_PATH = path.resolve(__dirname, "pty_shim.ts");
const ELECTRON_LOG_ROOT = require.resolve("electron-log");

function hasWorkingNodePty() {
  const ptyDir = path.join(REPO_ROOT, "node_modules", "node-pty");
  const candidates = [
    path.join(ptyDir, "build", "Release", "pty.node"),
    path.join(ptyDir, "build", "Debug", "pty.node"),
    path.join(
      ptyDir,
      "prebuilds",
      `${process.platform}-${process.arch}`,
      "pty.node",
    ),
  ];
  return candidates.some((p) => fs.existsSync(p));
}

/** Bumped when the transform below changes, invalidating every cached file. */
const TRANSFORM_VERSION = "dyad-web-ts-1";

const CACHE_DIR = process.env.DYAD_WEB_TS_CACHE
  ? path.resolve(process.env.DYAD_WEB_TS_CACHE)
  : path.join(os.tmpdir(), "dyad-web-ts-cache");

const LOADERS = {
  ".ts": "ts",
  ".mts": "ts",
  ".cts": "ts",
  ".tsx": "tsx",
  ".js": "js",
  ".mjs": "js",
  ".cjs": "js",
  ".jsx": "jsx",
};

/** Extensions tried for extension-less specifiers, in order. */
const SOURCE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
];
const INDEX_NAMES = [
  "index.ts",
  "index.tsx",
  "index.mts",
  "index.js",
  "index.jsx",
  "index.cjs",
];

/** Static asset imports surface as their own path so callers can URL them. */
const ASSET_EXTENSIONS = [
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".css",
  ".md",
  ".txt",
  ".wasm",
  ".node",
];

let cacheReady = false;

function ensureCacheDir() {
  if (cacheReady) return;
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    cacheReady = true;
  } catch {
    cacheReady = false;
  }
}

function cachePathFor(filename, size, mtimeMs) {
  const digest = crypto
    .createHash("sha1")
    .update(`${TRANSFORM_VERSION}\0${filename}\0${size}\0${mtimeMs}`)
    .digest("hex");
  return path.join(CACHE_DIR, `${digest}.js`);
}

/**
 * `import.meta` has no meaning in CommonJS. The only main-process use is
 * `createRequire(import.meta.url)` in `safe_storage_legacy.ts`; rewriting it
 * here keeps that code path identical to the Vite/Electron build without
 * touching the source.
 */
function rewriteImportMeta(source) {
  if (!source.includes("import.meta")) return source;
  return source
    .replace(/import\.meta\.url/g, "__dyad_import_meta_url__")
    .replace(/\bimport\.meta\b/g, "({ url: __dyad_import_meta_url__ })");
}

function transpile(filename, source) {
  const stat = fs.statSync(filename);
  const useCache = process.env.DYAD_WEB_TS_CACHE !== "0";
  let cached;
  if (useCache) {
    ensureCacheDir();
    const cacheFile = cachePathFor(filename, stat.size, stat.mtimeMs);
    try {
      cached = fs.readFileSync(cacheFile, "utf8");
      return { code: cached, fromCache: true };
    } catch {
      // miss — fall through to a fresh transform
    }

    const transformed = esbuild.transformSync(rewriteImportMeta(source), {
      loader: LOADERS[path.extname(filename)] ?? "ts",
      format: "cjs",
      target: "node20",
      platform: "node",
      sourcefile: filename,
      sourcemap: "inline",
      jsx: "automatic",
      jsxImportSource: "react",
      logLevel: "silent",
      define: {
        __dyad_import_meta_url__: "__filename",
      },
    });

    try {
      fs.writeFileSync(cacheFile, transformed.code);
    } catch {
      // An unwritable cache is not fatal.
    }
    return { code: transformed.code, fromCache: false };
  }

  const transformed = esbuild.transformSync(rewriteImportMeta(source), {
    loader: LOADERS[path.extname(filename)] ?? "ts",
    format: "cjs",
    target: "node20",
    platform: "node",
    sourcefile: filename,
    sourcemap: "inline",
    jsx: "automatic",
    jsxImportSource: "react",
    logLevel: "silent",
    define: {
      __dyad_import_meta_url__: "__filename",
    },
  });
  return { code: transformed.code, fromCache: false };
}

function compileTypeScript(module, filename) {
  const source = fs.readFileSync(filename, "utf8");
  const { code } = transpile(filename, source);
  module._compile(code, filename);
}

// --- require.extensions loaders -------------------------------------------

for (const ext of [".ts", ".tsx", ".mts", ".cts", ".jsx"]) {
  Module._extensions[ext] = compileTypeScript;
}

for (const ext of ASSET_EXTENSIONS) {
  if (Module._extensions[ext]) continue;
  Module._extensions[ext] = (module, filename) => {
    if (ext === ".css" || ext === ".md" || ext === ".txt") {
      module.exports = fs.readFileSync(filename, "utf8");
      return;
    }
    if (ext === ".node") {
      // Native addons are loaded through process.dlopen in the default path;
      // reaching here means something required() one explicitly.
      process.dlopen(
        module,
        path._makeLong ? path._makeLong(filename) : filename,
      );
      return;
    }
    module.exports = filename;
  };
}

// --- specifier mapping -----------------------------------------------------

/** tsconfig `paths` (see tsconfig.json) applied in declaration order. */
const PATH_MAPPINGS = [
  { prefix: "@/", to: (rest) => path.join(SRC_ROOT, rest) },
  {
    prefix: "pg-schema-classifier/",
    to: (rest) =>
      path.join(REPO_ROOT, "packages", "pg-schema-classifier", "src", rest),
  },
  {
    prefix: "pg-schema-classifier",
    exact: true,
    to: () =>
      path.join(
        REPO_ROOT,
        "packages",
        "pg-schema-classifier",
        "src",
        "index.ts",
      ),
  },
  {
    prefix: "ts-pg-schema-diff/",
    to: (rest) =>
      path.join(REPO_ROOT, "packages", "ts-pg-schema-diff", "src", rest),
  },
  {
    prefix: "ts-pg-schema-diff",
    exact: true,
    to: () =>
      path.join(REPO_ROOT, "packages", "ts-pg-schema-diff", "src", "index.ts"),
  },
];

function fileExists(candidate) {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function directoryIndex(candidate) {
  try {
    if (!fs.statSync(candidate).isDirectory()) return null;
  } catch {
    return null;
  }
  for (const name of INDEX_NAMES) {
    const indexFile = path.join(candidate, name);
    if (fileExists(indexFile)) return indexFile;
  }
  return null;
}

/** Resolve `<base>` or `<base>.ts` style candidates to a concrete file. */
function resolveAsSourceFile(base) {
  if (fileExists(base)) return base;
  if (base.endsWith(path.sep) || base.endsWith("/")) {
    return directoryIndex(base);
  }
  for (const ext of SOURCE_EXTENSIONS) {
    if (fileExists(base + ext)) return base + ext;
  }
  // TypeScript-style ESM imports keep the emitted `.js` extension
  // (`./db/connect.js` -> `./db/connect.ts` on disk). Swap the extension
  // rather than appending one.
  const currentExt = path.extname(base);
  if (currentExt === ".js" || currentExt === ".mjs" || currentExt === ".cjs") {
    const stem = base.slice(0, -currentExt.length);
    for (const ext of [".ts", ".tsx", ".mts", ".cts"]) {
      if (fileExists(stem + ext)) return stem + ext;
    }
  }
  return directoryIndex(base);
}

function mapSpecifier(request) {
  if (request === "electron") return SHIM_PATH;
  if (request === "node-pty" && !hasWorkingNodePty()) return PTY_SHIM_PATH;
  // `electron-log/main` is the Electron-only entry (it assumes app ready);
  // under plain Node the package's own index selects the working `./node`
  // transport implementation instead.
  if (request === "electron-log/main") return ELECTRON_LOG_ROOT;

  for (const mapping of PATH_MAPPINGS) {
    if (mapping.exact) {
      if (request === mapping.prefix) return mapping.to();
      continue;
    }
    if (request.startsWith(mapping.prefix)) {
      return mapping.to(request.slice(mapping.prefix.length));
    }
  }
  return null;
}

/**
 * Vite lets importers append `?raw` / `?url` / `?inline` to asset imports.
 * Node's resolver has no notion of those suffixes; the extension loaders below
 * already produce the right value for every affected type (`.md`/`.txt` -> the
 * file's text, everything else -> its path), so stripping the suffix is
 * sufficient.
 */
const VITE_ASSET_QUERY =
  /\?(?:raw|url|inline|worker|sharedWorker|[a-zA-Z-]+=[^&]*)(&.*)?$/;

function stripViteQuery(request) {
  if (!request.includes("?")) return request;
  if (!VITE_ASSET_QUERY.test(request)) return request;
  return request.replace(VITE_ASSET_QUERY, "");
}

const originalResolveFilename = Module._resolveFilename;

Module._resolveFilename = function (request, parent, isMain, options) {
  request = stripViteQuery(request);
  const mapped = mapSpecifier(request);
  const effective = mapped ?? request;

  try {
    return originalResolveFilename.call(
      this,
      effective,
      parent,
      isMain,
      options,
    );
  } catch (error) {
    // 1. Extension/index resolution for our own source files.
    if (mapped) {
      const resolved = resolveAsSourceFile(mapped);
      if (resolved) return resolved;
    }

    // 2. tsconfig's `* -> ./*` mapping: bare specifiers that name a file in
    //    the repo (e.g. `shared/ports`, `worker/proxy_server.js`).
    if (!path.isAbsolute(effective) && !effective.startsWith(".")) {
      const fromRepoRoot = resolveAsSourceFile(path.join(REPO_ROOT, effective));
      if (fromRepoRoot) return fromRepoRoot;
    }

    // 3. Extension-less relative imports inside the repo.
    if (effective.startsWith(".") && parent?.filename) {
      const base = path.resolve(path.dirname(parent.filename), effective);
      const resolved = resolveAsSourceFile(base);
      if (resolved) return resolved;
    }

    throw error;
  }
};

// Exported for `main.ts` so it can report what is loaded.
module.exports = {
  REPO_ROOT,
  SRC_ROOT,
  stats() {
    return { cacheDir: CACHE_DIR, repoRoot: REPO_ROOT };
  },
};
