import { describe, expect, it, vi, beforeAll, afterAll } from "vitest";
import http from "node:http";
import path from "node:path";
import fs from "node:fs";

vi.mock("electron", async () => {
  return await import("../../web/server/electron_shim");
});

vi.mock("@/db", () => ({
  initializeDatabase: vi.fn(),
  closeDatabase: vi.fn(),
}));

vi.mock("@/ipc/ipc_host", () => ({
  registerIpcHandlers: vi.fn(),
}));

import { startWebServer } from "../../web/server/app";

function nodeRequest(
  urlStr: string,
  options: { method?: string; headers?: Record<string, string> } = {},
): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
  json: <T = unknown>() => T;
}> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const req = http.request(
      url,
      {
        method: options.method ?? "GET",
        headers: options.headers,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            text: body,
            json: <T>() => JSON.parse(body) as T,
          });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("Dyad web server HTTP routes", () => {
  let server: http.Server;
  let baseUrl: string;
  const rendererDir = path.resolve(process.cwd(), "dist-web");

  beforeAll(async () => {
    if (!fs.existsSync(path.join(rendererDir, "index.html"))) {
      fs.mkdirSync(rendererDir, { recursive: true });
      fs.writeFileSync(
        path.join(rendererDir, "index.html"),
        "<html>Mock</html>",
      );
    }

    server = await startWebServer({
      port: 0,
      host: "127.0.0.1",
      rendererDir,
      publicOrigin: "http://127.0.0.1",
      token: "test-secret-token",
    });

    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("serves /healthz with system information unauthenticated", async () => {
    const res = await nodeRequest(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    const data = res.json<{
      ok: boolean;
      version: string;
      nodeVersion: string;
    }>();
    expect(data.ok).toBe(true);
    expect(data.nodeVersion).toBe(process.version);
    expect(data.version).toBeDefined();
  });

  it("handles POST /auth/logout by clearing session cookie and redirecting to /auth/", async () => {
    const res = await nodeRequest(`${baseUrl}/auth/logout`, {
      method: "POST",
    });
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe("/auth/");
    const setCookie = res.headers["set-cookie"]?.[0] ?? "";
    expect(setCookie).toContain("dyad_web_token=;");
  });

  it("rejects non-POST to /auth/logout with 405", async () => {
    const res = await nodeRequest(`${baseUrl}/auth/logout`, { method: "GET" });
    expect(res.status).toBe(405);
  });

  it("serves public /auth/ landing unauthenticated", async () => {
    const res = await nodeRequest(`${baseUrl}/auth/`);
    expect(res.status).toBe(200);
    expect(res.text).toContain("Dyad");
  });

  it("serves public /welcome/ page unauthenticated", async () => {
    const res = await nodeRequest(`${baseUrl}/welcome/`);
    expect(res.status).toBe(200);
    expect(res.text).toContain("Dyad");
  });

  it("redirects browser navigation to /auth/ when unauthenticated", async () => {
    const res = await nodeRequest(`${baseUrl}/apps`, {
      headers: { Accept: "text/html" },
    });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/auth/");
  });

  it("returns 401 JSON for unauthenticated API requests", async () => {
    const res = await nodeRequest(`${baseUrl}/apps.json`, {
      headers: { Accept: "application/json" },
    });
    expect(res.status).toBe(401);
    const data = res.json<{ error: string }>();
    expect(data.error).toBe("Unauthorized");
  });

  it("authenticates requests with Bearer token", async () => {
    const res = await nodeRequest(`${baseUrl}/index.html`, {
      headers: { Authorization: "Bearer test-secret-token" },
    });
    expect(res.status).toBe(200);
  });

  it("supports ETag 304 caching for static assets", async () => {
    const firstRes = await nodeRequest(`${baseUrl}/index.html`, {
      headers: { Authorization: "Bearer test-secret-token" },
    });
    expect(firstRes.status).toBe(200);
    const etag = firstRes.headers.etag;
    expect(etag).toBeTruthy();

    const secondRes = await nodeRequest(`${baseUrl}/index.html`, {
      headers: {
        Authorization: "Bearer test-secret-token",
        "If-None-Match": etag!,
      },
    });
    expect(secondRes.status).toBe(304);
  });
});
