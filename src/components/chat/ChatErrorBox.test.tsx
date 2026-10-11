import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatErrorBox } from "./ChatErrorBox";

const mocks = vi.hoisted(() => ({
  openExternalUrl: vi.fn(),
}));

vi.mock("@/ipc/types", () => ({
  ipc: { system: { openExternalUrl: mocks.openExternalUrl } },
}));

describe("ChatErrorBox error presentation", () => {
  beforeEach(() => {
    mocks.openExternalUrl.mockReset();
  });

  it("renders the raw error and docs link", () => {
    render(<ChatErrorBox error="Something broke" onDismiss={vi.fn()} />);

    expect(screen.getByText("Something broke")).toBeTruthy();
    expect(screen.getByText("Read docs")).toBeTruthy();
  });

  it("bounds long string errors in a scrollable region", () => {
    render(
      <ChatErrorBox
        error={`Implementer failures:\n${"Detailed failure line\n".repeat(200)}`}
        onDismiss={vi.fn()}
      />,
    );

    const scrollRegion = screen
      .getByTestId("chat-error-box")
      .querySelector(".overflow-y-auto");
    expect(scrollRegion?.className).toContain("max-h-64");
    expect(scrollRegion?.className).toContain("scrollbar-on-hover");
  });

  it("trims fallback details from the message", () => {
    render(
      <ChatErrorBox
        error={'All models failed. Fallbacks=[{"error":"upstream gone"}]'}
        onDismiss={vi.fn()}
      />,
    );

    expect(screen.getByText("All models failed.")).toBeTruthy();
    expect(screen.queryByText(/upstream gone/)).toBeNull();
  });

  it("offers starting a new chat when provided", () => {
    const onStartNewChat = vi.fn();
    render(
      <ChatErrorBox
        error="boom"
        onDismiss={vi.fn()}
        onStartNewChat={onStartNewChat}
      />,
    );

    fireEvent.click(screen.getByText("Start new chat"));
    expect(onStartNewChat).toHaveBeenCalledOnce();
  });

  it("offers switching to Build mode when provided", () => {
    const onSwitchToBuildMode = vi.fn();
    render(
      <ChatErrorBox
        error="boom"
        onDismiss={vi.fn()}
        onSwitchToBuildMode={onSwitchToBuildMode}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Switch to Build" }));
    expect(onSwitchToBuildMode).toHaveBeenCalledOnce();
  });

  it("dismisses via the dismiss control", () => {
    const onDismiss = vi.fn();
    render(<ChatErrorBox error="boom" onDismiss={onDismiss} />);

    const dismissButton = screen
      .getByTestId("chat-error-box")
      .querySelector("button");
    expect(dismissButton).toBeTruthy();
    fireEvent.click(dismissButton!);
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
