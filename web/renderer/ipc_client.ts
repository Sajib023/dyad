/**
 * Browser replacement for `src/preload.ts`.
 *
 * In Electron, preload exposes `window.electron.ipcRenderer` via
 * `contextBridge`. On the web there is no preload, so this module — loaded
 * before `src/renderer.tsx` by `index.web.html` — installs the identical
 * surface on top of a WebSocket to `/ipc`.
 *
 * Contract with the server (`web/server/app.ts`):
 *   {t:"i", id, ch, args[]}  invoke / invokeEnvelope  -> {t:"r", id, ok, v|e}
 *   {t:"s", ch, args[]}      fire-and-forget send
 *   {t:"e", ch, args[]}      main -> renderer event
 *
 * Semantics mirror `src/preload.ts` exactly: the channel whitelist, the same
 * "Invalid channel" errors, `invoke` unwrapping the Dyad IPC envelope while
 * `invokeEnvelope` does not, and `on()` returning an unsubscribe function.
 */
import {
  VALID_INVOKE_CHANNELS,
  VALID_RECEIVE_CHANNELS,
  VALID_SEND_CHANNELS,
} from "@/ipc/preload/channels";
import {
  deserializeIpcError,
  isIpcInvokeEnvelope,
  serializeIpcError,
  unwrapIpcEnvelope,
} from "@/ipc/contracts/core";
import { decode, encode } from "../shared/codec";

type Listener = (...args: unknown[]) => void;

interface PendingInvoke {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

const listeners = new Map<string, Set<Listener>>();
const pending = new Map<number, PendingInvoke>();
const outboundQueue: string[] = [];

let nextInvokeId = 1;
let socket: WebSocket | null = null;
let socketOpen = false;
let retryDelayMs = 250;
let closedByPage = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function isValidDynamicReceiveChannel(channel: string): boolean {
  // Mirrors src/preload.ts — server-generated terminal stream session ids.
  return (
    channel.startsWith("terminal:data:") || channel.startsWith("terminal:exit:")
  );
}

function isValidReceiveChannel(channel: string): boolean {
  return (
    (VALID_RECEIVE_CHANNELS as readonly string[]).includes(channel) ||
    isValidDynamicReceiveChannel(channel)
  );
}

function assertValidInvokeChannel(channel: string): void {
  if (!(VALID_INVOKE_CHANNELS as readonly string[]).includes(channel)) {
    throw new Error(`Invalid channel: ${channel}`);
  }
}

function assertValidSendChannel(channel: string): void {
  if (!(VALID_SEND_CHANNELS as readonly string[]).includes(channel)) {
    throw new Error(`Invalid channel: ${channel}`);
  }
}

function socketUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const token = new URLSearchParams(window.location.search).get("token");
  const query = token ? `?token=${encodeURIComponent(token)}` : "";
  return `${protocol}//${window.location.host}/ipc${query}`;
}

function sendFrame(frame: Record<string, unknown>): void {
  const encoded = JSON.stringify(encode(frame));
  if (socketOpen && socket && socket.readyState === WebSocket.OPEN) {
    socket.send(encoded);
    return;
  }
  outboundQueue.push(encoded);
}

function flushOutboundQueue(): void {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  while (outboundQueue.length > 0) {
    const frame = outboundQueue.shift();
    if (frame !== undefined) socket.send(frame);
  }
}

function rejectAllPending(error: Error): void {
  for (const [, entry] of Array.from(pending)) {
    entry.reject(error);
  }
  pending.clear();
}

function dispatchEvent(channel: string, args: unknown[]): void {
  const subs = listeners.get(channel);
  if (!subs?.size) return;
  for (const listener of Array.from(subs)) {
    try {
      listener(...args);
    } catch (error) {
      console.error(`[dyad-web] listener for "${channel}" threw`, error);
    }
  }
}

function handleMessage(raw: string): void {
  let frame: unknown;
  try {
    frame = decode(JSON.parse(raw));
  } catch (error) {
    console.error("[dyad-web] failed to decode frame", error);
    return;
  }
  if (typeof frame !== "object" || frame === null) return;
  const message = frame as Record<string, unknown>;

  switch (message.t) {
    case "r": {
      const entry = pending.get(message.id as number);
      if (!entry) return;
      pending.delete(message.id as number);
      if (message.ok) {
        entry.resolve(message.v);
      } else {
        entry.reject(deserializeIpcError(message.e as never));
      }
      return;
    }
    case "e": {
      dispatchEvent(message.ch as string, (message.args as unknown[]) ?? []);
      return;
    }
    default:
      return;
  }
}

function connect(): void {
  if (closedByPage) return;
  let ws: WebSocket;
  try {
    ws = new WebSocket(socketUrl());
  } catch {
    scheduleReconnect();
    return;
  }
  socket = ws;

  ws.onopen = () => {
    socketOpen = true;
    retryDelayMs = 250;
    flushOutboundQueue();
  };

  ws.onmessage = (event) => {
    if (typeof event.data === "string") handleMessage(event.data);
  };

  ws.onerror = () => {
    // `onclose` always follows; nothing to do here.
  };

  ws.onclose = () => {
    socketOpen = false;
    socket = null;
    rejectAllPending(new Error("Dyad web connection lost — reconnecting"));
    scheduleReconnect();
  };
}

function scheduleReconnect(): void {
  if (closedByPage || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, retryDelayMs);
  retryDelayMs = Math.min(retryDelayMs * 2, 5000);
}

const ipcRenderer = {
  invoke: (channel: string, ...args: unknown[]): Promise<unknown> => {
    assertValidInvokeChannel(channel);
    return ipcRenderer
      .invokeEnvelope(channel, ...args)
      .then((response) =>
        isIpcInvokeEnvelope(response) ? unwrapIpcEnvelope(response) : response,
      );
  },
  invokeEnvelope: (channel: string, ...args: unknown[]): Promise<unknown> => {
    assertValidInvokeChannel(channel);
    const id = nextInvokeId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      sendFrame({ t: "i", id, ch: channel, args });
    });
  },
  send: (channel: string, ...args: unknown[]): void => {
    assertValidSendChannel(channel);
    sendFrame({ t: "s", ch: channel, args });
  },
  on: (channel: string, listener: Listener): (() => void) => {
    if (!isValidReceiveChannel(channel)) {
      throw new Error(`Invalid channel: ${channel}`);
    }
    let subs = listeners.get(channel);
    if (!subs) {
      subs = new Set();
      listeners.set(channel, subs);
    }
    subs.add(listener);
    return () => {
      subs.delete(listener);
    };
  },
  removeListener: (channel: string, listener: Listener): void => {
    if (!isValidReceiveChannel(channel)) return;
    listeners.get(channel)?.delete(listener);
  },
  removeAllListeners: (channel: string): void => {
    if (!isValidReceiveChannel(channel)) return;
    listeners.delete(channel);
  },
};

const electron = {
  ipcRenderer,
  webFrame: {
    setZoomFactor: (_factor: number) => {},
    getZoomFactor: () => 1,
    setZoomLevel: (_level: number) => {},
    getZoomLevel: () => 0,
  },
  // Surfaced so the UI (and support docs) can tell web from desktop.
  isWebBuild: true,
};

declare global {
  interface Window {
    electron?: typeof electron;
    __dyadWebIpc?: {
      encode: typeof encode;
      serializeIpcError: typeof serializeIpcError;
      connected: () => boolean;
      disconnect: () => void;
    };
  }
}

if (typeof window !== "undefined") {
  if (!window.electron) {
    window.electron = electron;
  }
  window.__dyadWebIpc = {
    encode,
    serializeIpcError,
    connected: () => socketOpen,
    disconnect: () => {
      closedByPage = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.close();
    },
  };
  connect();
}

export { electron };
