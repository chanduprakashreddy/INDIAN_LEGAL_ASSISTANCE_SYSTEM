// Server-only AI helpers.
// Answer generation prefers the user's OpenRouter key when present and
// falls back to the built-in Lovable AI gateway so the app always works.

const GATEWAY = "https://ai.gateway.lovable.dev/v1";
const OPENROUTER = "https://openrouter.ai/api/v1";

export const EMBEDDING_MODEL = "google/gemini-embedding-2";
const OPENROUTER_DEFAULT_MODEL = "google/gemini-2.5-flash";
const GATEWAY_REASONING_MODEL = "openai/gpt-6-astra";
const GATEWAY_IMAGE_EDIT_MODEL = "openai/gpt-image-2.5-sunburst";

export type TextPart = { type: "text"; text: string };
export type ImagePart = { type: "image_url"; image_url: { url: string } };
export type FilePart = {
  type: "file";
  file: { filename: string; file_data: string };
};
export type ChatPart = TextPart | ImagePart | FilePart;

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string | ChatPart[];
};

function lovableKey(): string {
  const key = process.env["LOVABLE_API_KEY"];
  if (!key) throw new Error("AI is not configured for this project yet.");
  return key;
}

function openRouterKey(): string | undefined {
  const key = process.env["OPENROUTER_API_KEY"];
  return key && key.trim() ? key.trim() : undefined;
}

export function answerEngine(): "openrouter" | "lovable" {
  return openRouterKey() ? "openrouter" : "lovable";
}

async function assertOk(response: Response, label: string) {
  if (response.ok) return;
  const body = await response.text().catch(() => "");
  console.error(`[ai] ${label} failed`, response.status, body.slice(0, 600));
  if (response.status === 429) {
    throw new Error("The assistant is receiving too many requests right now. Please retry in a moment.");
  }
  if (response.status === 402) {
    throw new Error("The AI allowance for this project is used up. Add credits to continue.");
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error("The AI service rejected the request. Please check the configured API key.");
  }
  throw new Error("The assistant could not complete this request.");
}

/** Reads an SSE body and yields `data:` payload strings. */
async function* sseEvents(response: Response): AsyncGenerator<string> {
  if (!response.body) return;
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let index: number;
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload && payload !== "[DONE]") yield payload;
    }
  }
}

/** Streams from the built-in Lovable AI gateway (supports text, images, PDFs). */
async function* streamGateway(messages: ChatMessage[]): AsyncGenerator<string> {
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => (typeof m.content === "string" ? m.content : ""))
    .join("\n\n");

  const input = messages
    .filter((m) => m.role !== "system")
    .map((message) => ({
      role: message.role,
      content:
        typeof message.content === "string"
          ? [
              {
                type: message.role === "assistant" ? "output_text" : "input_text",
                text: message.content,
              },
            ]
          : message.content.map((part) => {
              if (part.type === "text") return { type: "input_text", text: part.text };
              if (part.type === "image_url")
                return { type: "input_image", image_url: part.image_url.url };
              return {
                type: "input_file",
                filename: part.file.filename,
                file_data: part.file.file_data,
              };
            }),
    }));

  const response = await fetch(`${GATEWAY}/responses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Lovable-API-Key": lovableKey(),
      "X-Lovable-AIG-SDK": "fetch",
    },
    body: JSON.stringify({
      model: GATEWAY_REASONING_MODEL,
      instructions: system || undefined,
      input,
      stream: true,
      store: false,
      reasoning: { effort: "low", summary: "auto" },
    }),
  });
  await assertOk(response, "gateway responses");

  for await (const payload of sseEvents(response)) {
    try {
      const event = JSON.parse(payload) as { type?: string; delta?: string };
      if (event.type === "response.output_text.delta" && event.delta) yield event.delta;
    } catch {
      // ignore
    }
  }
}

/** Streams the assistant answer as plain text deltas. */
export async function* streamAnswer(messages: ChatMessage[]): AsyncGenerator<string> {
  const orKey = openRouterKey();

  if (!orKey) {
    yield* streamGateway(messages);
    return;
  }

  const response = await fetch(`${OPENROUTER}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${orKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env["OPENROUTER_MODEL"] || OPENROUTER_DEFAULT_MODEL,
      messages,
      stream: true,
    }),
  });
  await assertOk(response, "openrouter chat");
  for await (const payload of sseEvents(response)) {
    try {
      const event = JSON.parse(payload) as {
        choices?: { delta?: { content?: string } }[];
      };
      const delta = event.choices?.[0]?.delta?.content;
      if (delta) yield delta;
    } catch {
      // ignore keep-alive frames
    }
  }
}

/** Buffered text completion built on the streaming path. */
export async function completeText(messages: ChatMessage[]): Promise<string> {
  let text = "";
  for await (const delta of streamAnswer(messages)) text += delta;
  return text.trim();
}

/**
 * Multimodal completion (scans, photos, PDFs) always runs on the built-in
 * gateway, which accepts document and image input regardless of which
 * OpenRouter model is configured for chat.
 */
export async function completeWithImages(messages: ChatMessage[]): Promise<string> {
  let text = "";
  for await (const delta of streamGateway(messages)) text += delta;
  return text.trim();
}

/** Embeds text for retrieval. Batches of at most 100 inputs. */
export async function embedTexts(inputs: string[]): Promise<number[][]> {
  const vectors: number[][] = [];
  for (let start = 0; start < inputs.length; start += 50) {
    const batch = inputs.slice(start, start + 50);
    const response = await fetch(`${GATEWAY}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${lovableKey()}`,
      },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: batch }),
    });
    await assertOk(response, "gateway embeddings");
    const payload = (await response.json()) as {
      data: { index: number; embedding: number[] }[];
    };
    const sorted = [...payload.data].sort((a, b) => a.index - b.index);
    for (const item of sorted) vectors.push(item.embedding);
  }
  return vectors;
}

export async function embedText(input: string): Promise<number[]> {
  const [vector] = await embedTexts([input]);
  if (!vector) throw new Error("The question could not be prepared for search.");
  return vector;
}

/** Restores / upscales a scanned document image. Returns base64 PNG. */
export async function enhanceScan(
  bytes: Uint8Array,
  mimeType: string,
  instruction: string,
): Promise<string> {
  const form = new FormData();
  form.append("model", GATEWAY_IMAGE_EDIT_MODEL);
  form.append("prompt", instruction);
  form.append("size", "1024x1536");
  form.append(
    "image",
    new Blob([bytes as unknown as BlobPart], { type: mimeType }),
    `scan.${mimeType.includes("png") ? "png" : "jpg"}`,
  );

  const response = await fetch(`${GATEWAY}/images/edits`, {
    method: "POST",
    headers: { Authorization: `Bearer ${lovableKey()}` },
    body: form,
  });
  await assertOk(response, "gateway image edit");
  const payload = (await response.json()) as { data?: { b64_json?: string }[] };
  const b64 = payload.data?.[0]?.b64_json;
  if (!b64) throw new Error("The enhanced image could not be produced.");
  return b64;
}
