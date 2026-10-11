// @vitest-environment node
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { chats, messages } from "@/db/schema";
import { eq } from "drizzle-orm";
import {
  setupChatFlowHarness,
  type ChatFlowHarness,
} from "@/testing/chat_flow_harness";

const h = vi.hoisted(() => {
  process.env.NODE_ENV = "development";
  return { ipcHandlers: new Map() };
});

vi.mock("electron", async () => {
  const { createElectronMock } = await import("@/testing/electron_mock");
  return createElectronMock(h);
});

describe("redo turn admission", () => {
  let harness: ChatFlowHarness;
  let originalMessages: Array<typeof messages.$inferSelect>;

  beforeAll(async () => {
    harness = await setupChatFlowHarness({ electronMock: h });
  }, 60_000);

  beforeEach(async () => {
    await harness.db
      .update(chats)
      .set({ modelSelection: null })
      .where(eq(chats.id, harness.chatId));
    await harness.db.delete(messages);
    originalMessages = await harness.db
      .insert(messages)
      .values([
        { chatId: harness.chatId, role: "user", content: "Earlier prompt" },
        { chatId: harness.chatId, role: "assistant", content: "Earlier reply" },
        { chatId: harness.chatId, role: "user", content: "Retry this prompt" },
        {
          chatId: harness.chatId,
          role: "assistant",
          content: "Original reply",
        },
      ])
      .returning();
  });

  afterAll(async () => {
    await harness?.dispose();
  });

  it("replaces only the latest exchange on redo", async () => {
    const result = await harness.streamChat("tc=no-code-response", {
      redo: true,
    });

    expect(result.eventsFor("chat:response:error")).toHaveLength(0);
    expect(result.messages).toHaveLength(4);
    expect(result.messages.slice(0, 2)).toEqual(originalMessages.slice(0, 2));
    expect(result.messages[2]).toMatchObject({
      role: "user",
      content: "tc=no-code-response",
    });
    expect(result.messages[3].role).toBe("assistant");
    expect(result.messages.map((message) => message.id)).not.toContain(
      originalMessages[3].id,
    );
  }, 30_000);

  it("surfaces a clear error when the stored selection is retired", async () => {
    await harness.db
      .update(chats)
      .set({
        modelSelection: {
          provider: "auto",
          name: "auto",
          effortLevel: "medium",
        },
      })
      .where(eq(chats.id, harness.chatId));

    const result = await harness.streamChat("tc=no-code-response", {
      redo: true,
    });

    expect(result.eventsFor("chat:response:error")).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          error: expect.stringContaining("Pick a specific provider"),
        }),
      }),
    ]);
    // The redo exchange was accepted (old reply replaced) before the retired
    // selection failed at client creation.
    expect(result.messages.slice(0, 2)).toEqual(originalMessages.slice(0, 2));
    expect(result.messages[2]).toMatchObject({
      role: "user",
      content: "tc=no-code-response",
    });
  }, 30_000);
});
