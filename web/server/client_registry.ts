/**
 * Registry of connected browser clients.
 *
 * Each WebSocket connection to `/ipc` registers one client here. A client is
 * the web equivalent of an Electron `BrowserWindow`'s `WebContents`: it can be
 * `send()``d on (main -> renderer events) and it owns the fake
 * `IpcMainInvokeEvent` handed to handlers for requests it issued.
 */

export interface WebClientEndpoint {
  readonly id: number;
  isDestroyed(): boolean;
  isCrashed(): boolean;
  send(channel: string, ...args: unknown[]): void;
  once?(event: "destroyed", listener: () => void): this | void;
}

interface RegisteredClient {
  endpoint: WebClientEndpoint;
  destroyListeners: Set<() => void>;
}

const clients = new Map<number, RegisteredClient>();
let nextId = 1;

export function createClientEndpoint(
  send: (channel: string, args: unknown[]) => void,
): WebClientEndpoint {
  const id = nextId++;
  const destroyListeners = new Set<() => void>();
  const endpoint: WebClientEndpoint = {
    id,
    isDestroyed: () => !clients.has(id),
    isCrashed: () => false,
    send: (channel: string, ...args: unknown[]) => {
      if (!clients.has(id)) return;
      send(channel, args);
    },
    once: (_event, listener) => {
      destroyListeners.add(listener);
    },
  };
  clients.set(id, { endpoint, destroyListeners });
  return endpoint;
}

export function unregisterClient(endpoint: WebClientEndpoint): void {
  const record = clients.get(endpoint.id);
  if (!record) return;
  clients.delete(endpoint.id);
  for (const listener of Array.from(record.destroyListeners)) {
    try {
      listener();
    } catch {
      // A broken teardown listener must not take the socket down with it.
    }
  }
  record.destroyListeners.clear();
}

export function liveClientEndpoints(): WebClientEndpoint[] {
  return Array.from(clients.values())
    .map((record) => record.endpoint)
    .filter((endpoint) => !endpoint.isDestroyed());
}

export function connectedClientCount(): number {
  return clients.size;
}
