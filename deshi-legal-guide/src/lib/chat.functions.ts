import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import type { ChatTurn, Citation, Grounding, ThreadSummary } from "./legal";

const BACKEND_URL =
  process.env["VITE_BACKEND_URL"] ||
  process.env["BACKEND_URL"] ||
  "http://localhost:8000";

const SessionInput = z.object({ sessionId: z.string().min(1) });

export const listThreads = createServerFn({ method: "GET" })
  .inputValidator((input: unknown) => SessionInput.parse(input))
  .handler(async ({ data }): Promise<ThreadSummary[]> => {
    try {
      const response = await fetch(
        `${BACKEND_URL}/api/threads?sessionId=${encodeURIComponent(data.sessionId)}`,
      );
      if (!response.ok) throw new Error("Could not load your consultations.");
      const rows = (await response.json()) as ThreadSummary[];
      return rows;
    } catch (error) {
      console.error("[chat.functions] listThreads failed:", error);
      throw new Error("Could not load your consultations.");
    }
  });

export const getThread = createServerFn({ method: "GET" })
  .inputValidator((input: unknown) =>
    SessionInput.extend({ threadId: z.string().uuid() }).parse(input),
  )
  .handler(
    async ({
      data,
    }): Promise<{ thread: ThreadSummary; turns: ChatTurn[] } | null> => {
      try {
        const response = await fetch(
          `${BACKEND_URL}/api/threads/${data.threadId}?sessionId=${encodeURIComponent(data.sessionId)}`,
        );
        if (response.status === 404) return null;
        if (!response.ok) throw new Error("Could not load the consultation.");
        const result = (await response.json()) as {
          thread: ThreadSummary;
          turns: ChatTurn[];
        };
        return result;
      } catch (error) {
        console.error("[chat.functions] getThread failed:", error);
        return null;
      }
    },
  );

export const deleteThread = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    SessionInput.extend({ threadId: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }) => {
    try {
      await fetch(
        `${BACKEND_URL}/api/threads/${data.threadId}?sessionId=${encodeURIComponent(data.sessionId)}`,
        { method: "DELETE" },
      );
    } catch (error) {
      console.error("[chat.functions] deleteThread failed:", error);
    }
    return { ok: true };
  });

export const translateText = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({ text: z.string().min(1).max(20000), language: z.string().min(2).max(5) })
      .parse(input),
  )
  .handler(async ({ data }) => {
    // Translation still uses the original AI server module if available
    try {
      const { completeText } = await import("./ai.server");
      const { languageLabel } = await import("./i18n");
      const text = await completeText([
        {
          role: "system",
          content:
            "You are a legal translator for Indian languages. Translate faithfully, preserve markdown structure, bracketed citation numbers and Act/section names in their official form, and do not add commentary.",
        },
        {
          role: "user",
          content: `Translate the following into ${languageLabel(data.language)}:\n\n${data.text}`,
        },
      ]);
      return { text };
    } catch {
      return { text: data.text };
    }
  });
