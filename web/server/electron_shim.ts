/**
 * Production `electron` module shim for the Dyad web server.
 *
 * The Dyad main process is written against Electron's API. Rather than fork
 * every handler, the web server runs the *real* handlers in plain Node and
 * resolves `import ... from "electron"` to this module (see the `electron`
 * alias in `web/server/register.cjs`).
 *
 * Scope: everything here is either
 *   (a) a faithful stand-in for the small slice of Electron the main process
 *       needs outside a GUI (ipcMain, app.getPath, safeStorage, utilityProcess),
 *   (b) a browser-facing fan-out (`BrowserWindow` -> connected WebSocket
 *       clients), or
 *   (c) an inert stub for UI-only surfaces (dialog, Menu, protocol, ...).
 *
 * This mirrors `src/testing/electron_mock.ts`, which proves the same surface is
 * enough to run the whole handler graph headlessly — but without the vitest
 * dependency and with a real file-backed `safeStorage`.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ipcHandlers, ipcListeners, type IpcHandler } from "./ipc_registry";
import { liveClientEndpoints, type WebClientEndpoint } from "./client_registry";

// ---------------------------------------------------------------------------
// app
// ---------------------------------------------------------------------------

function resolveUserDataDir(): string {
  const fromEnv = process.env.DYAD_DEV_USER_DATA_DIR?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  return path.resolve("./userData");
}

const appListeners = new Map<string, Array<(...args: unknown[]) => void>>();

const app = {
  on(event: string, listener: (...args: unknown[]) => void): void {
    const list = appListeners.get(event) ?? [];
    list.push(listener);
    appListeners.set(event, list);
  },
  once(event: string, listener: (...args: unknown[]) => void): void {
    const wrapped = (...args: unknown[]) => {
      const list = appListeners.get(event) ?? [];
      appListeners.set(
        event,
        list.filter((fn) => fn !== wrapped),
      );
      listener(...args);
    };
    app.on(event, wrapped);
  },
  removeListener(event: string, listener: (...args: unknown[]) => void): void {
    const list = appListeners.get(event);
    if (!list) return;
    appListeners.set(
      event,
      list.filter((fn) => fn !== listener),
    );
  },
  emit(event: string, ...args: unknown[]): void {
    for (const listener of Array.from(appListeners.get(event) ?? [])) {
      try {
        listener(...args);
      } catch (error) {
        console.error(
          `[electron-shim] app listener for "${event}" threw`,
          error,
        );
      }
    }
  },
  whenReady: () => Promise.resolve(),
  getPath(name: string): string {
    switch (name) {
      case "userData":
        return resolveUserDataDir();
      case "sessionData":
        return resolveUserDataDir();
      case "temp":
        return os.tmpdir();
      case "home":
        return os.homedir();
      case "logs":
        return path.join(resolveUserDataDir(), "logs");
      case "appData":
        return path.join(os.homedir(), ".config");
      default:
        return resolveUserDataDir();
    }
  },
  getAppPath(): string {
    return process.cwd();
  },
  getName(): string {
    return "dyad";
  },
  getVersion(): string {
    return process.env.npm_package_version ?? "1.0.0-web";
  },
  getLocale(): string {
    return "en-US";
  },
  getSystemLocale(): string {
    return "en-US";
  },
  getPreferredSystemLanguages(): string[] {
    return ["en-US"];
  },
  isPackaged: false,
  isReady: (): boolean => true,
  setPath(_name: string, _value: string): void {
    // No-op: paths are resolved from env in the web server.
  },
  quit(): void {
    process.exit(0);
  },
  exit(code = 0): void {
    process.exit(code);
  },
  relaunch(): void {
    // No-op: the container supervisor owns restarts.
  },
  requestSingleInstanceLock(): boolean {
    return true;
  },
  disableHardwareAcceleration(): void {},
  commandLine: {
    appendSwitch(): void {},
    appendArgument(): void {},
  },
};

// ---------------------------------------------------------------------------
// ipcMain
// ---------------------------------------------------------------------------

const ipcMain = {
  handle(channel: string, fn: IpcHandler): void {
    if (ipcHandlers.has(channel)) {
      throw new Error(
        `Attempted to register a second handler for '${channel}'`,
      );
    }
    ipcHandlers.set(channel, fn);
  },
  handleOnce(channel: string, fn: IpcHandler): void {
    if (ipcHandlers.has(channel)) {
      throw new Error(
        `Attempted to register a second handler for '${channel}'`,
      );
    }
    ipcHandlers.set(channel, (event, ...args) => {
      ipcHandlers.delete(channel);
      return fn(event, ...args);
    });
  },
  removeHandler(channel: string): void {
    ipcHandlers.delete(channel);
  },
  on(channel: string, fn: (...args: unknown[]) => void): void {
    const list = ipcListeners.get(channel) ?? [];
    list.push(fn);
    ipcListeners.set(channel, list);
  },
  once(channel: string, fn: (...args: unknown[]) => void): void {
    const wrapped = (...args: unknown[]) => {
      const list = ipcListeners.get(channel) ?? [];
      ipcListeners.set(
        channel,
        list.filter((listener) => listener !== wrapped),
      );
      fn(...args);
    };
    ipcMain.on(channel, wrapped);
  },
  removeListener(channel: string, fn: (...args: unknown[]) => void): void {
    const list = ipcListeners.get(channel);
    if (!list) return;
    ipcListeners.set(
      channel,
      list.filter((listener) => listener !== fn),
    );
  },
  removeAllListeners(channel?: string): void {
    if (channel) {
      ipcListeners.delete(channel);
      return;
    }
    ipcListeners.clear();
  },
};

// ---------------------------------------------------------------------------
// BrowserWindow -> connected browser clients
// ---------------------------------------------------------------------------

/**
 * The window-shaped object handed to main-process code. It behaves like the
 * single browser tab that issued the request (or the only connected tab, for
 * producers with no originating sender).
 */
function windowFor(endpoint: WebClientEndpoint | undefined) {
  const target = endpoint;
  return {
    id: target?.id ?? 0,
    webContents: target ?? null,
    isDestroyed: () => !target || target.isDestroyed(),
    isMinimizable: () => false,
    isMaximizable: () => false,
    isFullScreenable: () => false,
    isVisible: () => true,
    isFocused: () => true,
    getBounds: () => ({ x: 0, y: 0, width: 1280, height: 800 }),
    getPosition: () => [0, 0],
    getSize: () => [1280, 800],
    getNormalBounds: () => ({ x: 0, y: 0, width: 1280, height: 800 }),
    minimize(): void {},
    maximize(): void {},
    unmaximize(): void {},
    restore(): void {},
    focus(): void {},
    blur(): void {},
    show(): void {},
    hide(): void {},
    close(): void {},
    setFullScreen(): void {},
    setMenuBarVisibility(): void {},
    loadURL(): Promise<void> {
      return Promise.resolve();
    },
    loadFile(): Promise<void> {
      return Promise.resolve();
    },
    on(): void {
      return;
    },
    once(): void {
      return;
    },
    removeListener(): void {
      return;
    },
    removeAllListeners(): void {
      return;
    },
    webContents_: target,
  };
}

const BrowserWindow = {
  getAllWindows(): ReturnType<typeof windowFor>[] {
    return liveClientEndpoints().map((endpoint) => windowFor(endpoint));
  },
  getFocusedWindow(): ReturnType<typeof windowFor> | null {
    const endpoints = liveClientEndpoints();
    return endpoints.length > 0 ? windowFor(endpoints[0]) : null;
  },
  getTopMostWindow(): ReturnType<typeof windowFor> | null {
    return BrowserWindow.getFocusedWindow();
  },
  fromWebContents(webContents: unknown): ReturnType<typeof windowFor> | null {
    if (!webContents) return null;
    return windowFor(webContents as WebClientEndpoint);
  },
  fromId(id: number): ReturnType<typeof windowFor> | null {
    const endpoint = liveClientEndpoints().find((item) => item.id === id);
    return endpoint ? windowFor(endpoint) : null;
  },
};

// ---------------------------------------------------------------------------
// safeStorage — file-backed AES-256-GCM instead of the OS keyring
// ---------------------------------------------------------------------------

let cachedKey: Buffer | null = null;

function secretKeyPath(): string {
  return path.join(resolveUserDataDir(), ".dyad-web-secret.key");
}

function loadSecretKey(): Buffer {
  if (cachedKey) return cachedKey;
  const keyPath = secretKeyPath();
  try {
    fs.mkdirSync(path.dirname(keyPath), { recursive: true });
    if (fs.existsSync(keyPath)) {
      const parsed = Buffer.from(
        fs.readFileSync(keyPath, "utf8").trim(),
        "hex",
      );
      if (parsed.length === 32) {
        cachedKey = parsed;
        return cachedKey;
      }
    }
    const key = crypto.randomBytes(32);
    fs.writeFileSync(keyPath, key.toString("hex"), { mode: 0o600 });
    cachedKey = key;
    return cachedKey;
  } catch (error) {
    // Fall back to an in-memory key: secrets stay unreadable after restart but
    // the app keeps working on a read-only volume.
    console.warn("[electron-shim] could not persist safeStorage key", error);
    cachedKey = crypto.randomBytes(32);
    return cachedKey;
  }
}

const safeStorage = {
  isEncryptionAvailable(): boolean {
    return true;
  },
  encryptString(plaintext: string): Buffer {
    const key = loadSecretKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    // Version byte keeps a future format change distinguishable.
    return Buffer.concat([Buffer.from([1]), iv, tag, ciphertext]);
  },
  decryptString(blob: Buffer): string {
    const key = loadSecretKey();
    if (blob.length < 1 + 12 + 16 || blob[0] !== 1) {
      throw new Error("Unrecognised safeStorage blob");
    }
    const iv = blob.subarray(1, 13);
    const tag = blob.subarray(13, 29);
    const ciphertext = blob.subarray(29);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
  },
};

// ---------------------------------------------------------------------------
// UI-only surfaces
// ---------------------------------------------------------------------------

const noopDialogResult = {
  canceled: true,
  filePaths: [] as string[],
  filePath: undefined as string | undefined,
};

const dialog = {
  showOpenDialog: (): Promise<typeof noopDialogResult> =>
    Promise.resolve({ canceled: true, filePaths: [] }),
  showOpenDialogSync: (): string[] => [],
  showSaveDialog: (): Promise<{ canceled: boolean; filePath?: string }> =>
    Promise.resolve({ canceled: true }),
  showSaveDialogSync: (): undefined => undefined,
  showMessageBox: (): Promise<{ response: number; checkboxChecked: boolean }> =>
    Promise.resolve({ response: 0, checkboxChecked: false }),
  showMessageBoxSync: (): number => 0,
  showErrorBox(_title: string, content: string): void {
    console.error(`[dyad] ${content}`);
  },
};

let clipboardBuffer = "";

const clipboard = {
  readText: (): string => clipboardBuffer,
  writeText(text: string): void {
    clipboardBuffer = text;
  },
  readHTML: (): string => "",
  writeHTML(): void {},
  readImage: (): null => null,
  writeImage(): void {},
  clear(): void {
    clipboardBuffer = "";
  },
  availableFormats: (): string[] => [],
};

const shell = {
  openExternal(url: string): Promise<void> {
    console.info(
      `[electron-shim] openExternal(${url}) — no desktop shell in web mode`,
    );
    return Promise.resolve();
  },
  openPath(_path: string): Promise<string> {
    return Promise.resolve("");
  },
  showItemInFolder(): void {},
  beep(): void {},
  writeShortcutLink(): Promise<boolean> {
    return Promise.resolve(false);
  },
  readShortcutLink(): Promise<never> {
    return Promise.reject(new Error("Not supported in web mode"));
  },
  trash(): Promise<void> {
    return Promise.resolve();
  },
};

const nativeTheme = {
  shouldUseDarkColors: false,
  themeSource: "system" as const,
  shouldUseHighContrastColors: false,
  shouldUseInvertedColorScheme: false,
  on(): void {},
  off(): void {},
  removeAllListeners(): void {},
};

class Notification {
  static isSupported(): boolean {
    return false;
  }
  constructor(_options?: unknown) {}
  on(): void {}
  once(): void {}
  show(): void {}
  close(): void {}
  static requestPermission(): Promise<string> {
    return Promise.resolve("denied");
  }
}

class WebContentsView {
  readonly webContents = {
    id: 0,
    send(): void {},
    on(): void {},
    once(): void {},
    removeAllListeners(): void {},
    openDevTools(): void {},
    closeDevTools(): void {},
    isDestroyed: () => true,
    isCrashed: () => false,
    getURL: () => "",
    loadURL: (): Promise<void> => Promise.resolve(),
    setBounds(): void {},
    addListener(): void {},
    removeListener(): void {},
    off(): void {},
    session: null,
    setWindowOpenHandler(): void {},
    setAudioMuted(): void {},
    getWebPreferences: () => ({}),
    debugger: {
      attach(): void {},
      detach(): void {},
      on(): void {},
      sendCommand(): void {},
    },
    getOSProcessId: () => 0,
    executionId: undefined,
  };
  setBounds(): void {}
  getBounds(): null {
    return null;
  }
  setVisible(): void {}
  on(): void {}
  once(): void {}
  off(): void {}
  removeAllListeners(): void {}
  addListener(): void {}
  removeListener(): void {}
}

const menu = {
  buildFromTemplate: (_template: unknown) => ({
    popup: () => {},
    insertMenu: () => {},
    items: [],
  }),
  setApplicationMenu: () => {},
  getApplicationMenu: () => null,
  sendAction: () => false,
};

const protocol = {
  registerSchemesAsPrivileged: () => {},
  registerFileProtocol: () => {},
  registerBufferProtocol: () => {},
  registerStringProtocol: () => {},
  registerHttpProtocol: () => {},
  registerStreamProtocol: () => {},
  interceptFileProtocol: () => {},
  uninterceptProtocol: () => {},
  isProtocolRegistered: () => false,
  isProtocolHandled: (): Promise<boolean> => Promise.resolve(false),
  handle: () => {},
  unhandle: () => {},
  buffer: (): Promise<Buffer> => Promise.resolve(Buffer.alloc(0)),
  fetch: (): Promise<Response> => Promise.reject(new Error("Not supported")),
};

const autoUpdater = {
  on(): void {},
  once(): void {},
  removeAllListeners(): void {},
  removeListener(): void {},
  checkForUpdates: () => {},
  downloadUpdate: (): Promise<void> => Promise.resolve(),
  quitAndInstall: () => {},
  setFeedURL: () => {},
  getFeedURL: (): string => "",
  autoDownload: true,
  autoInstallOnAppQuit: false,
};

const nativeImage = {
  createFromPath: () => ({
    toDataURL: () => "",
    toPNG: () => Buffer.alloc(0),
    isEmpty: () => true,
    resize: () => ({ isEmpty: () => true, toDataURL: () => "" }),
  }),
  createFromBuffer: () => ({
    toDataURL: () => "",
    toPNG: () => Buffer.alloc(0),
    isEmpty: () => true,
    resize: () => ({ isEmpty: () => true, toDataURL: () => "" }),
  }),
  createFromDataURL: () => ({ isEmpty: () => true, toDataURL: () => "" }),
  createEmpty: () => ({ isEmpty: () => true, toDataURL: () => "" }),
};

const crashReporter = {
  start: () => {},
  stop: () => {},
  addExtraParameter: () => {},
  removeExtraParameter: () => {},
  getParameters: () => ({}),
};

const screen = {
  getPrimaryDisplay: () => ({
    id: 0,
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    workArea: { x: 0, y: 0, width: 1920, height: 1040 },
    scaleFactor: 1,
    rotation: 0,
    internal: false,
    displayFrequency: 60,
  }),
  getAllDisplays: () => [screen.getPrimaryDisplay()],
  getDisplayNearestPoint: () => screen.getPrimaryDisplay(),
  getDisplayMatching: () => screen.getPrimaryDisplay(),
  getCursorScreenPoint: () => ({ x: 0, y: 0 }),
  getPrimaryCursorScreenPoint: () => ({ x: 0, y: 0 }),
  on(): void {},
  removeAllListeners(): void {},
};

const net = {
  fetch: (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
    globalThis.fetch(input, init),
  request: () => {
    throw new Error("net.request is not supported in web mode");
  },
};

const defaultSession = {
  clearStorageData: async (_options?: unknown) => {},
  clearCache: async () => {},
  flushStorageData: () => {},
  cookies: {
    get: async (): Promise<unknown[]> => [],
    set: async () => {},
    remove: async () => {},
    flushStore: async () => {},
  },
  webRequest: {
    onBeforeRequest: () => {},
    onHeadersReceived: () => {},
    onBeforeSendHeaders: () => {},
    removeListener: () => {},
  },
  protocol,
  setPermissionRequestHandler: () => {},
  setPermissionCheckHandler: () => {},
  allowNTLMCredentialsForDomains: () => {},
  setUserAgent: () => {},
  getUserAgent: () => "dyad-web",
  downloadURL: () => {},
  createInterruptedDownload: () => {},
};

const session = {
  defaultSession,
  fromPartition: (_partition: string) => defaultSession,
  fromPath: (_path: string) => defaultSession,
};

const contextBridge = {
  exposeInMainWorld: () => {},
  isContextBridge: true,
};

const webFrame = {
  setZoomFactor: () => {},
  getZoomFactor: () => 1,
  setZoomLevel: () => {},
  getZoomLevel: () => 0,
  setVisualZoomLevelLimits: () => {},
  setSpellCheckProvider: () => {},
  insertCSS: (): Promise<string> => Promise.resolve(""),
  executeJavaScript: (): Promise<unknown> => Promise.resolve(undefined),
  getResourceUsage: () => ({}),
};

const ipcRenderer = {
  invoke: (): Promise<never> =>
    Promise.reject(new Error("ipcRenderer is only available in the renderer")),
  send: () => {},
  on: () => {},
  once: () => {},
  removeListener: () => {},
  removeAllListeners: () => {},
};

/**
 * `utilityProcess.fork` — real child process so the code-explorer and
 * supabase-dependency-analysis workers actually run.
 *
 * Callers build the module path as `path.join(__dirname, "<worker>.js")`,
 * which only resolves when the caller itself has been bundled into
 * `.vite/build/` (the Electron layout). Running from source, `__dirname` is
 * the caller's source directory, so fall back to the places the worker build
 * configs emit (`dist/`, `.vite/build/`).
 */
function resolveWorkerBundle(modulePath: string): string {
  if (fs.existsSync(modulePath)) return modulePath;
  const base = path.basename(modulePath);
  const repoRoot = path.resolve(__dirname, "..", "..");
  const candidates = [
    path.join(repoRoot, "dist", base),
    path.join(repoRoot, "dist", base.replace(/\.js$/, ".cjs")),
    path.join(repoRoot, ".vite", "build", base),
    path.join(repoRoot, "workers", base),
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new Error(
      `utilityProcess worker bundle not found (tried ${[modulePath, ...candidates].join(", ")}). ` +
        `Build it with: npm run build:web-workers`,
    );
  }
  return found;
}

function forkUtilityProcess(modulePath: string): {
  on: (event: string, cb: (...args: unknown[]) => void) => void;
  postMessage: (message: unknown) => void;
  kill: () => void;
  pid: number | undefined;
} {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { fork } =
    require("node:child_process") as typeof import("node:child_process");
  const child = fork(resolveWorkerBundle(modulePath), [], {
    env: process.env,
    execArgv: [],
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  return {
    on: (event, cb) => {
      if (event === "error") {
        child.on("error", (err) => cb("unknown", "spawn", String(err)));
      } else {
        child.on(event as "spawn" | "message" | "exit", cb);
      }
    },
    postMessage: (message) => child.send(message as object),
    kill: () => child.kill(),
    pid: child.pid,
  };
}

const utilityProcess = {
  fork: forkUtilityProcess,
};

// ---------------------------------------------------------------------------
// exports
// ---------------------------------------------------------------------------

export {
  app,
  ipcMain,
  BrowserWindow,
  safeStorage,
  dialog,
  clipboard,
  shell,
  nativeTheme,
  Notification,
  WebContentsView,
  menu as Menu,
  protocol,
  autoUpdater,
  nativeImage,
  crashReporter,
  screen,
  net,
  session,
  contextBridge,
  webFrame,
  ipcRenderer,
  utilityProcess,
};

export default {
  app,
  ipcMain,
  BrowserWindow,
  safeStorage,
  dialog,
  clipboard,
  shell,
  nativeTheme,
  Notification,
  WebContentsView,
  Menu: menu,
  protocol,
  autoUpdater,
  nativeImage,
  crashReporter,
  screen,
  net,
  session,
  contextBridge,
  webFrame,
  ipcRenderer,
  utilityProcess,
};
