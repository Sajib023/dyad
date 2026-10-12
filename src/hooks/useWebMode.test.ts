import { describe, expect, it, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useWebMode } from "./useWebMode";

describe("useWebMode", () => {
  const originalElectron = (window as unknown as { electron?: unknown })
    .electron;

  afterEach(() => {
    (window as unknown as { electron?: unknown }).electron = originalElectron;
  });

  it("returns false when window.electron is undefined", () => {
    delete (window as unknown as { electron?: unknown }).electron;
    const { result } = renderHook(() => useWebMode());
    expect(result.current).toBe(false);
  });

  it("returns false when isWebBuild is false or undefined", () => {
    (window as unknown as { electron?: { isWebBuild?: boolean } }).electron =
      {};
    const { result } = renderHook(() => useWebMode());
    expect(result.current).toBe(false);
  });

  it("returns true when isWebBuild is true", () => {
    (window as unknown as { electron?: { isWebBuild?: boolean } }).electron = {
      isWebBuild: true,
    };
    const { result } = renderHook(() => useWebMode());
    expect(result.current).toBe(true);
  });
});
