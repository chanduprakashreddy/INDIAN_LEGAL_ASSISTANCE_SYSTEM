import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
  AlertTriangle,
  ArrowLeftRight,
  CheckCircle2,
  Copy,
  Download,
  FileDown,
  FileSearch,
  FileText,
  Loader2,
  RefreshCw,
  Search,
  Shield,
  Sparkles,
  Upload,
  Wand2,
  XCircle,
} from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";

import { AppShell, LanguagePicker } from "@/components/app-shell";
import { useLanguage } from "@/components/language-provider";
import { MarkdownText } from "@/components/markdown-text";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useSessionId } from "@/hooks/use-session";
import {
  DOCUMENT_TYPES,
  type AuthenticityResult,
  type CompareResult,
  type EnhanceResult,
  type RestoreResult,
  type SummarizeResult,
  type DocumentQAResult,
} from "@/lib/legal";

const BACKEND_URL =
  (import.meta.env["VITE_BACKEND_URL"] as string | undefined) || "http://localhost:8000";

export const Route = createFileRoute("/documents")({
  head: () => ({
    meta: [
      { title: "Document Intelligence — NyayaSahay" },
      {
        name: "description",
        content:
          "AI-powered document generation, enhancement, restoration, analysis, authenticity assessment, and comparison for Indian legal documents.",
      },
      { property: "og:title", content: "Document Intelligence — NyayaSahay" },
      {
        property: "og:description",
        content:
          "AI-powered legal document intelligence — generate, enhance, restore, analyze, verify, and compare.",
      },
    ],
  }),
  component: DocumentsPage,
});

/* ── Helpers ─────────────────────────────────────────────────────── */

type DocumentAnalysisData = {
  documentType?: string;
  summary?: string;
  parties?: string[];
  obligations?: string[];
  dates?: string[];
  risks?: string[];
  nextSteps?: string[];
  quality?: string;
  cleanedText?: string | null;
};

type StoredDocument = {
  id: string;
  filename: string;
  mimeType: string;
  fileSize: number;
  analysis: DocumentAnalysisData | null;
  cleanedText: string | null;
  createdAt: string;
  threadId: string | null;
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function uploadFile(file: File, sessionId: string): Promise<{ id: string; filename: string; mimeType: string }> {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("sessionId", sessionId);
  const response = await fetch(`${BACKEND_URL}/api/upload`, {
    method: "POST",
    body: formData,
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: "Upload failed" }));
    throw new Error(err.error || "Upload failed");
  }
  return response.json();
}

async function downloadExport(content: string, title: string, type: "pdf" | "docx") {
  const endpoint = type === "pdf" ? "/api/export-pdf" : "/api/export-docx";
  const response = await fetch(`${BACKEND_URL}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, title }),
  });
  if (!response.ok) throw new Error(`Export failed`);
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const safeName = title.replace(/[^a-zA-Z0-9_\-\s]/g, "").trim().replace(/\s+/g, "_");
  a.download = `${safeName || "document"}.${type}`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* ── Tab 1: Generate ─────────────────────────────────────────────── */

function GenerateTab() {
  const sessionId = useSessionId();
  const { language } = useLanguage();
  const [mode, setMode] = useState<"template" | "freeform">("freeform");
  const [typeId, setTypeId] = useState<string>(DOCUMENT_TYPES[0].id);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [freeText, setFreeText] = useState("");
  const [draftText, setDraftText] = useState("");
  const [generating, setGenerating] = useState(false);
  const [downloading, setDownloading] = useState<"pdf" | "docx" | null>(null);

  const type = DOCUMENT_TYPES.find((entry) => entry.id === typeId)!;

  const handleGenerate = useCallback(async () => {
    if (!sessionId) return;
    setGenerating(true);
    try {
      const body =
        mode === "template"
          ? {
              sessionId,
              language,
              docType: type.name,
              fields,
              freeText: freeText || undefined,
            }
          : {
              sessionId,
              language,
              docType: "Custom Legal Document",
              freeText,
            };

      const response = await fetch(`${BACKEND_URL}/api/generate-document`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({ error: "Generation failed" }));
        throw new Error(err.error || "Generation failed");
      }

      const result = await response.json();
      setDraftText(result.content);
      toast.success("Draft ready. Review and edit before you use it.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Drafting failed.");
    } finally {
      setGenerating(false);
    }
  }, [sessionId, type.name, language, fields, freeText, mode]);

  const handleDownload = useCallback(
    async (exportType: "pdf" | "docx") => {
      if (!draftText) return;
      setDownloading(exportType);
      try {
        await downloadExport(draftText, "Legal Document", exportType);
        toast.success(`${exportType.toUpperCase()} downloaded!`);
      } catch {
        toast.error("Download failed");
      } finally {
        setDownloading(null);
      }
    },
    [draftText],
  );

  const missing =
    mode === "template"
      ? type.fields.filter((field) => field.required && !fields[field.name]?.trim())
      : [];
  const canGenerate =
    mode === "freeform" ? freeText.trim().length > 10 : missing.length === 0;

  return (
    <div className="grid gap-6 lg:grid-cols-[24rem_1fr]">
      <Card>
        <CardHeader>
          <CardTitle className="font-serif text-base">Generate Document</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Mode selector */}
          <div className="grid gap-2">
            <Label>Input mode</Label>
            <div className="flex gap-2">
              <Button
                variant={mode === "freeform" ? "default" : "outline"}
                size="sm"
                onClick={() => setMode("freeform")}
              >
                <Sparkles className="mr-1.5 size-3.5" /> Natural language
              </Button>
              <Button
                variant={mode === "template" ? "default" : "outline"}
                size="sm"
                onClick={() => setMode("template")}
              >
                <FileText className="mr-1.5 size-3.5" /> Template
              </Button>
            </div>
          </div>

          {mode === "freeform" ? (
            <div className="grid gap-2">
              <Label htmlFor="freeTextInput">
                Describe the document you need
              </Label>
              <Textarea
                id="freeTextInput"
                rows={6}
                placeholder={
                  'E.g. "Generate a legal notice for a tenant who has not paid rent for 6 months" or "Draft a rental agreement between Amit and Suresh for a flat in Mumbai"'
                }
                value={freeText}
                onChange={(e) => setFreeText(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Describe what you need in plain language. The AI will identify the document
                type, retrieve relevant legal provisions, and generate a professional draft.
              </p>
            </div>
          ) : (
            <>
              <div className="grid gap-2">
                <Label>Document type</Label>
                <div className="grid gap-2 max-h-48 overflow-y-auto">
                  {DOCUMENT_TYPES.map((entry) => (
                    <button
                      key={entry.id}
                      type="button"
                      onClick={() => {
                        setTypeId(entry.id);
                        setFields({});
                      }}
                      className={`rounded-md border p-3 text-left text-sm transition-colors ${
                        entry.id === typeId
                          ? "border-primary bg-primary/5"
                          : "border-border hover:bg-accent/50"
                      }`}
                    >
                      <span className="font-medium">{entry.name}</span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        {entry.blurb}
                      </span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-3 border-t border-border pt-4">
                {type.fields.map((field) => (
                  <div key={field.name} className="grid gap-1.5">
                    <Label htmlFor={field.name}>
                      {field.label}
                      {field.required && <span className="text-destructive"> *</span>}
                    </Label>
                    {"long" in field && field.long ? (
                      <Textarea
                        id={field.name}
                        rows={4}
                        value={fields[field.name] ?? ""}
                        onChange={(event) =>
                          setFields((current) => ({
                            ...current,
                            [field.name]: event.target.value,
                          }))
                        }
                      />
                    ) : (
                      <Input
                        id={field.name}
                        value={fields[field.name] ?? ""}
                        onChange={(event) =>
                          setFields((current) => ({
                            ...current,
                            [field.name]: event.target.value,
                          }))
                        }
                      />
                    )}
                  </div>
                ))}

                <div className="grid gap-1.5 border-t border-border pt-3">
                  <Label htmlFor="freeText">Additional instructions (optional)</Label>
                  <Textarea
                    id="freeText"
                    rows={3}
                    placeholder="Any special requirements or additional details..."
                    value={freeText}
                    onChange={(e) => setFreeText(e.target.value)}
                  />
                </div>
              </div>
            </>
          )}

          <Button
            className="w-full"
            disabled={generating || !canGenerate || !sessionId}
            onClick={handleGenerate}
          >
            {generating ? (
              <>
                <Loader2 className="size-4 animate-spin" /> Generating…
              </>
            ) : (
              <>
                <Sparkles className="size-4" /> Generate Document
              </>
            )}
          </Button>
          {mode === "template" && missing.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Fill in: {missing.map((field) => field.label).join(", ")}
            </p>
          )}
        </CardContent>
      </Card>

      <Card className="min-h-[28rem]">
        <CardHeader className="flex-row items-center justify-between gap-2">
          <CardTitle className="font-serif text-base">Draft</CardTitle>
          {draftText && (
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={downloading === "pdf"}
                onClick={() => handleDownload("pdf")}
              >
                {downloading === "pdf" ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Download className="size-4" />
                )}
                PDF
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={downloading === "docx"}
                onClick={() => handleDownload("docx")}
              >
                {downloading === "docx" ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <FileDown className="size-4" />
                )}
                Word
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  navigator.clipboard.writeText(draftText);
                  toast.success("Copied!");
                }}
              >
                <Copy className="size-4" />
              </Button>
            </div>
          )}
        </CardHeader>
        <CardContent>
          {draftText ? (
            <Textarea
              value={draftText}
              onChange={(event) => setDraftText(event.target.value)}
              className="min-h-[24rem] font-serif text-sm leading-relaxed"
            />
          ) : (
            <div className="flex min-h-[22rem] flex-col items-center justify-center text-center text-sm text-muted-foreground">
              <FileText className="size-8 text-primary/60" />
              <p className="mt-3 max-w-sm">
                Describe the document you need in natural language or choose a template.
                A RAG-powered draft will appear here for you to review and edit.
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/* ── Tab 2: Enhance ──────────────────────────────────────────────── */

function EnhanceTab() {
  const sessionId = useSessionId();
  const { language } = useLanguage();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [processing, setProcessing] = useState(false);
  const [mode, setMode] = useState("professional");
  const [result, setResult] = useState<EnhanceResult | null>(null);
  const [fileName, setFileName] = useState("");

  const handleFile = useCallback(
    async (file: File | undefined) => {
      if (!file || !sessionId) return;
      setProcessing(true);
      setResult(null);
      setFileName(file.name);
      try {
        const uploaded = await uploadFile(file, sessionId);
        const response = await fetch(`${BACKEND_URL}/api/document-intelligence/enhance`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId,
            documentId: uploaded.id,
            mode,
            language,
          }),
        });
        if (!response.ok) {
          const err = await response.json().catch(() => ({ error: "Enhancement failed" }));
          throw new Error(err.error || "Enhancement failed");
        }
        const data = await response.json();
        setResult(data as EnhanceResult);
        toast.success("Document enhanced successfully!");
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Enhancement failed.");
      } finally {
        setProcessing(false);
      }
    },
    [sessionId, language, mode],
  );

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="font-serif text-base flex items-center gap-2">
            <Wand2 className="size-5 text-primary" /> Document Enhancement
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2">
            <Label>Enhancement mode</Label>
            <Select value={mode} onValueChange={setMode}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="basic">Basic — Grammar & clarity</SelectItem>
                <SelectItem value="professional">Professional — Formal tone & structure</SelectItem>
                <SelectItem value="legal">Legal — Legal drafting standards</SelectItem>
                <SelectItem value="advanced">Advanced — Complete restructuring</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <label className="flex cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-border bg-muted/30 px-6 py-10 text-center transition-colors hover:bg-muted/60">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*,application/pdf,.doc,.docx,.txt"
              className="hidden"
              disabled={processing}
              onChange={(event) => void handleFile(event.target.files?.[0])}
            />
            {processing ? (
              <Loader2 className="size-7 animate-spin text-primary" />
            ) : (
              <Upload className="size-7 text-primary" />
            )}
            <span className="mt-3 text-sm font-medium">
              {processing ? "Enhancing your document…" : "Upload a document to enhance"}
            </span>
            <span className="mt-1 text-xs text-muted-foreground">
              PDF, Word, text, or image — up to 20 MB
            </span>
          </label>
        </CardContent>
      </Card>

      {result && result.success && (
        <Card>
          <CardHeader className="flex-row items-center justify-between gap-2">
            <CardTitle className="font-serif text-base">
              Enhanced: {fileName}
            </CardTitle>
            <div className="flex gap-2">
              <Badge variant="secondary">{result.mode}</Badge>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  navigator.clipboard.writeText(result.enhanced_text);
                  toast.success("Enhanced text copied!");
                }}
              >
                <Copy className="size-4" /> Copy
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => downloadExport(result.enhanced_text, `Enhanced ${fileName}`, "docx")}
              >
                <FileDown className="size-4" /> Word
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {result.improvements.length > 0 && (
              <div>
                <h3 className="font-serif text-sm font-semibold mb-2">Improvements Made</h3>
                <ul className="list-disc space-y-1 pl-4 text-sm text-muted-foreground">
                  {result.improvements.map((item, i) => (
                    <li key={i}>{item}</li>
                  ))}
                </ul>
              </div>
            )}
            <div className="rounded-md border border-border p-4">
              <MarkdownText content={result.enhanced_text} />
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/* ── Tab 3: Restore ──────────────────────────────────────────────── */

function RestoreTab() {
  const sessionId = useSessionId();
  const { language } = useLanguage();
  const [processing, setProcessing] = useState(false);
  const [result, setResult] = useState<RestoreResult | null>(null);
  const [fileName, setFileName] = useState("");

  const handleFile = useCallback(
    async (file: File | undefined) => {
      if (!file || !sessionId) return;
      setProcessing(true);
      setResult(null);
      setFileName(file.name);
      try {
        const uploaded = await uploadFile(file, sessionId);
        const response = await fetch(`${BACKEND_URL}/api/document-intelligence/restore`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, documentId: uploaded.id, language }),
        });
        if (!response.ok) {
          const err = await response.json().catch(() => ({ error: "Restoration failed" }));
          throw new Error(err.error || "Restoration failed");
        }
        const data = await response.json();
        setResult(data as RestoreResult);
        toast.success("Document restored!");
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Restoration failed.");
      } finally {
        setProcessing(false);
      }
    },
    [sessionId, language],
  );

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="font-serif text-base flex items-center gap-2">
            <RefreshCw className="size-5 text-primary" /> Document Restoration
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground mb-4">
            Upload old, faded, blurred, or damaged documents. The AI will enhance the image
            quality, extract text using advanced OCR, and produce a clean digital copy.
          </p>
          <label className="flex cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-border bg-muted/30 px-6 py-10 text-center transition-colors hover:bg-muted/60">
            <input
              type="file"
              accept="image/*,application/pdf"
              className="hidden"
              disabled={processing}
              onChange={(event) => void handleFile(event.target.files?.[0])}
            />
            {processing ? (
              <Loader2 className="size-7 animate-spin text-primary" />
            ) : (
              <RefreshCw className="size-7 text-primary" />
            )}
            <span className="mt-3 text-sm font-medium">
              {processing
                ? "Restoring — this may take a moment…"
                : "Upload a faded, blurred, or damaged document"}
            </span>
            <span className="mt-1 text-xs text-muted-foreground">
              Scanned images and PDFs work best
            </span>
          </label>
        </CardContent>
      </Card>

      {result && result.success && (
        <Card>
          <CardHeader className="flex-row items-center justify-between gap-2">
            <CardTitle className="font-serif text-base">
              Restored: {fileName}
            </CardTitle>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                navigator.clipboard.writeText(result.extracted_text);
                toast.success("Extracted text copied!");
              }}
            >
              <Copy className="size-4" /> Copy Text
            </Button>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap gap-2">
              <Badge variant="secondary">
                Quality: {result.quality_assessment}
              </Badge>
            </div>
            {result.improvements.length > 0 && (
              <div>
                <h3 className="font-serif text-sm font-semibold mb-2">Processing Steps</h3>
                <ul className="list-disc space-y-1 pl-4 text-sm text-muted-foreground">
                  {result.improvements.map((item, i) => (
                    <li key={i}>{item}</li>
                  ))}
                </ul>
              </div>
            )}
            <div>
              <h3 className="font-serif text-sm font-semibold mb-2">Extracted Text</h3>
              <div className="rounded-md border border-border p-4 max-h-96 overflow-y-auto">
                <pre className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/80">
                  {result.extracted_text}
                </pre>
              </div>
            </div>
            {result.restored_path && (
              <Button
                variant="outline"
                onClick={() => {
                  const fileName = result.restored_path!.split("/").pop() || result.restored_path!.split("\\").pop();
                  window.open(`${BACKEND_URL}/api/document-intelligence/enhanced/${fileName}`, "_blank");
                }}
              >
                <Download className="size-4" /> Download Enhanced Image
              </Button>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/* ── Tab 4: Analyze ──────────────────────────────────────────────── */

function AnalyzeTab() {
  const sessionId = useSessionId();
  const { language } = useLanguage();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  const [qaDocId, setQaDocId] = useState<string | null>(null);
  const [qaQuestion, setQaQuestion] = useState("");
  const [qaAnswer, setQaAnswer] = useState<string | null>(null);
  const [qaLoading, setQaLoading] = useState(false);

  const documentsQuery = useQuery({
    queryKey: ["documents", sessionId],
    queryFn: async (): Promise<StoredDocument[]> => {
      const response = await fetch(
        `${BACKEND_URL}/api/documents?sessionId=${encodeURIComponent(sessionId)}`,
      );
      if (!response.ok) throw new Error("Could not load documents");
      return response.json();
    },
    enabled: Boolean(sessionId),
  });

  const onFile = useCallback(
    async (file: File | undefined) => {
      if (!file || !sessionId) return;
      setPending(true);
      try {
        const uploaded = await uploadFile(file, sessionId);
        const analyzeResponse = await fetch(`${BACKEND_URL}/api/analyze-document`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId,
            documentId: uploaded.id,
            language,
          }),
        });
        if (!analyzeResponse.ok) {
          const err = await analyzeResponse.json().catch(() => ({ error: "Analysis failed" }));
          throw new Error(err.error || "Analysis failed");
        }
        await queryClient.invalidateQueries({ queryKey: ["documents", sessionId] });
        toast.success("Document analyzed successfully!");
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Analysis failed.");
      } finally {
        setPending(false);
      }
    },
    [sessionId, language, queryClient],
  );

  const handleQA = useCallback(async () => {
    if (!qaDocId || !qaQuestion.trim() || !sessionId) return;
    setQaLoading(true);
    setQaAnswer(null);
    try {
      const response = await fetch(`${BACKEND_URL}/api/document-intelligence/qa`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          documentId: qaDocId,
          question: qaQuestion,
          language,
        }),
      });
      if (!response.ok) throw new Error("Could not get answer");
      const data = (await response.json()) as DocumentQAResult;
      setQaAnswer(data.answer);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Q&A failed");
    } finally {
      setQaLoading(false);
    }
  }, [qaDocId, qaQuestion, sessionId, language]);

  const docs = documentsQuery.data ?? [];

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="font-serif text-base flex items-center gap-2">
            <FileSearch className="size-5 text-primary" /> Document Analysis
          </CardTitle>
        </CardHeader>
        <CardContent>
          <label className="flex cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-border bg-muted/30 px-6 py-10 text-center transition-colors hover:bg-muted/60">
            <input
              type="file"
              accept="image/*,application/pdf,.doc,.docx,.txt"
              className="hidden"
              disabled={pending}
              onChange={(event) => void onFile(event.target.files?.[0])}
            />
            {pending ? (
              <Loader2 className="size-7 animate-spin text-primary" />
            ) : (
              <Upload className="size-7 text-primary" />
            )}
            <span className="mt-3 text-sm font-medium">
              {pending ? "Analyzing your document…" : "Upload a document to analyze"}
            </span>
            <span className="mt-1 text-xs text-muted-foreground">
              PDF, image, Word, or text — up to 20 MB
            </span>
          </label>
        </CardContent>
      </Card>

      {/* Q&A Section */}
      {docs.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="font-serif text-base flex items-center gap-2">
              <Search className="size-5 text-primary" /> Ask About a Document
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Select value={qaDocId ?? ""} onValueChange={setQaDocId}>
              <SelectTrigger>
                <SelectValue placeholder="Select a document" />
              </SelectTrigger>
              <SelectContent>
                {docs.map((doc) => (
                  <SelectItem key={doc.id} value={doc.id}>
                    {doc.filename}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="flex gap-2">
              <Input
                placeholder="Ask a question about this document..."
                value={qaQuestion}
                onChange={(e) => setQaQuestion(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleQA();
                }}
              />
              <Button disabled={qaLoading || !qaDocId || !qaQuestion.trim()} onClick={handleQA}>
                {qaLoading ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
              </Button>
            </div>
            {qaAnswer && (
              <div className="rounded-md border border-border p-4">
                <MarkdownText content={qaAnswer} />
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Analyzed documents list */}
      <div className="space-y-4">
        {docs.map((document) => (
          <Card key={document.id}>
            <CardHeader className="flex-row items-start justify-between gap-3">
              <div className="min-w-0">
                <CardTitle className="truncate font-serif text-base">
                  {document.filename}
                </CardTitle>
                <p className="mt-1 text-xs text-muted-foreground">
                  {document.analysis?.documentType ?? "Document"} ·{" "}
                  {formatBytes(document.fileSize)} ·{" "}
                  {new Date(document.createdAt).toLocaleString("en-IN")}
                </p>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {document.analysis?.summary && (
                <MarkdownText content={document.analysis.summary} />
              )}
              <div className="grid gap-4 sm:grid-cols-2">
                {(
                  [
                    ["Parties", document.analysis?.parties],
                    ["What it requires", document.analysis?.obligations],
                    ["Dates and deadlines", document.analysis?.dates],
                    ["Risks to watch", document.analysis?.risks],
                    ["Suggested next steps", document.analysis?.nextSteps],
                  ] as const
                )
                  .filter(([, items]) => items && items.length > 0)
                  .map(([heading, items]) => (
                    <div key={heading}>
                      <h3 className="font-serif text-sm font-semibold">{heading}</h3>
                      <ul className="mt-1 list-disc space-y-1 pl-4 text-sm text-muted-foreground">
                        {items!.map((item, index) => (
                          <li key={index}>{item}</li>
                        ))}
                      </ul>
                    </div>
                  ))}
              </div>
              {document.cleanedText && (
                <details className="rounded-md border border-border p-3">
                  <summary className="cursor-pointer text-sm font-medium">
                    Typed transcription
                  </summary>
                  <pre className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-foreground/80">
                    {document.cleanedText}
                  </pre>
                </details>
              )}
            </CardContent>
          </Card>
        ))}
        {docs.length === 0 && !pending && (
          <p className="text-sm text-muted-foreground">
            Documents you upload will be analyzed and displayed here.
          </p>
        )}
      </div>
    </div>
  );
}

/* ── Tab 5: Authenticity ─────────────────────────────────────────── */

function AuthenticityTab() {
  const sessionId = useSessionId();
  const { language } = useLanguage();
  const [processing, setProcessing] = useState(false);
  const [result, setResult] = useState<AuthenticityResult | null>(null);
  const [fileName, setFileName] = useState("");

  const handleFile = useCallback(
    async (file: File | undefined) => {
      if (!file || !sessionId) return;
      setProcessing(true);
      setResult(null);
      setFileName(file.name);
      try {
        const uploaded = await uploadFile(file, sessionId);
        const response = await fetch(
          `${BACKEND_URL}/api/document-intelligence/authenticity`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sessionId, documentId: uploaded.id, language }),
          },
        );
        if (!response.ok) {
          const err = await response.json().catch(() => ({ error: "Assessment failed" }));
          throw new Error(err.error || "Assessment failed");
        }
        const data = await response.json();
        setResult(data as AuthenticityResult);
        toast.success("Authenticity assessment complete!");
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Assessment failed.");
      } finally {
        setProcessing(false);
      }
    },
    [sessionId, language],
  );

  const riskColor = (level: string) => {
    const l = level.toLowerCase();
    if (l.includes("low")) return "text-green-600";
    if (l.includes("medium")) return "text-yellow-600";
    if (l.includes("high") || l.includes("critical")) return "text-red-600";
    return "text-muted-foreground";
  };

  const severityIcon = (severity: string) => {
    const s = severity.toLowerCase();
    if (s.includes("low") || s.includes("info"))
      return <CheckCircle2 className="size-4 text-green-500 shrink-0" />;
    if (s.includes("medium") || s.includes("warning"))
      return <AlertTriangle className="size-4 text-yellow-500 shrink-0" />;
    return <XCircle className="size-4 text-red-500 shrink-0" />;
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="font-serif text-base flex items-center gap-2">
            <Shield className="size-5 text-primary" /> Authenticity Assessment
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground mb-4">
            Upload a document to check for signs of tampering, inconsistencies,
            or suspicious elements. The assessment analyzes metadata, structure,
            text consistency, and visual properties.
          </p>
          <label className="flex cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-border bg-muted/30 px-6 py-10 text-center transition-colors hover:bg-muted/60">
            <input
              type="file"
              accept="image/*,application/pdf,.doc,.docx"
              className="hidden"
              disabled={processing}
              onChange={(event) => void handleFile(event.target.files?.[0])}
            />
            {processing ? (
              <Loader2 className="size-7 animate-spin text-primary" />
            ) : (
              <Shield className="size-7 text-primary" />
            )}
            <span className="mt-3 text-sm font-medium">
              {processing
                ? "Assessing authenticity…"
                : "Upload a document to verify"}
            </span>
          </label>
        </CardContent>
      </Card>

      {result && result.success && (
        <Card>
          <CardHeader>
            <CardTitle className="font-serif text-base">
              Assessment: {fileName}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap gap-3">
              <div className="rounded-md border border-border p-3 text-center min-w-[120px]">
                <p className="text-xs text-muted-foreground">Risk Level</p>
                <p className={`text-lg font-bold ${riskColor(result.overall_risk_level)}`}>
                  {result.overall_risk_level}
                </p>
              </div>
              <div className="rounded-md border border-border p-3 text-center min-w-[120px]">
                <p className="text-xs text-muted-foreground">Confidence</p>
                <p className="text-lg font-bold">{result.confidence}</p>
              </div>
            </div>

            {result.findings.length > 0 && (
              <div>
                <h3 className="font-serif text-sm font-semibold mb-2">Findings</h3>
                <div className="space-y-2">
                  {result.findings.map((finding, i) => (
                    <div
                      key={i}
                      className="flex items-start gap-2 rounded-md border border-border p-3"
                    >
                      {severityIcon(finding.severity)}
                      <div className="min-w-0">
                        <p className="text-sm font-medium">
                          {finding.description}
                          <Badge variant="outline" className="ml-2 text-[10px]">
                            {finding.category}
                          </Badge>
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {finding.details}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {result.recommendations.length > 0 && (
              <div>
                <h3 className="font-serif text-sm font-semibold mb-2">Recommendations</h3>
                <ul className="list-disc space-y-1 pl-4 text-sm text-muted-foreground">
                  {result.recommendations.map((rec, i) => (
                    <li key={i}>{rec}</li>
                  ))}
                </ul>
              </div>
            )}

            <div className="rounded-md border border-yellow-200 bg-yellow-50 dark:border-yellow-900 dark:bg-yellow-950/30 p-3 text-xs text-yellow-800 dark:text-yellow-200">
              ⚠️ {result.disclaimer}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/* ── Tab 6: Compare ──────────────────────────────────────────────── */

function CompareTab() {
  const sessionId = useSessionId();
  const { language } = useLanguage();
  const [processing, setProcessing] = useState(false);
  const [file1, setFile1] = useState<File | null>(null);
  const [file2, setFile2] = useState<File | null>(null);
  const [result, setResult] = useState<CompareResult | null>(null);

  const handleCompare = useCallback(async () => {
    if (!file1 || !file2 || !sessionId) return;
    setProcessing(true);
    setResult(null);
    try {
      const [uploaded1, uploaded2] = await Promise.all([
        uploadFile(file1, sessionId),
        uploadFile(file2, sessionId),
      ]);
      const response = await fetch(`${BACKEND_URL}/api/document-intelligence/compare`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          documentId1: uploaded1.id,
          documentId2: uploaded2.id,
          language,
        }),
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({ error: "Comparison failed" }));
        throw new Error(err.error || "Comparison failed");
      }
      const data = await response.json();
      setResult(data as CompareResult);
      toast.success("Comparison complete!");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Comparison failed.");
    } finally {
      setProcessing(false);
    }
  }, [file1, file2, sessionId, language]);

  const changeColor = (type: string) => {
    if (type === "added") return "border-green-200 bg-green-50 dark:border-green-900 dark:bg-green-950/30";
    if (type === "removed") return "border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/30";
    return "border-yellow-200 bg-yellow-50 dark:border-yellow-900 dark:bg-yellow-950/30";
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="font-serif text-base flex items-center gap-2">
            <ArrowLeftRight className="size-5 text-primary" /> Document Comparison
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Upload two documents to compare. The AI will identify differences,
            categorize changes, and provide a semantic analysis.
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="flex cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-border bg-muted/30 p-6 text-center transition-colors hover:bg-muted/60">
              <input
                type="file"
                accept="image/*,application/pdf,.doc,.docx,.txt"
                className="hidden"
                onChange={(e) => {
                  setFile1(e.target.files?.[0] ?? null);
                  setResult(null);
                }}
              />
              <FileText className="size-6 text-primary" />
              <span className="mt-2 text-sm font-medium">
                {file1 ? file1.name : "Document 1"}
              </span>
              <span className="text-xs text-muted-foreground">
                {file1 ? formatBytes(file1.size) : "Click to upload"}
              </span>
            </label>
            <label className="flex cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-border bg-muted/30 p-6 text-center transition-colors hover:bg-muted/60">
              <input
                type="file"
                accept="image/*,application/pdf,.doc,.docx,.txt"
                className="hidden"
                onChange={(e) => {
                  setFile2(e.target.files?.[0] ?? null);
                  setResult(null);
                }}
              />
              <FileText className="size-6 text-primary" />
              <span className="mt-2 text-sm font-medium">
                {file2 ? file2.name : "Document 2"}
              </span>
              <span className="text-xs text-muted-foreground">
                {file2 ? formatBytes(file2.size) : "Click to upload"}
              </span>
            </label>
          </div>
          <Button
            className="w-full"
            disabled={processing || !file1 || !file2 || !sessionId}
            onClick={handleCompare}
          >
            {processing ? (
              <>
                <Loader2 className="size-4 animate-spin" /> Comparing…
              </>
            ) : (
              <>
                <ArrowLeftRight className="size-4" /> Compare Documents
              </>
            )}
          </Button>
        </CardContent>
      </Card>

      {result && result.success && (
        <Card>
          <CardHeader>
            <CardTitle className="font-serif text-base">Comparison Results</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap gap-3">
              <div className="rounded-md border border-border p-3 text-center min-w-[140px]">
                <p className="text-xs text-muted-foreground">Similarity</p>
                <p className="text-2xl font-bold text-primary">
                  {Math.round(result.similarity_score * 100)}%
                </p>
              </div>
              <div className="rounded-md border border-border p-3 text-center min-w-[140px]">
                <p className="text-xs text-muted-foreground">Changes Found</p>
                <p className="text-2xl font-bold">{result.changes.length}</p>
              </div>
            </div>

            <div>
              <h3 className="font-serif text-sm font-semibold mb-2">Summary</h3>
              <MarkdownText content={result.summary} />
            </div>

            {result.changes.length > 0 && (
              <div>
                <h3 className="font-serif text-sm font-semibold mb-2">Changes</h3>
                <div className="space-y-2 max-h-96 overflow-y-auto">
                  {result.changes.map((change, i) => (
                    <div
                      key={i}
                      className={`rounded-md border p-3 ${changeColor(change.type)}`}
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <Badge variant="outline" className="text-[10px]">
                          {change.type}
                        </Badge>
                        <Badge variant="secondary" className="text-[10px]">
                          {change.category}
                        </Badge>
                      </div>
                      <p className="text-sm">{change.description}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {result.semantic_analysis && (
              <div>
                <h3 className="font-serif text-sm font-semibold mb-2">Semantic Analysis</h3>
                <div className="rounded-md border border-border p-4">
                  <MarkdownText content={result.semantic_analysis} />
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/* ── Main Page ───────────────────────────────────────────────────── */

function DocumentsPage() {
  return (
    <AppShell>
      <div className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-3xl font-semibold">Document Intelligence</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              AI-powered document generation, enhancement, restoration, analysis,
              authenticity verification, and comparison. Also available in Chat.
            </p>
          </div>
          <LanguagePicker />
        </div>

        <Tabs defaultValue="generate" className="mt-8">
          <TabsList className="flex-wrap">
            <TabsTrigger value="generate" className="gap-1.5">
              <Sparkles className="size-3.5" /> Generate
            </TabsTrigger>
            <TabsTrigger value="enhance" className="gap-1.5">
              <Wand2 className="size-3.5" /> Enhance
            </TabsTrigger>
            <TabsTrigger value="restore" className="gap-1.5">
              <RefreshCw className="size-3.5" /> Restore
            </TabsTrigger>
            <TabsTrigger value="analyze" className="gap-1.5">
              <FileSearch className="size-3.5" /> Analyze
            </TabsTrigger>
            <TabsTrigger value="authenticity" className="gap-1.5">
              <Shield className="size-3.5" /> Authenticity
            </TabsTrigger>
            <TabsTrigger value="compare" className="gap-1.5">
              <ArrowLeftRight className="size-3.5" /> Compare
            </TabsTrigger>
          </TabsList>
          <TabsContent value="generate" className="mt-6">
            <GenerateTab />
          </TabsContent>
          <TabsContent value="enhance" className="mt-6">
            <EnhanceTab />
          </TabsContent>
          <TabsContent value="restore" className="mt-6">
            <RestoreTab />
          </TabsContent>
          <TabsContent value="analyze" className="mt-6">
            <AnalyzeTab />
          </TabsContent>
          <TabsContent value="authenticity" className="mt-6">
            <AuthenticityTab />
          </TabsContent>
          <TabsContent value="compare" className="mt-6">
            <CompareTab />
          </TabsContent>
        </Tabs>
      </div>
    </AppShell>
  );
}
