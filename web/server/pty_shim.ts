/**
 * Safe fallback shim for node-pty when native bindings are unavailable.
 */
export function spawn(): never {
  throw new Error(
    "node-pty native bindings are not available in this environment",
  );
}

export default { spawn };
