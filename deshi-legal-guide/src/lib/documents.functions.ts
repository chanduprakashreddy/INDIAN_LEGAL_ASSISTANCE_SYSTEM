import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { DOCUMENT_TYPES, type Citation } from "./legal";

const BUCKET = "legal-documents";

export type DocumentAnalysis = {
  documentType: string;
  summary: string;
  parties: string[];
  obligations: string[];
  dates: string[];
  risks: string[];
  nextSteps: string[];
  quality: string;
};

export type StoredDocument = {
  id: string;
  title: string;
  mimeType: string | null;
  status: string;
  createdAt: string;
  analysis: DocumentAnalysis | null;
  cleanedText: string | null;
  fileUrl: string | null;
  enhancedUrl: string | null;
  matterId: string | null;
};

const SessionInput = z.object({ sessionId: z.string().min(1) });

function base64ToBytes(base64: string): Uint8Array {
  const clean = base64.includes(",") ? base64.slice(base64.indexOf(",") + 1) : base64;
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function signedUrl(path: string | null): Promise<string | null> {
  if (!path) return null;
  const { data } = await supabaseAdmin.storage.from(BUCKET).createSignedUrl(path, 60 * 60);
  return data?.signedUrl ?? null;
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced?.[1] ?? raw).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string").slice(0, 12);
}

export const listDocuments = createServerFn({ method: "GET" })
  .inputValidator((input: unknown) => SessionInput.parse(input))
  .handler(async ({ data }): Promise<StoredDocument[]> => {
    const { data: rows, error } = await supabaseAdmin
      .from("user_documents")
      .select(
        "id, title, mime_type, status, created_at, analysis, cleaned_text, file_path, enhanced_path, matter_id",
      )
      .eq("session_id", data.sessionId)
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) throw new Error("Could not load your documents.");

    return Promise.all(
      (rows ?? []).map(async (row) => ({
        id: row.id,
        title: row.title,
        mimeType: row.mime_type,
        status: row.status,
        createdAt: row.created_at,
        analysis: (row.analysis as unknown as DocumentAnalysis | null) ?? null,
        cleanedText: row.cleaned_text,
        fileUrl: await signedUrl(row.file_path),
        enhancedUrl: await signedUrl(row.enhanced_path),
        matterId: row.matter_id,
      })),
    );
  });

/** Uploads a document, reads it and explains it in plain language. */
export const analyseDocument = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    SessionInput.extend({
      fileName: z.string().min(1).max(200),
      mimeType: z.string().min(3).max(120),
      base64: z.string().min(16),
      language: z.string().min(2).max(5).default("en"),
      matterId: z.string().uuid().nullable().optional(),
    }).parse(input),
  )
  .handler(async ({ data }) => {
    const { completeWithImages } = await import("./ai.server");
    type ChatPart =
      | { type: "text"; text: string }
      | { type: "image_url"; image_url: { url: string } }
      | { type: "file"; file: { filename: string; file_data: string } };
    const { languageLabel } = await import("./i18n");

    const bytes = base64ToBytes(data.base64);
    if (bytes.byteLength > 20 * 1024 * 1024) {
      throw new Error("That file is larger than 20 MB. Please upload a smaller scan.");
    }

    const path = `${data.sessionId}/${crypto.randomUUID()}-${data.fileName.replace(/[^\w.\-]+/g, "_")}`;
    const { error: uploadError } = await supabaseAdmin.storage
      .from(BUCKET)
      .upload(path, bytes, { contentType: data.mimeType, upsert: false });
    if (uploadError) {
      console.error("[documents] upload failed", uploadError);
      throw new Error("The document could not be uploaded.");
    }

    const dataUrl = `data:${data.mimeType};base64,${
      data.base64.includes(",") ? data.base64.slice(data.base64.indexOf(",") + 1) : data.base64
    }`;

    const isPdf = data.mimeType.includes("pdf");
    const parts: ChatPart[] = [
      {
        type: "text",
        text: [
          "Read this Indian legal document carefully.",
          "Return ONLY a JSON object with these keys:",
          '"documentType" (string), "summary" (string, 3-6 plain sentences), "parties" (array of strings),',
          '"obligations" (array of strings), "dates" (array of strings including any deadline or limitation period),',
          '"risks" (array of strings), "nextSteps" (array of strings), "quality" (string describing scan legibility),',
          '"cleanedText" (string: a faithful, well formatted typed transcription of the document).',
          `Write every value except "cleanedText" in ${languageLabel(data.language)}. Keep "cleanedText" in the document's own language.`,
          "If something is not legible, say so instead of guessing.",
        ].join("\n"),
      },
      isPdf
        ? { type: "file", file: { filename: data.fileName, file_data: dataUrl } }
        : { type: "image_url", image_url: { url: dataUrl } },
    ];

    let raw = "";
    try {
      raw = await completeWithImages([{ role: "user", content: parts }]);
    } catch (error) {
      console.error("[documents] analysis failed", error);
      throw error instanceof Error ? error : new Error("The document could not be read.");
    }

    const parsed = parseJsonObject(raw) ?? {};
    const text = (key: string): string | null => {
      const value = parsed[key];
      return typeof value === "string" && value.trim() ? value : null;
    };
    const analysis: DocumentAnalysis = {
      documentType: text("documentType") ?? "Legal document",
      summary: text("summary") ?? raw.slice(0, 1200),
      parties: stringArray(parsed["parties"]),
      obligations: stringArray(parsed["obligations"]),
      dates: stringArray(parsed["dates"]),
      risks: stringArray(parsed["risks"]),
      nextSteps: stringArray(parsed["nextSteps"]),
      quality: text("quality") ?? "",
    };
    const cleanedText = text("cleanedText");

    const { data: row, error } = await supabaseAdmin
      .from("user_documents")
      .insert({
        session_id: data.sessionId,
        matter_id: data.matterId ?? null,
        title: data.fileName,
        mime_type: data.mimeType,
        file_path: path,
        extracted_text: cleanedText,
        cleaned_text: cleanedText,
        analysis: analysis as unknown as Record<string, never>,
        status: "analysed",
      })
      .select("id")
      .single();
    if (error || !row) {
      console.error("[documents] save failed", error);
      throw new Error("The explanation could not be saved.");
    }

    return { id: row.id, analysis, cleanedText, fileUrl: await signedUrl(path) };
  });

/** Produces a restored, higher-quality image of a scanned page. */
export const enhanceDocumentScan = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    SessionInput.extend({ documentId: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }) => {
    const { enhanceScan } = await import("./ai.server");

    const { data: row } = await supabaseAdmin
      .from("user_documents")
      .select("id, file_path, mime_type")
      .eq("id", data.documentId)
      .eq("session_id", data.sessionId)
      .maybeSingle();
    if (!row) throw new Error("That document could not be found.");
    if (row.mime_type?.includes("pdf")) {
      throw new Error("Image enhancement works on photos and scans, not PDF files.");
    }

    const { data: file, error } = await supabaseAdmin.storage.from(BUCKET).download(row.file_path);
    if (error || !file) throw new Error("The original scan could not be read.");

    const bytes = new Uint8Array(await file.arrayBuffer());
    const b64 = await enhanceScan(
      bytes,
      row.mime_type ?? "image/jpeg",
      [
        "Restore this scanned legal document page.",
        "Deskew it, flatten shadows, remove creases and speckles, whiten the paper and sharpen the printed and handwritten text so every character is crisply legible.",
        "Keep the exact layout, stamps, seals, signatures and every word unchanged. Do not add, remove or rewrite any content.",
      ].join(" "),
    );

    const enhancedPath = `${data.sessionId}/${crypto.randomUUID()}-enhanced.png`;
    const enhancedBytes = base64ToBytes(b64);
    const { error: uploadError } = await supabaseAdmin.storage
      .from(BUCKET)
      .upload(enhancedPath, enhancedBytes, { contentType: "image/png", upsert: false });
    if (uploadError) throw new Error("The enhanced image could not be saved.");

    await supabaseAdmin
      .from("user_documents")
      .update({ enhanced_path: enhancedPath, status: "enhanced" })
      .eq("id", row.id);

    return { enhancedUrl: await signedUrl(enhancedPath) };
  });

/** Drafts an Indian legal document from guided form fields. */
export const generateDocument = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    SessionInput.extend({
      docType: z.string().min(2).max(60),
      language: z.string().min(2).max(5).default("en"),
      matterId: z.string().uuid().nullable().optional(),
      fields: z.record(z.string(), z.string().max(4000)),
    }).parse(input),
  )
  .handler(async ({ data }) => {
    const { completeText } = await import("./ai.server");
    const { languageLabel } = await import("./i18n");
    const { retrieveContext } = await import("./retrieval.server");

    const type = DOCUMENT_TYPES.find((entry) => entry.id === data.docType);
    if (!type) throw new Error("That document type is not available.");

    const details = Object.entries(data.fields)
      .filter(([, value]) => value.trim())
      .map(([key, value]) => `- ${key}: ${value.trim()}`)
      .join("\n");

    const retrieval = await retrieveContext(
      `${type.name} format and legal requirements under Indian law ${Object.values(data.fields).join(" ").slice(0, 400)}`,
    );

    const content = await completeText([
      {
        role: "system",
        content: [
          "You draft Indian legal documents that are ready to print, stamp and file.",
          "Follow standard Indian drafting conventions: title in capitals, numbered paragraphs, verification clause where applicable, place and date lines, signature blocks, and a list of enclosures when relevant.",
          "Use [square brackets] for anything the user must still fill in. Never invent facts, names, case numbers or dates that were not supplied.",
          `Write the document in ${languageLabel(data.language)}.`,
          "Return the document text only, formatted in markdown. No commentary.",
          retrieval.context
            ? `Relevant statutory passages for reference (cite section numbers inside the document only when you are certain):\n\n${retrieval.context}`
            : "",
        ]
          .filter(Boolean)
          .join("\n"),
      },
      {
        role: "user",
        content: `Draft a ${type.name} for use in India.\n\nDetails provided by the user:\n${details || "No details provided."}`,
      },
    ]);

    const title = `${type.name} — ${new Date().toLocaleDateString("en-IN")}`;
    const { data: row, error } = await supabaseAdmin
      .from("generated_documents")
      .insert({
        session_id: data.sessionId,
        matter_id: data.matterId ?? null,
        doc_type: data.docType,
        title,
        language: data.language,
        fields: data.fields,
        content,
      })
      .select("id")
      .single();
    if (error || !row) throw new Error("The draft could not be saved.");

    return {
      id: row.id,
      title,
      content,
      citations: retrieval.citations as Citation[],
    };
  });

export const listGeneratedDocuments = createServerFn({ method: "GET" })
  .inputValidator((input: unknown) => SessionInput.parse(input))
  .handler(async ({ data }) => {
    const { data: rows } = await supabaseAdmin
      .from("generated_documents")
      .select("id, title, doc_type, language, content, created_at")
      .eq("session_id", data.sessionId)
      .order("created_at", { ascending: false })
      .limit(50);
    return (rows ?? []).map((row) => ({
      id: row.id,
      title: row.title,
      docType: row.doc_type,
      language: row.language,
      content: row.content,
      createdAt: row.created_at,
    }));
  });

export const updateGeneratedDocument = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    SessionInput.extend({
      id: z.string().uuid(),
      content: z.string().min(1).max(60000),
    }).parse(input),
  )
  .handler(async ({ data }) => {
    await supabaseAdmin
      .from("generated_documents")
      .update({ content: data.content, updated_at: new Date().toISOString() })
      .eq("id", data.id)
      .eq("session_id", data.sessionId);
    return { ok: true };
  });
