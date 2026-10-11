# Self-hosting Dyad on the web

This fork runs Dyad — the AI app builder — as a self-hosted web service instead
of an Electron desktop app. The Dyad **main process** (IPC handlers, sqlite
database, git, app runtime, preview proxy) runs unchanged under plain Node.js;
the **renderer** is built as a static SPA and talks to the main process over a
WebSocket that mimics `ipcRenderer`.

The desktop app remains the primary product. This is an additional deployment
mode for people who want Dyad on a server, a NAS, or a small VM.

## Quick start (Docker)

```sh
docker compose up -d --build
# open http://localhost:3000
```

That's it. All state (settings, sqlite database, generated apps, managed
runtimes, encrypted secrets) lives in the `dyad-data` volume mounted at
`/data`.

To use it from another machine, set the public origin so preview URLs and the
WebSocket endpoint point at the host you actually browse with:

```sh
DYAD_WEB_PUBLIC_ORIGIN=http://192.168.1.50:3000 docker compose up -d
```

### Protecting the instance

Set a shared secret to gate the whole UI:

```sh
DYAD_WEB_TOKEN=$(openssl rand -hex 24) docker compose up -d
```

Then browse `http://localhost:3000/?token=<value>` once — the token is stored
in a cookie and subsequent requests are authorized automatically. API keys
saved in **Settings → API keys** are encrypted with a key derived from the
token (when set) or from a key file inside the data volume.

> Set `DYAD_WEB_PUBLIC_ORIGIN` to an **HTTPS** URL and put a TLS terminator in
> front of Dyad for anything that is not a private LAN. Session cookies are
> `Secure` when the origin is https.

## Exposing it publicly (tunnel)

On a headless VM `localhost` is only reachable from the VM itself. The
quickest way to get a public HTTPS URL is a [Cloudflare quick tunnel]
(`cloudflared`), which needs no account or DNS setup:

```sh
sudo dpkg -i cloudflared-linux-amd64.deb   # from cloudflare/cloudflared releases
cloudflared tunnel --url http://127.0.0.1:3000 --no-autoupdate
```

It prints an `https://<random>.trycloudflare.com` URL. Quick tunnels get a
**new hostname on every restart**, so `DYAD_WEB_PUBLIC_ORIGIN` has to follow
it — otherwise preview URLs and the `frame-ancestors` CSP point at a stale
origin. The included wrapper does that bookkeeping:

```sh
/home/sajib/dyad-tunnel/run-tunnel.sh
```

It starts the tunnel, scrapes the hostname, recreates the `dyad-web` container
with `DYAD_WEB_PUBLIC_ORIGIN` set to that URL, and writes the token to
`/home/sajib/dyad-tunnel/web-token`. A systemd unit keeps it alive across
reboots:

```sh
sudo systemctl enable --now dyad-tunnel.service
systemctl status dyad-tunnel.service
cat /home/sajib/dyad-tunnel/tunnel-url.txt     # current public URL
cat /home/sajib/dyad-tunnel/web-token          # access token
# open <url>/?token=<token>
```

Notes:

- The container is bound to `127.0.0.1:3000` in this setup, so the only way in
  is through the tunnel — the app is never directly exposed on the VM's
  interfaces.
- A `?token=` visit sets an `HttpOnly; SameSite=Lax; Secure` cookie (30 days),
  so assets, XHR and the IPC WebSocket authenticate on their own afterwards.
- The first visit must include `?token=`; without it you get `401`.
- Quick tunnel hostnames are ephemeral. For a stable URL, use a [named
  tunnel] with a domain you control, then set `DYAD_WEB_PUBLIC_ORIGIN` to it.

[Cloudflare quick tunnel]: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/use-cases/tunnel/try-cloudflared/
[named tunnel]: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/create-tunnel/

## How it works

| Desktop (Electron)                     | Web build                                            |
| -------------------------------------- | ---------------------------------------------------- |
| `src/index.ts` main process            | `web/server/main.ts` — same IPC handlers, plain Node |
| `electron` module                      | `web/server/electron_shim.ts` (require-hook alias)   |
| `ipcRenderer.invoke` over Electron IPC | `web/renderer/ipc_client.ts` over WebSocket          |
| `index.html` loaded from `file://`     | `dist-web/index.html` served as a static SPA         |
| `utilityProcess.fork`                  | `child_process.fork` of the same worker bundles      |
| Preview on `app-<id>.localhost:<port>` | Reverse proxy under `/__dyad_preview/<id>/…`         |

### Startup sequence

1. `web/server/register.cjs` installs require hooks so TypeScript sources load
   directly, and aliases `electron` to `web/server/electron_shim.ts`.
2. The shim is configured to trust the web origin as the renderer
   (`configureTrustedRenderer`), so the usual Electron security checks
   (`assertTrustedRenderer`) pass for IPC arriving over the WebSocket.
3. `registerIpcHandlers()` registers the ~330 real handlers, the database is
   opened and migrated, and the HTTP server starts.
4. The browser loads the SPA, opens `ws://<origin>/ipc`, and the bridge
   answers `ipcRenderer.invoke` / `on` from the page.

### Preview

Generated apps still run as local dev servers (Vite/Next on
`127.0.0.1:42100+`). Dyad's own preview proxy binds each app on
`app-<id>.localhost:<port>`; the web server reverse-proxies
`/__dyad_preview/<appId>/…` to that port (rewriting the `Host` header so the
preview proxy's origin check still holds) and rewrites root-absolute URLs in
HTML documents so Vite's `/assets/…` links resolve through the prefix.
WebSocket upgrades (HMR) are proxied the same way.

## Configuration

| Variable                 | Default                      | Purpose                                          |
| ------------------------ | ---------------------------- | ------------------------------------------------ |
| `PORT`                   | `3000`                       | HTTP port of the web server                      |
| `HOST`                   | `0.0.0.0`                    | Bind address                                     |
| `DYAD_WEB`               | `1`                          | Enables web mode (set by the image/compose file) |
| `DYAD_WEB_PUBLIC_ORIGIN` | `http://localhost:3000`      | Origin used for preview URLs and CSP             |
| `DYAD_WEB_TOKEN`         | _(unset)_                    | Optional shared secret gating the UI             |
| `DYAD_DEV_USER_DATA_DIR` | `/data/userData` (in Docker) | Where sqlite, settings and logs live             |
| `DYAD_HOME`              | `/data` (in Docker)          | Root for generated apps (`$DYAD_HOME/dyad-apps`) |
| `ANTHROPIC_API_KEY`, …   | _(unset)_                    | Provider keys, pass-through to the app runtime   |

Anything you would normally put in Dyad's settings file still works — the web
build reads and writes the same `userData` layout the desktop app uses.

## Running without Docker

```sh
npm ci
npm run build:web
npm run build:web-workers
npm run start:web
```

`start:web` runs `node web/server/start.cjs`, which sets `DYAD_WEB=1` and
`NODE_ENV=development` (required: the dev-user-data-dir override is only
honoured in development builds) unless you already set them.

## Known limitations

- **Preview path prefix.** Apps that call their own backend with
  root-absolute paths (`fetch("/api/…")`) resolve against the Dyad origin,
  not the app. HTML asset URLs are rewritten automatically; JavaScript is not.
  Workaround: use relative paths (`fetch("./api/…")`) or an absolute URL.
- **App tests / recording.** The Tests panel and the recording flow drive the
  preview on `app-<id>.localhost`, which only resolves on the same machine as
  the server. They are not supported through the web UI yet.
- **Desktop-only surfaces.** Native menus, tray icon, OS file dialogs (a
  headless file picker is substituted), auto-update and crash reporting are
  no-ops.
- **Resource use.** Every running app is a real Node dev server on the host.
  The container is not sandboxed; generated code runs as the container user.

## Troubleshooting

- `docker compose logs -f` — startup logs, including the number of IPC
  handlers registered.
- `GET /healthz` — returns `{"ok":true,"clients":N,"handlers":330}` once the
  server is ready.
- Missing worker bundles (`utilityProcess worker bundle not found`) mean
  `npm run build:web-workers` has not been run in this tree.
- Preview shows "Dyad could not reach the preview server for app N" — the app
  is not running yet; start it from the Dyad UI.
