import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import {
  setupHybridChatHarness,
  type HybridChatHarness,
} from "@/testing/hybrid_chat_harness";
import { h } from "@/testing/hybrid.setup";
import { chats } from "@/db/schema";
import { eq } from "drizzle-orm";

describe("chat input during turn admission", () => {
  let harness: HybridChatHarness;

  beforeAll(async () => {
    harness = await setupHybridChatHarness({
      electronMock: h,
      autoApprove: true,
      settings: {
        providerSettings: {},
        isTestMode: true,
      },
    });
  }, 60_000);

  afterEach(() => {
    cleanup();
  });

  afterAll(async () => {
    await harness?.dispose();
  });

  it("clears the composer and lists the message after send", async () => {
    const chatId = await harness.createChat();
    harness.mount({ chatId });
    harness.setChatAttachments([
      { name: "submitted.txt", content: "submitted", mimeType: "text/plain" },
    ]);
    const submitted = "tc=no-code-response";
    const { send } = await harness.typeInChat(submitted, { chatId });
    send();
    await harness.bridge.settleInFlight();
    await waitFor(() => {
      expect(harness.getChatInputValue(chatId)).toBe("");
      const list = within(screen.getByTestId("messages-list"));
      expect(list.getAllByText(submitted)).toHaveLength(1);
      expect(list.getByText("submitted.txt")).toBeTruthy();
    });
  }, 60_000);

  it("restores the draft when the turn errors on a retired selection", async () => {
    const chatId = await harness.createChat();
    await harness.db
      .update(chats)
      .set({
        modelSelection: {
          provider: "auto",
          name: "auto",
          effortLevel: "medium",
        },
      })
      .where(eq(chats.id, chatId));
    harness.mount({ chatId });
    const submitted = "tc=no-code-response";
    const { send } = await harness.typeInChat(submitted, { chatId });
    send();
    await harness.bridge.settleInFlight();
    await waitFor(() => {
      expect(harness.getChatInputValue(chatId)).toBe(submitted);
    });
  }, 60_000);
});
