/**
 * Structured-clone-flavoured JSON codec for the Dyad web IPC transport.
 *
 * Electron IPC uses the V8 structured clone algorithm; JSON cannot represent
 * `undefined`, `Date`, `Map`, `Set`, `BigInt`, `NaN`, typed arrays or `Error`s,
 * all of which legitimately cross the Dyad IPC boundary. This module encodes
 * those values with single-key type tags so a JSON frame on the wire still
 * round-trips the same value graph the Electron IPC layer would.
 *
 * Both the Node server (`web/server/*`) and the browser client
 * (`web/renderer/ipc_client.ts`) import this file — keep it free of Node-only
 * and DOM-only APIs.
 */

const TAG = "$dyad";

/** Own-key escape so a user object that literally contains `$dyad` survives. */
const OBJECT_ESCAPED = "o";

const TYPED_ARRAY_NAMES = new Set([
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
]);

function makeTag(kind: string, extra?: Record<string, unknown>): unknown {
  return extra ? { [TAG]: kind, ...extra } : { [TAG]: kind };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(
      ...bytes.subarray(i, Math.min(i + chunk, bytes.length)),
    );
  }
  if (typeof btoa === "function") {
    return btoa(binary);
  }
  // Node
  return (
    globalThis as {
      Buffer?: { from(s: string, e: string): { toString(e: string): string } };
    }
  )
    .Buffer!.from(binary, "binary")
    .toString("base64");
}

function base64ToBytes(b64: string): Uint8Array {
  if (typeof atob === "function") {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  const buf = (
    globalThis as { Buffer?: { from(s: string, e: string): Uint8Array } }
  ).Buffer!.from(b64, "base64");
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

class CycleError extends Error {
  constructor() {
    super(
      "Value passed across the Dyad web IPC boundary contains a circular reference",
    );
    this.name = "CycleError";
  }
}

function encodeValue(value: unknown, seen: Set<object>): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  switch (typeof value) {
    case "undefined":
      return makeTag("u");
    case "number": {
      if (Number.isFinite(value)) {
        return Object.is(value, -0) ? makeTag("n", { v: "-0" }) : value;
      }
      return makeTag("n", { v: String(value) });
    }
    case "bigint":
      return makeTag("b", { v: value.toString() });
    case "function":
    case "symbol":
      // Electron's structured clone throws here too.
      throw new TypeError(
        `A ${typeof value} could not be cloned across the Dyad web IPC boundary`,
      );
    default:
      break;
  }

  const obj = value as object;
  if (seen.has(obj)) throw new CycleError();
  seen.add(obj);
  try {
    if (value instanceof Date) {
      return makeTag("d", { v: value.toISOString() });
    }
    if (value instanceof RegExp) {
      return makeTag("r", { s: value.source, f: value.flags });
    }
    if (value instanceof Error) {
      const extra: Record<string, unknown> = {
        n: value.name,
        m: value.message,
        s: value.stack,
      };
      const kind = (value as { kind?: unknown }).kind;
      if (kind !== undefined) extra.k = kind;
      const code = (value as { code?: unknown }).code;
      if (code !== undefined) extra.c = code;
      return makeTag("e", extra);
    }
    if (ArrayBuffer.isView(value)) {
      const view = value as ArrayBufferView & { constructor: { name: string } };
      if (value instanceof DataView) {
        const bytes = new Uint8Array(
          view.buffer,
          view.byteOffset,
          view.byteLength,
        );
        return makeTag("dv", { v: bytesToBase64(bytes) });
      }
      if (TYPED_ARRAY_NAMES.has(view.constructor.name)) {
        const bytes = new Uint8Array(
          view.buffer,
          view.byteOffset,
          view.byteLength,
        );
        return makeTag("ta", {
          c: view.constructor.name,
          v: bytesToBase64(bytes),
        });
      }
      // Unknown typed array flavour: fall through to plain-object encoding.
    }
    if (value instanceof ArrayBuffer) {
      return makeTag("ab", {
        v: bytesToBase64(new Uint8Array(value)),
      });
    }
    if (Array.isArray(value)) {
      const out: unknown[] = Array.from({ length: value.length });
      for (let i = 0; i < value.length; i++) {
        // Sparse arrays and holes both land on `undefined` in structured clone
        // when read by index; encode holes explicitly so they stay holes-less.
        out[i] = encodeValue(i in value ? value[i] : undefined, seen);
      }
      return out;
    }
    if (value instanceof Map) {
      const entries: unknown[] = [];
      for (const [k, v] of value) {
        entries.push([encodeValue(k, seen), encodeValue(v, seen)]);
      }
      return makeTag("m", { e: entries });
    }
    if (value instanceof Set) {
      const items: unknown[] = [];
      for (const v of value) items.push(encodeValue(v, seen));
      return makeTag("s", { e: items });
    }

    const record = value as Record<string, unknown>;
    const fields: Record<string, unknown> = {};
    for (const key of Object.keys(record)) {
      fields[key] = encodeValue(record[key], seen);
    }
    if (Object.prototype.hasOwnProperty.call(record, TAG)) {
      return makeTag(OBJECT_ESCAPED, { e: fields });
    }
    return fields;
  } finally {
    seen.delete(obj);
  }
}

function decodeValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;

  if (Array.isArray(value)) {
    return value.map((item) => decodeValue(item));
  }

  const obj = value as Record<string, unknown>;
  if (
    Object.prototype.hasOwnProperty.call(obj, TAG) &&
    Object.keys(obj).length >= 1
  ) {
    const kind = obj[TAG];
    if (typeof kind === "string") {
      switch (kind) {
        case "u":
          return undefined;
        case "n": {
          const raw = obj.v;
          if (raw === "-0") return -0;
          return Number(raw);
        }
        case "b":
          return BigInt(obj.v as string);
        case "d":
          return new Date(obj.v as string);
        case "r":
          return new RegExp(obj.s as string, obj.f as string);
        case "e": {
          const message = typeof obj.m === "string" ? obj.m : String(obj.m);
          const error =
            typeof obj.k === "string" ? new Error(message) : new Error(message);
          if (typeof obj.n === "string") error.name = obj.n;
          if (typeof obj.s === "string") error.stack = obj.s;
          if (typeof obj.k !== "undefined") {
            (error as Error & { kind?: unknown }).kind = obj.k;
          }
          if (typeof obj.c !== "undefined") {
            (error as Error & { code?: unknown }).code = obj.c;
          }
          return error;
        }
        case "ab": {
          const bytes = base64ToBytes(obj.v as string);
          return bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength,
          );
        }
        case "ta": {
          const bytes = base64ToBytes(obj.v as string);
          const ctor = (globalThis as Record<string, unknown>)[obj.c as string];
          if (typeof ctor !== "function") return bytes;
          const copy = bytes.slice().buffer;
          return new (ctor as new (b: ArrayBuffer) => unknown)(copy);
        }
        case "dv": {
          const bytes = base64ToBytes(obj.v as string);
          return new DataView(
            bytes.buffer.slice(
              bytes.byteOffset,
              bytes.byteOffset + bytes.byteLength,
            ),
          );
        }
        case "m": {
          const map = new Map();
          for (const entry of obj.e as unknown[]) {
            const [k, v] = entry as [unknown, unknown];
            map.set(decodeValue(k), decodeValue(v));
          }
          return map;
        }
        case "s": {
          const set = new Set();
          for (const item of obj.e as unknown[]) set.add(decodeValue(item));
          return set;
        }
        case OBJECT_ESCAPED: {
          const fields = obj.e as Record<string, unknown>;
          const out: Record<string, unknown> = {};
          for (const key of Object.keys(fields)) {
            out[key] = decodeValue(fields[key]);
          }
          return out;
        }
        default:
          break;
      }
    }
  }

  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    out[key] = decodeValue(obj[key]);
  }
  return out;
}

/** Encode a value for transport as a JSON-compatible structure. */
export function encode(value: unknown): unknown {
  return encodeValue(value, new Set<object>());
}

/** Decode a value received over the transport. */
export function decode(value: unknown): unknown {
  return decodeValue(value);
}

/** JSON round-trip shorthand used by the WS transport on both sides. */
export function encodeToJson(value: unknown): string {
  return JSON.stringify(encode(value));
}

export function decodeFromJson(text: string): unknown {
  return decode(JSON.parse(text));
}
