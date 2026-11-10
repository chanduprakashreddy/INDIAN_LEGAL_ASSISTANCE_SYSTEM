/**
 * Document server functions — now backed by the Python FastAPI backend.
 * The documents.tsx page calls the backend directly for most operations,
 * but these server functions are kept for any remaining server-side callers.
 */

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { DOCUMENT_TYPES, type Citation } from "./legal";

const BACKEND_URL =
  process.env["VITE_BACKEND_URL"] ||
  process.env["BACKEND_URL"] ||
  "http://localhost:8000";

const SessionInput = z.object({ sessionId: z.string().min(1) });

export type DocumentAnalysis = {
  documentType: string;
  summary: string;
  parties: string[];
  obligations: string[];
  dates: string[];
  risks: string[];
  nextSteps: string[];
  quality: string;
  cleanedText?: string | null;
};

export type StoredDocument = {
  id: string;
  filename: string;
  mimeType: string;
  fileSize: number;
  status: string;
  createdAt: string;
  analysis: DocumentAnalysis | null;
  cleanedText: string | null;
  fileUrl: string | null;
  enhancedUrl: string | null;
  matterId: string | null;
  // Legacy compat
  title: string;
};

export const listDocuments = createServerFn({ method: "GET" })
  .inputValidator((input: unknown) => SessionInput.parse(input))
  .handler(async ({ data }): Promise<StoredDocument[]> => {
    try {
      const response = await fetch(
        `${BACKEND_URL}/api/documents?sessionId=${encodeURIComponent(data.sessionId)}`,
      );
      if (!response.ok) return [];
      const docs = await response.json();
      return (docs ?? []).map((doc: Record<string, unknown>) => ({
        id: doc["id"] as string,
        filename: doc["filename"] as string,
        title: doc["filename"] as string,
        mimeType: doc["mimeType"] as string,
        fileSize: doc["fileSize"] as number,
        status: doc["analysis"] ? "analysed" : "uploaded",
        createdAt: doc["createdAt"] as string,
        analysis: (doc["analysis"] as DocumentAnalysis | null) ?? null,
        cleanedText: (doc["cleanedText"] as string) ?? null,
        fileUrl: null,
        enhancedUrl: null,
        matterId: null,
      }));
    } catch {
      return [];
    }
  });

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
    // Convert base64 to file and upload to backend
    const clean = data.base64.includes(",")
      ? data.base64.slice(data.base64.indexOf(",") + 1)
      : data.base64;
    const binary = atob(clean);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    const blob = new Blob([bytes], { type: data.mimeType });
    const formData = new FormData();
    formData.append("file", blob, data.fileName);
    formData.append("sessionId", data.sessionId);

    // Upload
    const uploadResponse = await fetch(`${BACKEND_URL}/api/upload`, {
      method: "POST",
      body: formData,
    });
    if (!uploadResponse.ok) throw new Error("Upload failed");
    const uploadResult = await uploadResponse.json();

    // Analyze
    const analyzeResponse = await fetch(`${BACKEND_URL}/api/analyze-document`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: data.sessionId,
        documentId: uploadResult.id,
        language: data.language,
      }),
    });
    if (!analyzeResponse.ok) throw new Error("Analysis failed");
    const analyzeResult = await analyzeResponse.json();

    return {
      id: uploadResult.id,
      analysis: analyzeResult.analysis,
      cleanedText: analyzeResult.analysis?.cleanedText ?? null,
      fileUrl: null,
    };
  });

export const enhanceDocumentScan = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    SessionInput.extend({ documentId: z.string() }).parse(input),
  )
  .handler(async () => {
    // Enhancement is not available without the Lovable gateway
    throw new Error("Document scan enhancement requires additional setup.");
  });

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
    const type = DOCUMENT_TYPES.find((entry) => entry.id === data.docType);
    const docTypeName = type?.name ?? data.docType;

    const response = await fetch(`${BACKEND_URL}/api/generate-document`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: data.sessionId,
        docType: docTypeName,
        language: data.language,
        fields: data.fields,
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({ error: "Generation failed" }));
      throw new Error(err.error || "Generation failed");
    }

    const result = await response.json();
    return {
      id: crypto.randomUUID(),
      title: `${docTypeName} — ${new Date().toLocaleDateString("en-IN")}`,
      content: result.content,
      citations: (result.citations ?? []) as Citation[],
    };
  });

export const listGeneratedDocuments = createServerFn({ method: "GET" })
  .inputValidator((input: unknown) => SessionInput.parse(input))
  .handler(async () => {
    // Generated documents are now handled inline — not stored separately
    return [];
  });

export const updateGeneratedDocument = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    SessionInput.extend({
      id: z.string(),
      content: z.string().min(1).max(60000),
    }).parse(input),
  )
  .handler(async () => {
    return { ok: true };
  });
