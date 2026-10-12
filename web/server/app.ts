/**
 * Dyad self-hosted web server.
 *
 * Runs the real Dyad main-process (IPC handlers, sqlite, git, app runtime,
 * LLM streaming) in plain Node behind an HTTP server that serves the built
 * React renderer and bridges it over WebSocket using the same envelope
 * protocol `src/preload.ts` implements for Electron.
 *
 * Layout of this file:
 *   1. static renderer hosting (with SPA fallback)
 *   2. optional auth (DYAD_WEB_TOKEN)
 *   3. WebSocket IPC transport (`/ipc`)
 *   4. preview reverse proxy (`/__dyad_preview/<appId>/...`)
 *   5. bootstrap: trusted renderer -> database -> IPC handlers -> listen
 */
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { Duplex } from "node:stream";
import { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";

import { encode, decode } from "../shared/codec";
import { ipcHandlers, ipcListeners } from "./ipc_registry";
import {
  createClientEndpoint,
  liveClientEndpoints,
  unregisterClient,
  type WebClientEndpoint,
} from "./client_registry";
import { getAppProxyPort } from "../../shared/ports";

// `electron` resolves to web/server/electron_shim.ts (see register.cjs) — the
// imports below are the ones that register the whole main-process surface.
import { app as electronApp } from "electron";
import { registerIpcHandlers } from "@/ipc/ipc_host";
import { initializeDatabase, closeDatabase } from "@/db";
import { configureTrustedRenderer } from "@/ipc/utils/renderer_security";

const logger = {
  info: (...args: unknown[]) => console.log("[dyad-web]", ...args),
  warn: (...args: unknown[]) => console.warn("[dyad-web]", ...args),
  error: (...args: unknown[]) => console.error("[dyad-web]", ...args),
};

/** Monotonic wall clock for request timing. */
const SERVER_STARTED_AT_MS = Date.now();
const PROCESS_STARTED_AT_MS =
  typeof process.uptime === "function"
    ? Date.now() - process.uptime() * 1000
    : SERVER_STARTED_AT_MS;

/** Read package version once at startup so /healthz can surface it. */
function readVersion(): string {
  try {
    // The web server is started from the repo root, so package.json is the
    // workspace root's. The renderer also reads this, so they stay in sync.
    const pkg = require(path.join(process.cwd(), "package.json")) as {
      version?: string;
    };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}
const SERVER_VERSION = readVersion();

/**
 * Single-line access log. Format: `[dyad-web] METHOD /path → 200 (12ms)`.
 * Skips successful health checks so a 30s probe doesn't drown the log.
 */
function logRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  startNs: bigint,
): void {
  const status = res.statusCode;
  if (url.pathname === "/healthz" && status === 200) return;
  const ms = Number((process.hrtime.bigint() - startNs) / 1_000_000n);
  const method = req.method ?? "GET";
  // Truncate the path to keep one line readable.
  const path =
    url.pathname.length > 80 ? url.pathname.slice(0, 77) + "…" : url.pathname;
  const line = `${method} ${path} → ${status} (${ms}ms)`;
  if (status >= 500) logger.error(line);
  else if (status >= 400) logger.warn(line);
  else logger.info(line);
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
};

interface ServerOptions {
  port: number;
  host: string;
  rendererDir: string;
  publicOrigin: string;
  token: string | null;
}

// ---------------------------------------------------------------------------
// auth
// ---------------------------------------------------------------------------

const TOKEN_COOKIE = "dyad_web_token";
/** 30 days — long enough to survive a tunnel hostname change. */
const TOKEN_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

type TokenSource = "bearer" | "cookie" | "query" | null;

function readTokenSource(req: http.IncomingMessage): {
  value: string | null;
  source: TokenSource;
} {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) {
    return { value: header.slice("Bearer ".length), source: "bearer" };
  }
  const cookie = req.headers.cookie;
  if (cookie) {
    for (const part of cookie.split(";")) {
      const [name, ...rest] = part.trim().split("=");
      if (name === TOKEN_COOKIE) {
        return {
          value: decodeURIComponent(rest.join("=")),
          source: "cookie",
        };
      }
    }
  }
  const url = new URL(req.url ?? "/", "http://placeholder");
  const fromQuery = url.searchParams.get("token");
  return fromQuery
    ? { value: fromQuery, source: "query" }
    : { value: null, source: null };
}

function readToken(req: http.IncomingMessage): string | null {
  return readTokenSource(req).value;
}

function isAuthorized(
  req: http.IncomingMessage,
  token: string | null,
): boolean {
  if (!token) return true;
  return readToken(req) === token;
}

/**
 * True when the request arrived over TLS, including via a reverse proxy
 * (cloudflared sets `X-Forwarded-Proto: https`). Used to decide whether the
 * session cookie may carry the `Secure` attribute.
 */
function requestIsSecure(
  req: http.IncomingMessage,
  publicOrigin: string,
): boolean {
  if ((req.socket as { encrypted?: boolean }).encrypted === true) return true;
  const forwarded = req.headers["x-forwarded-proto"];
  if (
    typeof forwarded === "string" &&
    forwarded.split(",")[0]?.trim() === "https"
  ) {
    return true;
  }
  return publicOrigin.startsWith("https://");
}

/**
 * Persists a `?token=` visit as a cookie so the follow-up requests a page
 * makes (assets, XHR, the IPC WebSocket handshake) authenticate on their own.
 * Only called when the token arrived in the query string — a request that
 * already carried a cookie or bearer token needs no session established.
 */
function issueSessionCookie(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  token: string | null,
  publicOrigin: string,
): void {
  if (!token) return;
  const { value, source } = readTokenSource(req);
  if (source !== "query" || value !== token) return;
  const secure = requestIsSecure(req, publicOrigin) ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `${TOKEN_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${TOKEN_COOKIE_MAX_AGE}${secure}`,
  );
}

/**
 * Clears the session cookie. Used by `POST /auth/logout` to drop the
 * 30-day persistence when the user explicitly signs out.
 */
function clearSessionCookie(res: http.ServerResponse): void {
  // Max-Age=0 + Path=/ tells the browser to drop the cookie for the whole
  // site. Empty value covers older browsers that don't honor Max-Age.
  res.setHeader(
    "Set-Cookie",
    `${TOKEN_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
  );
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

// ---------------------------------------------------------------------------
// static renderer hosting
// ---------------------------------------------------------------------------

function resolveStaticFile(
  rendererDir: string,
  pathname: string,
): { filePath: string; isIndex: boolean } | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;

  const normalized = path.posix.normalize(decoded);
  const relative = normalized.replace(/^\/+/, "");
  const candidate = path.resolve(rendererDir, relative);
  if (
    candidate !== rendererDir &&
    !candidate.startsWith(rendererDir + path.sep)
  ) {
    return null;
  }

  try {
    const stat = fs.statSync(candidate);
    if (stat.isFile()) return { filePath: candidate, isIndex: false };
    if (stat.isDirectory()) {
      const indexFile = path.join(candidate, "index.html");
      if (fs.existsSync(indexFile)) {
        return { filePath: indexFile, isIndex: true };
      }
    }
  } catch {
    // fall through to SPA fallback
  }

  // SPA fallback: extension-less navigations render the shell.
  if (!path.extname(normalized)) {
    const indexFile = path.join(rendererDir, "index.html");
    if (fs.existsSync(indexFile)) {
      return { filePath: indexFile, isIndex: true };
    }
  }
  return null;
}

/**
 * Join a sub-path under a static root, rejecting any traversal attempts
 * (e.g. `../package.json`). Returns just the basename if the sub-path
 * tries to escape.
 */
function safeJoin(subPath: string): string {
  const normalized = path.posix.normalize(subPath).replace(/^\/+/, "");
  if (normalized.includes("..") || normalized.includes("\0")) {
    return path.basename(normalized);
  }
  return normalized;
}

/**
 * Serve a single, pre-resolved static file with the given cache directive.
 * Used for the public auth/landing HTML — these are bundled with the
 * server (not the renderer) and don't need path-rewriting or SPA fallback.
 */
function serveStaticFile(
  res: http.ServerResponse,
  absolutePath: string,
  options: { cacheControl?: string } = {},
): void {
  if (!fs.existsSync(absolutePath)) {
    sendJson(res, 404, { error: "Not found" });
    return;
  }
  const ext = path.extname(absolutePath).toLowerCase();
  const stat = fs.statSync(absolutePath);
  const headers: Record<string, string> = {
    "content-type": MIME_TYPES[ext] ?? "application/octet-stream",
    "content-length": String(stat.size),
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
  };
  if (options.cacheControl) headers["cache-control"] = options.cacheControl;
  res.writeHead(200, headers);
  fs.createReadStream(absolutePath).pipe(res);
}

function serveStatic(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  rendererDir: string,
): void {
  const url = new URL(req.url ?? "/", "http://placeholder");
  const resolved = resolveStaticFile(rendererDir, url.pathname);
  if (!resolved) {
    sendJson(res, 404, { error: "Not found" });
    return;
  }

  const ext = path.extname(resolved.filePath).toLowerCase();
  const headers: Record<string, string> = {
    "content-type": MIME_TYPES[ext] ?? "application/octet-stream",
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
  };

  if (resolved.isIndex) {
    headers["cache-control"] = "no-cache";
  } else if (url.pathname.startsWith("/assets/")) {
    headers["cache-control"] = "public, max-age=31536000, immutable";
  } else {
    headers["cache-control"] = "public, max-age=300";
  }

  const stat = fs.statSync(resolved.filePath);
  headers["content-length"] = String(stat.size);

  // ETag + Last-Modified for cheap 304 negotiation. Strong ETag based on
  // mtime+size — fine for a single-instance self-hosted build.
  const etag = `"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`;
  headers["etag"] = etag;
  headers["last-modified"] = stat.mtime.toUTCString();
  if (
    req.headers["if-none-match"] === etag ||
    (req.headers["if-modified-since"] &&
      new Date(req.headers["if-modified-since"]).getTime() >=
        stat.mtime.getTime())
  ) {
    res.writeHead(304, headers);
    res.end();
    return;
  }

  res.writeHead(200, headers);
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  fs.createReadStream(resolved.filePath).pipe(res);
}

// ---------------------------------------------------------------------------
// preview reverse proxy
// ---------------------------------------------------------------------------

const PREVIEW_PREFIX = "/__dyad_preview/";

interface PreviewTarget {
  appId: number;
  restPath: string;
  port: number;
}

function parsePreviewTarget(pathname: string): PreviewTarget | null {
  if (!pathname.startsWith(PREVIEW_PREFIX)) return null;
  const remainder = pathname.slice(PREVIEW_PREFIX.length);
  const slash = remainder.indexOf("/");
  const idPart = slash === -1 ? remainder : remainder.slice(0, slash);
  if (!/^\d+$/.test(idPart)) return null;
  const appId = Number(idPart);
  if (!Number.isSafeInteger(appId) || appId <= 0) return null;
  const restPath = slash === -1 ? "/" : remainder.slice(slash);
  return { appId, restPath, port: getAppProxyPort(appId) };
}

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/**
 * Mirrors `needsInjection()` in `worker/proxy_server.js`: documents (routes
 * without a file extension, or `.html`) are the only responses that can carry
 * root-absolute URLs that need rewriting for the path-prefix proxy.
 */
function isPreviewDocumentPath(restPath: string): boolean {
  const pathname = restPath.split("?")[0] ?? "/";
  const ext = path.extname(pathname).toLowerCase();
  return ext === "" || ext === ".html";
}

/** Prefixes a root-absolute URL with the preview path. Leaves others alone. */
function withPreviewPrefix(value: string, prefix: string): string {
  if (!value.startsWith("/")) return value; // relative or absolute (http:, data:)
  if (value.startsWith("//")) return value; // protocol-relative
  if (value.startsWith(prefix)) return value; // already routed
  return prefix + value.slice(1);
}

const HTML_ATTR_URL_RE =
  /\b(src|href|poster|action|data-src|formaction)=("([^"]*)"|'([^']*)')/g;
const HTML_SRCSET_RE = /\bsrcset=("([^"]*)"|'([^']*)')/g;

/**
 * The Dyad app preview normally runs on its own origin (`app-<id>.localhost`),
 * so root-absolute URLs generated by Vite/Next resolve to the app itself. Over
 * the web path prefix they would resolve to the Dyad shell origin instead, so
 * rewrite root-absolute URL attributes in HTML documents to include the prefix.
 *
 * Deliberately limited to HTML attributes: rewriting arbitrary JavaScript is a
 * rabbit hole, and `fetch()` calls that use root-absolute paths are the one
 * documented limitation of path-based previews.
 */
function rewriteHtmlForPreview(html: string, prefix: string): string {
  let out = html.replace(
    HTML_ATTR_URL_RE,
    (match, attr, _quoted, double, single) => {
      const value = double ?? single ?? "";
      const rewritten = withPreviewPrefix(value, prefix);
      return rewritten === value ? match : `${attr}="${rewritten}"`;
    },
  );
  out = out.replace(HTML_SRCSET_RE, (match, _quoted, double, single) => {
    const value: string = double ?? single ?? "";
    const rewritten = value
      .split(",")
      .map((candidate: string) => {
        const trimmed = candidate.trim();
        if (!trimmed) return candidate;
        const space = trimmed.search(/\s/);
        const url = space === -1 ? trimmed : trimmed.slice(0, space);
        const descriptor = space === -1 ? "" : trimmed.slice(space);
        const next = withPreviewPrefix(url, prefix);
        return next === url ? candidate : `${next}${descriptor}`;
      })
      .join(",");
    return `srcset="${rewritten}"`;
  });
  return out;
}

function forwardPreviewRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  target: PreviewTarget,
): void {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) continue;
    if (value === undefined) continue;
    headers[key] = value;
  }
  // The preview proxy validates Host against `app-<id>.localhost`.
  headers.host = `app-${target.appId}.localhost:${target.port}`;

  // Buffer HTML so root-absolute asset URLs can be rewritten to the preview
  // path prefix. Everything else streams through untouched.
  const rewriteHtml =
    isPreviewDocumentPath(target.restPath) &&
    (req.method ?? "GET").toUpperCase() === "GET";
  if (rewriteHtml) {
    // Ask the upstream for uncompressed bytes; the preview proxy already
    // strips encoding when it injects, this makes it explicit.
    delete headers["accept-encoding"];
  }

  const requestPath =
    target.restPath +
    (req.url?.includes("?") ? req.url.slice(req.url.indexOf("?")) : "");

  const proxyReq = http.request(
    {
      host: "127.0.0.1",
      port: target.port,
      method: req.method,
      path: requestPath,
      headers,
    },
    (proxyRes) => {
      const outHeaders: Record<string, string | string[]> = {};
      for (const [key, value] of Object.entries(proxyRes.headers)) {
        if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) continue;
        if (value === undefined) continue;
        outHeaders[key] = value;
      }

      const prefixBase = `${PREVIEW_PREFIX}${target.appId}`;
      const prefix = `${prefixBase}/`;
      const location = outHeaders.location;
      if (typeof location === "string") {
        try {
          const upstreamOrigin = `http://app-${target.appId}.localhost:${target.port}`;
          const resolved = new URL(location, upstreamOrigin);
          if (resolved.origin === upstreamOrigin) {
            outHeaders.location =
              prefixBase + resolved.pathname + resolved.search;
          }
        } catch {
          // leave unparseable Location headers alone
        }
      }

      const contentTypeHeader = outHeaders["content-type"];
      const contentType = Array.isArray(contentTypeHeader)
        ? contentTypeHeader[0]
        : contentTypeHeader || "";
      const isHtml = rewriteHtml && contentType.includes("text/html");

      if (!isHtml) {
        res.writeHead(proxyRes.statusCode ?? 502, outHeaders);
        proxyRes.pipe(res);
        return;
      }

      const chunks: Buffer[] = [];
      proxyRes.on("data", (chunk: Buffer) => chunks.push(chunk));
      proxyRes.on("end", () => {
        if (res.headersSent) return;
        let html = Buffer.concat(chunks).toString("utf8");
        try {
          html = rewriteHtmlForPreview(html, prefix);
        } catch (error) {
          logger.warn(`preview html rewrite failed: ${String(error)}`);
        }
        const body = Buffer.from(html, "utf8");
        delete outHeaders["content-length"];
        delete outHeaders["content-encoding"];
        outHeaders["content-length"] = String(body.byteLength);
        res.writeHead(proxyRes.statusCode ?? 200, outHeaders);
        res.end(body);
      });
      proxyRes.on("error", () => res.destroy());
    },
  );

  proxyReq.on("error", (error) => {
    logger.warn(`preview proxy error for app ${target.appId}:`, error.message);
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    }
    res.end(
      `Dyad could not reach the preview server for app ${target.appId}.\n` +
        `Is the app running?\n`,
    );
  });

  req.pipe(proxyReq);
}

// ---------------------------------------------------------------------------
// WebSocket IPC transport
// ---------------------------------------------------------------------------

interface IpcConnection {
  ws: WebSocket;
  endpoint: WebClientEndpoint & { mainFrame: RendererFrame };
}

/**
 * A frame object shared by `event.senderFrame` and `event.sender.mainFrame`.
 *
 * `assertTrustedRenderer` requires the sender frame to *be* the main frame
 * (`src/ipc/utils/renderer_security.ts`), so both references must point at the
 * same object — exactly as Electron hands the same `WebFrameMain` to both.
 */
interface RendererFrame {
  url: string;
}

interface IpcInvokeEvent {
  sender: WebClientEndpoint & { mainFrame: RendererFrame };
  senderFrame: RendererFrame;
  senderMainFrame: RendererFrame;
}

function makeFrame(publicOrigin: string): RendererFrame {
  return { url: `${publicOrigin}/` };
}

function wireIpcConnection(ws: WebSocket, publicOrigin: string): IpcConnection {
  const frame = makeFrame(publicOrigin);
  const endpoint = createClientEndpoint((channel, args) => {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify(encode({ t: "e", ch: channel, args })));
  }) as WebClientEndpoint & { mainFrame: RendererFrame };
  endpoint.mainFrame = frame;

  // Track last-seen activity to close idle sockets (and any reverse proxies
  // along the way) before they get killed externally.
  const IDLE_TIMEOUT_MS = 90_000;
  let lastSeen = Date.now();
  const idleTimer = setInterval(() => {
    if (Date.now() - lastSeen > IDLE_TIMEOUT_MS) {
      try {
        ws.terminate();
      } catch {
        // ignore
      }
      clearInterval(idleTimer);
    }
  }, 30_000);
  const touch = () => {
    lastSeen = Date.now();
  };
  ws.on("message", (raw) => {
    touch();
    void handleIpcMessage(ws, endpoint, raw.toString(), publicOrigin);
  });

  ws.on("close", () => {
    clearInterval(idleTimer);
    unregisterClient(endpoint);
  });

  ws.on("error", () => {
    clearInterval(idleTimer);
    unregisterClient(endpoint);
  });

  return { ws, endpoint };
}

async function handleIpcMessage(
  ws: WebSocket,
  endpoint: WebClientEndpoint,
  raw: string,
  publicOrigin: string,
): Promise<void> {
  // Heartbeat frame: `{"t":"p"}` — pure transport liveness, no payload,
  // bypasses the JSON codec. Reply immediately with the same frame so the
  // client knows the round trip is healthy.
  if (raw === '{"t":"p"}') {
    if (ws.readyState === ws.OPEN) {
      try {
        ws.send('{"t":"p"}');
      } catch {
        // ignore
      }
    }
    return;
  }

  let frame: Record<string, unknown>;
  try {
    frame = decode(JSON.parse(raw)) as Record<string, unknown>;
  } catch {
    return;
  }

  const type = frame.t;
  const channel = typeof frame.ch === "string" ? frame.ch : null;
  if (type !== "i" && type !== "s" && type !== "p") return;
  if (type === "p") {
    // A ping wrapped through the codec — reply with a pong.
    if (ws.readyState === ws.OPEN) {
      try {
        ws.send(JSON.stringify({ t: "p" }));
      } catch {
        // ignore
      }
    }
    return;
  }
  if (!channel) return;

  if (type === "s") {
    const listeners = ipcListeners.get(channel);
    if (!listeners?.length) return;
    const args = (frame.args as unknown[]) ?? [];
    const event = buildInvokeEvent(endpoint, publicOrigin);
    for (const listener of Array.from(listeners)) {
      try {
        listener(event, ...args);
      } catch (error) {
        logger.error(`ipcMain.on listener for "${channel}" threw`, error);
      }
    }
    return;
  }

  if (type === "i") {
    const id = typeof frame.id === "number" ? frame.id : null;
    if (id === null) return;
    const handler = ipcHandlers.get(channel);
    if (!handler) {
      reply(ws, id, false, undefined, {
        message: `No ipcMain handler registered for '${channel}'`,
        name: "Error",
      });
      return;
    }

    const args = (frame.args as unknown[]) ?? [];
    const event = buildInvokeEvent(endpoint, publicOrigin);
    try {
      const result = await handler(event, ...args);
      reply(ws, id, true, result);
    } catch (error) {
      reply(ws, id, false, undefined, serializeThrown(error));
    }
  }
}

function buildInvokeEvent(
  endpoint: WebClientEndpoint & { mainFrame?: RendererFrame },
  publicOrigin: string,
): IpcInvokeEvent {
  const frame = endpoint.mainFrame ?? makeFrame(publicOrigin);
  return {
    sender: endpoint as IpcInvokeEvent["sender"],
    senderFrame: frame,
    senderMainFrame: frame,
  };
}

function serializeThrown(error: unknown): {
  message: string;
  name?: string;
  kind?: string;
  stack?: string;
} {
  if (error instanceof Error) {
    const kind = (error as { kind?: unknown }).kind;
    return {
      message: error.message,
      name: error.name,
      kind: typeof kind === "string" ? kind : undefined,
      stack: error.stack,
    };
  }
  return { message: String(error) };
}

function reply(
  ws: WebSocket,
  id: number,
  ok: boolean,
  value?: unknown,
  error?: unknown,
): void {
  if (ws.readyState !== ws.OPEN) return;
  const payload = ok
    ? { t: "r", id, ok: true, v: value }
    : { t: "r", id, ok: false, e: error };
  try {
    ws.send(JSON.stringify(encode(payload)));
  } catch (transportError) {
    logger.error("failed to send IPC reply", transportError);
  }
}

function isSameOriginUpgrade(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin;
  // Non-browser clients (curl, scripts) send no Origin header. Browsers always
  // do, and a cross-site page can never omit it — so requiring host equality
  // when present is the DNS-rebinding/CSWSH guard.
  if (!origin || origin === "null") return true;
  try {
    const originUrl = new URL(origin);
    const host = req.headers.host;
    if (!host) return false;
    return originUrl.host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// server
// ---------------------------------------------------------------------------

export async function startWebServer(
  options: ServerOptions,
): Promise<http.Server> {
  const { port, host, rendererDir, publicOrigin, token } = options;

  logger.info(`renderer bundle: ${rendererDir}`);
  if (!fs.existsSync(path.join(rendererDir, "index.html"))) {
    throw new Error(
      `Renderer bundle not found at ${rendererDir}. Build it with: npm run build:web`,
    );
  }

  // Trust policy must be configured before any IPC handler runs. The fake
  // invoke events below always present this origin, and the WebSocket upgrade
  // independently requires a same-origin Origin header.
  configureTrustedRenderer({
    devServerUrl: publicOrigin,
    packagedRendererUrl: "file:///dyad/renderer/index.html",
  });

  initializeDatabase();
  logger.info("database ready");

  registerIpcHandlers();
  logger.info(`ipc handlers registered: ${ipcHandlers.size}`);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://placeholder");
    const startNs = process.hrtime.bigint();

    // /healthz is a liveness probe; never let auth or rate limiting gate it.
    if (url.pathname === "/healthz") {
      sendJson(res, 200, {
        ok: true,
        clients: liveClientEndpoints().length,
        handlers: ipcHandlers.size,
        uptimeSeconds: Math.round((Date.now() - SERVER_STARTED_AT_MS) / 1000),
        version: SERVER_VERSION,
        nodeVersion: process.version,
        processStartedAt: new Date(PROCESS_STARTED_AT_MS).toISOString(),
      });
      logRequest(req, res, url, startNs);
      return;
    }

    // POST /auth/logout — drop the session cookie and redirect home.
    // Allowed regardless of auth state so the user can always sign out.
    if (url.pathname === "/auth/logout") {
      if (req.method !== "POST") {
        sendJson(res, 405, { error: "Method not allowed" });
        logRequest(req, res, url, startNs);
        return;
      }
      clearSessionCookie(res);
      res.writeHead(303, {
        location: token ? "/auth/" : "/",
        "content-length": "0",
      });
      res.end();
      logRequest(req, res, url, startNs);
      return;
    }

    // /auth without trailing slash redirects to /auth/ so relative assets resolve
    if (url.pathname === "/auth") {
      res.writeHead(302, { location: "/auth/", "content-length": "0" });
      res.end();
      logRequest(req, res, url, startNs);
      return;
    }

    // /auth/ and /auth/index.html are public — they're the sign-in page.
    if (url.pathname === "/auth/" || url.pathname === "/auth/index.html") {
      serveStaticFile(
        res,
        path.join(process.cwd(), "web/server/static/auth/index.html"),
        {
          cacheControl: "no-cache",
        },
      );
      logRequest(req, res, url, startNs);
      return;
    }
    if (url.pathname.startsWith("/auth/")) {
      serveStaticFile(
        res,
        path.join(
          process.cwd(),
          "web/server/static/auth",
          safeJoin(url.pathname.slice("/auth/".length)),
        ),
        { cacheControl: "public, max-age=300" },
      );
      logRequest(req, res, url, startNs);
      return;
    }
    if (url.pathname === "/auth.css") {
      serveStaticFile(
        res,
        path.join(process.cwd(), "web/server/static/auth/auth.css"),
        { cacheControl: "public, max-age=300" },
      );
      logRequest(req, res, url, startNs);
      return;
    }

    // /welcome without trailing slash redirects to /welcome/
    if (url.pathname === "/welcome") {
      res.writeHead(302, { location: "/welcome/", "content-length": "0" });
      res.end();
      logRequest(req, res, url, startNs);
      return;
    }

    // /welcome/ is the public marketing landing. When token auth is *off*,
    // also serve it at the root `/` for first-time visitors unless they passed ?token=
    // or ?app= to open the app.
    const wantsLanding =
      url.pathname === "/welcome/" || url.pathname === "/welcome/index.html";
    const isRootNav = url.pathname === "/" || url.pathname === "/index.html";
    const hasTokenQuery = url.searchParams.has("token");
    if (wantsLanding || (isRootNav && !token && !hasTokenQuery)) {
      serveStaticFile(
        res,
        path.join(process.cwd(), "web/server/static/landing/index.html"),
        { cacheControl: "no-cache" },
      );
      logRequest(req, res, url, startNs);
      return;
    }
    if (url.pathname.startsWith("/welcome/")) {
      serveStaticFile(
        res,
        path.join(
          process.cwd(),
          "web/server/static/landing",
          safeJoin(url.pathname.slice("/welcome/".length)),
        ),
        { cacheControl: "public, max-age=300" },
      );
      logRequest(req, res, url, startNs);
      return;
    }
    if (url.pathname === "/landing.css") {
      serveStaticFile(
        res,
        path.join(process.cwd(), "web/server/static/landing/landing.css"),
        { cacheControl: "public, max-age=300" },
      );
      logRequest(req, res, url, startNs);
      return;
    }

    try {
      if (!isAuthorized(req, token)) {
        // For browser navigation requests (no extension, GET) return the
        // sign-in HTML so the user sees a real page instead of a JSON 401.
        const isNavigation =
          (req.method ?? "GET") === "GET" && !path.extname(url.pathname);
        if (isNavigation) {
          // Issue a redirect so the URL reflects the auth surface.
          res.writeHead(302, {
            location: "/auth/",
            "content-length": "0",
          });
          res.end();
          logRequest(req, res, url, startNs);
          return;
        }
        sendJson(res, 401, { error: "Unauthorized" });
        logRequest(req, res, url, startNs);
        return;
      }

      // A `?token=` visit becomes a cookie so asset/XHR/WS follow-ups
      // authenticate without re-appending the query string.
      issueSessionCookie(req, res, token, publicOrigin);

      if (url.pathname.startsWith(PREVIEW_PREFIX)) {
        const target = parsePreviewTarget(url.pathname);
        if (!target) {
          sendJson(res, 400, { error: "Invalid preview target" });
          logRequest(req, res, url, startNs);
          return;
        }
        forwardPreviewRequest(req, res, target);
        // Preview requests are streamed; the access log will record on
        // response close. Forward through to the standard log path.
        res.on("close", () => logRequest(req, res, url, startNs));
        return;
      }

      if (req.method !== "GET" && req.method !== "HEAD") {
        sendJson(res, 405, { error: "Method not allowed" });
        logRequest(req, res, url, startNs);
        return;
      }

      serveStatic(req, res, rendererDir);
      logRequest(req, res, url, startNs);
    } catch (error) {
      logger.error("request handler failed", error);
      if (!res.headersSent) {
        sendJson(res, 500, { error: "Internal server error" });
      } else {
        res.end();
      }
      logRequest(req, res, url, startNs);
    }
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://placeholder");

    if (url.pathname === "/ipc") {
      if (!isAuthorized(req, token) || !isSameOriginUpgrade(req)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wireIpcConnection(ws, publicOrigin);
      });
      return;
    }

    const preview = parsePreviewTarget(url.pathname);
    if (preview) {
      proxyPreviewUpgrade(req, socket, head, preview);
      return;
    }

    socket.destroy();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo | null;
  logger.info(`listening on http://${host}:${address?.port ?? port}`);
  logger.info(`public origin: ${publicOrigin}`);
  if (token) logger.info("token auth enabled");

  installShutdownHandlers(server);
  return server;
}

function proxyPreviewUpgrade(
  req: http.IncomingMessage,
  socket: net.Socket | Duplex,
  head: Buffer,
  target: PreviewTarget,
): void {
  const headers: string[] = [];
  for (const [key, value] of Object.entries(req.headers)) {
    if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) continue;
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.push(`${key}: ${item}`);
    } else {
      headers.push(`${key}: ${value}`);
    }
  }
  // Replace the Host header with the preview proxy's expected hostname.
  const filtered = headers.filter((line) => !/^host:/i.test(line));
  filtered.push(`host: app-${target.appId}.localhost:${target.port}`);

  const upstream = net.connect(target.port, "127.0.0.1", () => {
    const requestPath =
      target.restPath +
      (req.url?.includes("?") ? req.url.slice(req.url.indexOf("?")) : "");
    upstream.write(
      `${req.method ?? "GET"} ${requestPath} HTTP/1.1\r\n${filtered.join("\r\n")}\r\n\r\n`,
    );
    if (head?.length) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });

  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
}

function installShutdownHandlers(server: http.Server): void {
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`received ${signal}, shutting down`);
    server.close(() => {
      try {
        closeDatabase();
      } catch (error) {
        logger.warn("database close failed", error);
      }
      process.exit(0);
    });
    // Hard deadline: spawned dev servers may hold the loop open.
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("uncaughtException", (error) => {
    logger.error("uncaught exception", error);
  });
  process.on("unhandledRejection", (reason) => {
    logger.error("unhandled rejection", reason);
  });
}

export { electronApp };
