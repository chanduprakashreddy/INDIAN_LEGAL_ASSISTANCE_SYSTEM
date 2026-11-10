import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  BookMarked,
  Check,
  Copy,
  Download,
  ExternalLink,
  FileDown,
  FileText,
  Loader2,
  Paperclip,
  Plus,
  SendHorizontal,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";

import { AppShell, LanguagePicker } from "@/components/app-shell";
import { useLanguage } from "@/components/language-provider";
import { MarkdownText } from "@/components/markdown-text";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { useSessionId } from "@/hooks/use-session";
import { deleteThread, getThread, listThreads } from "@/lib/chat.functions";
import type { Citation, Grounding } from "@/lib/legal";
import { listMatters } from "@/lib/matters.functions";
import { cn } from "@/lib/utils";

const BACKEND_URL = (import.meta.env["VITE_BACKEND_URL"] as string | undefined) || "http://localhost:8000";

const searchSchema = z.object({
  thread: z.string().uuid().optional(),
  matter: z.string().uuid().optional(),
});

export const Route = createFileRoute("/chat")({
  validateSearch: (search) => searchSchema.parse(search),
  head: () => ({
    meta: [
      { title: "Consult — NyayaSahay" },
      {
        name: "description",
        content:
          "Ask questions about Indian law and your own case, upload documents for analysis, and get answers cited to the exact Act and section.",
      },
      { property: "og:title", content: "Consult — NyayaSahay" },
      {
        property: "og:description",
        content: "A continuous legal consultation grounded in Indian statutes, in your language.",
      },
    ],
  }),
  component: ChatPage,
});

type LiveTurn = {
  role: "user" | "assistant";
  content: string;
  citations: Citation[];
  grounding: Grounding;
  queryType?: string | undefined;
  attachments?: { id: string; filename: string; mimeType: string }[] | undefined;
};

const GROUNDING_LABEL: Record<Grounding, string> = {
  corpus: "From indexed Acts",
  indiacode: "From the India Code register",
  webscrape: "From legal websites",
  none: "General guidance",
};

const QUERY_TYPE_LABEL: Record<string, string> = {
  personal_case: "⚖️ Personal Case Assistance",
  general_legal: "📖 General Legal Information",
  document_generate: "📄 Document Generation",
  document_enhance: "✨ Document Enhancement",
  document_restore: "🔄 Document Restoration",
  document_authenticity: "🛡️ Authenticity Check",
  document_compare: "🔀 Document Comparison",
  document_summarize: "📋 Document Summary",
};

type PendingFile = {
  file: File;
  preview?: string | undefined;
};

function isDocumentDraft(content: string, queryType?: string): boolean {
  if (queryType === "document_generate") return true;
  const patterns = [
    /\b(LEGAL NOTICE|AFFIDAVIT|BEFORE THE HON'BLE|RENT AGREEMENT|SALE DEED|POWER OF ATTORNEY|BAIL APPLICATION|WRIT PETITION|CONSUMER COMPLAINT|RTI APPLICATION)\b/i,
    /#\s*(LEGAL NOTICE|AFFIDAVIT|AGREEMENT|APPLICATION|PETITION|NOTICE|COMPLAINT)/i,
  ];
  return patterns.some((p) => p.test(content));
}

function extractDocumentTitle(content: string): string {
  const lines = content.split("\n").slice(0, 8);
  for (const line of lines) {
    const clean = line.replace(/^[#*\s\-_:]+|[#*\s\-_:]+$/g, "").trim();
    if (clean.length > 3 && clean.length < 80) {
      if (/(notice|affidavit|agreement|application|petition|complaint|deed|letter|memorandum)/i.test(clean)) {
        return clean;
      }
    }
  }
  return "Legal Document";
}

function ChatPage() {
  const { thread: threadParam, matter: matterParam } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const sessionId = useSessionId();
  const { language, t } = useLanguage();
  const queryClient = useQueryClient();

  const [draft, setDraft] = useState("");
  const [live, setLive] = useState<LiveTurn[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [sourcePanel, setSourcePanel] = useState<{ citations: Citation[]; focus?: number } | null>(
    null,
  );
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [downloadingState, setDownloadingState] = useState<{ index: number; type: "pdf" | "docx" } | null>(null);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const threadsQuery = useQuery({
    queryKey: ["threads", sessionId],
    queryFn: () => listThreads({ data: { sessionId } }),
    enabled: Boolean(sessionId),
  });

  const mattersQuery = useQuery({
    queryKey: ["matters", sessionId],
    queryFn: () => listMatters({ data: { sessionId } }),
    enabled: Boolean(sessionId),
  });

  const threadQuery = useQuery({
    queryKey: ["thread", sessionId, threadParam],
    queryFn: () => getThread({ data: { sessionId, threadId: threadParam! } }),
    enabled: Boolean(sessionId && threadParam),
  });

  const removeThread = useMutation({
    mutationFn: (threadId: string) => deleteThread({ data: { sessionId, threadId } }),
    onSuccess: (_result, threadId) => {
      void queryClient.invalidateQueries({ queryKey: ["threads", sessionId] });
      if (threadId === threadParam) void navigate({ search: {} });
    },
    onError: () => toast.error("That consultation could not be deleted."),
  });

  useEffect(() => {
    setLive([]);
  }, [threadParam]);

  const turns: LiveTurn[] = [
    ...(threadQuery.data?.turns ?? []).map((turn) => ({
      role: turn.role,
      content: turn.content,
      citations: turn.citations,
      grounding: turn.grounding,
    })),
    ...live,
  ];

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns.length, live[live.length - 1]?.content]);

  const handleFileSelect = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files) return;
    const newFiles: PendingFile[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (!file) continue;
      const preview = file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined;
      newFiles.push({ file, preview });
    }
    setPendingFiles((current) => [...current, ...newFiles]);
    if (event.target) event.target.value = "";
  }, []);

  const removePendingFile = useCallback((index: number) => {
    setPendingFiles((current) => {
      const updated = [...current];
      if (updated[index]?.preview) URL.revokeObjectURL(updated[index].preview!);
      updated.splice(index, 1);
      return updated;
    });
  }, []);

  const handleDownload = useCallback(async (content: string, type: "pdf" | "docx", turnIndex: number) => {
    setDownloadingState({ index: turnIndex, type });
    const title = extractDocumentTitle(content);
    const endpoint = type === "pdf" ? "/api/export-pdf" : "/api/export-docx";
    try {
      const response = await fetch(`${BACKEND_URL}${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, title }),
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({ error: `Failed to export ${type.toUpperCase()}` }));
        throw new Error(err.error || `Failed to export ${type.toUpperCase()}`);
      }

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const ext = type === "pdf" ? "pdf" : "docx";
      const safeName = title.replace(/[^a-zA-Z0-9_\-\s]/g, "").trim().replace(/\s+/g, "_");
      a.download = `${safeName || "legal_document"}.${ext}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast.success(`${type.toUpperCase()} file downloaded successfully!`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Download failed");
    } finally {
      setDownloadingState(null);
    }
  }, []);

  const handleCopyContent = useCallback(async (content: string, turnIndex: number) => {
    try {
      await navigator.clipboard.writeText(content);
      setCopiedIndex(turnIndex);
      toast.success("Document text copied to clipboard!");
      setTimeout(() => setCopiedIndex(null), 2000);
    } catch {
      toast.error("Could not copy to clipboard");
    }
  }, []);

  const uploadFiles = useCallback(async (files: PendingFile[], threadId?: string): Promise<string[]> => {
    const fileIds: string[] = [];
    for (const pf of files) {
      const formData = new FormData();
      formData.append("file", pf.file);
      formData.append("sessionId", sessionId);
      if (threadId) formData.append("threadId", threadId);

      const response = await fetch(`${BACKEND_URL}/api/upload`, {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({ error: "Upload failed" }));
        throw new Error(err.error || "Upload failed");
      }

      const result = await response.json();
      fileIds.push(result.id);
    }
    return fileIds;
  }, [sessionId]);

  const send = useCallback(async () => {
    const message = draft.trim();
    if ((!message && pendingFiles.length === 0) || streaming || !sessionId) return;

    const currentFiles = [...pendingFiles];
    const attachmentInfo = currentFiles.map((pf) => ({
      id: "",
      filename: pf.file.name,
      mimeType: pf.file.type,
    }));

    setDraft("");
    setPendingFiles([]);
    setStreaming(true);
    setLive((current) => [
      ...current,
      {
        role: "user",
        content: message || `📎 Uploaded ${currentFiles.length} document(s) for analysis`,
        citations: [],
        grounding: "none",
        attachments: attachmentInfo.length > 0 ? attachmentInfo : undefined,
      },
      { role: "assistant", content: "", citations: [], grounding: "none" },
    ]);

    try {
      // Upload files first if any
      let fileIds: string[] = [];
      if (currentFiles.length > 0) {
        setUploading(true);
        try {
          fileIds = await uploadFiles(currentFiles, threadParam);
        } catch (error) {
          toast.error(
            error instanceof Error ? error.message : "Files could not be uploaded."
          );
        } finally {
          setUploading(false);
        }
      }

      // Clean up file previews
      currentFiles.forEach((pf) => {
        if (pf.preview) URL.revokeObjectURL(pf.preview);
      });

      const actualMessage =
        message || (fileIds.length > 0
          ? "Please analyze the uploaded document(s) and explain what they contain, who the parties are, what obligations exist, any important dates or deadlines, risks, and what steps I should take."
          : "");

      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          threadId: threadParam,
          matterId: matterParam,
          message: actualMessage,
          language,
          fileIds,
        }),
      });

      if (!response.ok || !response.body) {
        throw new Error(await response.text().catch(() => "The answer could not be generated."));
      }

      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      let newThreadId: string | undefined;

      const applyToAssistant = (update: (turn: LiveTurn) => LiveTurn) => {
        setLive((current) => {
          const next = [...current];
          const index = next.length - 1;
          const turn = next[index];
          if (turn) next[index] = update(turn);
          return next;
        });
      };

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";

        for (const raw of frames) {
          const line = raw.split("\n").find((part) => part.startsWith("data:"));
          if (!line) continue;
          let event: {
            type?: string;
            text?: string;
            threadId?: string;
            citations?: Citation[];
            grounding?: Grounding;
            queryType?: string;
            message?: string;
          };
          try {
            event = JSON.parse(line.slice(5).trim());
          } catch {
            continue;
          }

          if (event.type === "meta") {
            newThreadId = event.threadId;
            applyToAssistant((turn) => ({
              ...turn,
              citations: event.citations ?? [],
              grounding: event.grounding ?? "none",
              queryType: event.queryType,
            }));
          } else if (event.type === "delta" && event.text) {
            applyToAssistant((turn) => ({ ...turn, content: turn.content + event.text }));
          } else if (event.type === "error") {
            throw new Error(event.message || "The answer could not be generated.");
          }
        }
      }

      await queryClient.invalidateQueries({ queryKey: ["threads", sessionId] });
      if (newThreadId && newThreadId !== threadParam) {
        setLive([]);
        await navigate({ search: (prev) => ({ ...prev, thread: newThreadId }) });
      } else {
        setLive([]);
        await queryClient.invalidateQueries({ queryKey: ["thread", sessionId, threadParam] });
      }
    } catch (error) {
      setLive((current) => current.slice(0, -1));
      toast.error(error instanceof Error ? error.message : "The answer could not be generated.");
    } finally {
      setStreaming(false);
      setUploading(false);
    }
  }, [draft, language, matterParam, navigate, pendingFiles, queryClient, sessionId, streaming, threadParam, uploadFiles]);

  const activeMatter = mattersQuery.data?.find((entry) => entry.id === matterParam);

  return (
    <AppShell fullHeight>
      <div className="mx-auto flex w-full max-w-7xl flex-1 gap-0 px-0 sm:px-6">
        <aside className="hidden w-64 shrink-0 flex-col border-r border-border py-4 pr-4 lg:flex">
          <Button
            variant="outline"
            className="justify-start gap-2"
            onClick={() => {
              setLive([]);
              void navigate({ search: (prev) => ({ matter: prev.matter }) });
            }}
          >
            <Plus className="size-4" />
            {t("chat.new")}
          </Button>
          <ScrollArea className="mt-4 flex-1">
            <div className="space-y-1 pr-2">
              {(threadsQuery.data ?? []).map((entry) => (
                <div
                  key={entry.id}
                  className={cn(
                    "group flex items-center gap-1 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-accent/60",
                    entry.id === threadParam && "bg-accent text-accent-foreground",
                  )}
                >
                  <button
                    type="button"
                    className="flex-1 truncate text-left"
                    onClick={() => {
                      setLive([]);
                      void navigate({ search: (prev) => ({ ...prev, thread: entry.id }) });
                    }}
                  >
                    {entry.title}
                  </button>
                  <button
                    type="button"
                    aria-label={t("common.delete")}
                    className="opacity-0 transition-opacity group-hover:opacity-100"
                    onClick={() => removeThread.mutate(entry.id)}
                  >
                    <Trash2 className="size-3.5 text-muted-foreground hover:text-destructive" />
                  </button>
                </div>
              ))}
              {threadsQuery.data?.length === 0 && (
                <p className="px-2 py-4 text-xs text-muted-foreground">
                  Your consultations will appear here.
                </p>
              )}
            </div>
          </ScrollArea>
        </aside>

        <section className="flex min-h-0 flex-1 flex-col">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3 sm:px-0 sm:py-4">
            <div className="min-w-0">
              <h1 className="truncate font-serif text-lg font-semibold">
                {threadQuery.data?.thread.title ?? t("chat.new")}
              </h1>
              {activeMatter && (
                <p className="truncate text-xs text-muted-foreground">
                  Linked to case: {activeMatter.title}
                </p>
              )}
            </div>
            <div className="flex items-center gap-2">
              <LanguagePicker />
              <Button
                variant="outline"
                size="sm"
                className="lg:hidden"
                onClick={() => {
                  setLive([]);
                  void navigate({ search: (prev) => ({ matter: prev.matter }) });
                }}
              >
                <Plus className="size-4" />
              </Button>
            </div>
          </div>

          <ScrollArea
            className="flex-1"
            style={{
              backgroundImage: "url('/chat-bg.jpg')",
              backgroundSize: "cover",
              backgroundPosition: "center",
              backgroundRepeat: "no-repeat",
              backgroundAttachment: "local",
            }}
          >
            {/* Semi-transparent overlay for readability */}
            <div
              className="absolute inset-0 bg-background/85 pointer-events-none"
              style={{ zIndex: 0 }}
            />
            <div className="relative space-y-5 px-4 py-6 sm:px-0" style={{ zIndex: 1 }}>
              {turns.length === 0 && !threadQuery.isLoading && (
                <div className="mx-auto max-w-xl rounded-lg border border-border bg-card p-6 text-center">
                  <BookMarked className="mx-auto size-8 text-primary" />
                  <h2 className="mt-3 font-serif text-lg font-semibold">
                    {t("chat.empty.title")}
                  </h2>
                  <p className="mt-2 text-sm text-muted-foreground">{t("chat.empty.body")}</p>
                  <div className="mt-4 flex flex-wrap justify-center gap-2">
                    <Badge variant="secondary" className="text-xs">
                      💬 Ask legal questions
                    </Badge>
                    <Badge variant="secondary" className="text-xs">
                      📎 Upload case documents
                    </Badge>
                    <Badge variant="secondary" className="text-xs">
                      📄 Generate legal documents
                    </Badge>
                    <Badge variant="secondary" className="text-xs">
                      ⚖️ Personal case assistance
                    </Badge>
                  </div>
                </div>
              )}

              {turns.map((turn, index) => (
                <div
                  key={index}
                  className={cn("flex", turn.role === "user" ? "justify-end" : "justify-start")}
                >
                  <div
                    className={cn(
                      "max-w-[46rem] rounded-lg px-4 py-3",
                      turn.role === "user"
                        ? "bg-primary text-primary-foreground"
                        : "border border-border bg-card",
                    )}
                  >
                    {/* Show file attachments for user messages */}
                    {turn.role === "user" && turn.attachments && turn.attachments.length > 0 && (
                      <div className="mb-2 flex flex-wrap gap-2">
                        {turn.attachments.map((att, i) => (
                          <div
                            key={i}
                            className="flex items-center gap-1.5 rounded-md bg-primary-foreground/20 px-2 py-1 text-xs"
                          >
                            <FileText className="size-3.5" />
                            <span className="max-w-[120px] truncate">{att.filename}</span>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Prominent Legal Document Download Banner */}
                    {turn.role === "assistant" &&
                      turn.content.length > 50 &&
                      isDocumentDraft(turn.content, turn.queryType) && (
                        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-primary/25 bg-primary/5 p-2.5">
                          <div className="flex items-center gap-2 text-xs font-semibold text-primary">
                            <FileText className="size-4 shrink-0 text-primary" />
                            <span className="truncate max-w-[200px] sm:max-w-xs font-semibold">
                              {extractDocumentTitle(turn.content)}
                            </span>
                          </div>
                          <div className="flex flex-wrap items-center gap-1.5">
                            <Button
                              size="sm"
                              className="h-7 gap-1.5 px-2.5 text-xs bg-primary text-primary-foreground hover:bg-primary/90"
                              disabled={downloadingState?.index === index && downloadingState?.type === "pdf"}
                              onClick={() => handleDownload(turn.content, "pdf", index)}
                            >
                              {downloadingState?.index === index && downloadingState?.type === "pdf" ? (
                                <Loader2 className="size-3.5 animate-spin" />
                              ) : (
                                <Download className="size-3.5" />
                              )}
                              Download PDF
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 gap-1.5 px-2.5 text-xs border-primary/30 text-primary hover:bg-primary/10"
                              disabled={downloadingState?.index === index && downloadingState?.type === "docx"}
                              onClick={() => handleDownload(turn.content, "docx", index)}
                            >
                              {downloadingState?.index === index && downloadingState?.type === "docx" ? (
                                <Loader2 className="size-3.5 animate-spin" />
                              ) : (
                                <FileDown className="size-3.5" />
                              )}
                              Word (.docx)
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
                              onClick={() => handleCopyContent(turn.content, index)}
                            >
                              {copiedIndex === index ? (
                                <Check className="size-3.5 text-green-600" />
                              ) : (
                                <Copy className="size-3.5" />
                              )}
                              {copiedIndex === index ? "Copied" : "Copy"}
                            </Button>
                          </div>
                        </div>
                      )}

                    {turn.role === "assistant" && turn.content === "" && streaming ? (
                      <p className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Loader2 className="size-4 animate-spin" />
                        {uploading ? "Uploading and analyzing documents…" : t("chat.thinking")}
                      </p>
                    ) : (
                      <MarkdownText
                        content={turn.content}
                        onCitation={(citationIndex) =>
                          setSourcePanel({ citations: turn.citations, focus: citationIndex })
                        }
                      />
                    )}

                    {turn.role === "assistant" && turn.content !== "" && (
                      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
                        <div className="flex flex-wrap items-center gap-2">
                          {turn.queryType && QUERY_TYPE_LABEL[turn.queryType] && (
                            <Badge variant="outline" className="text-[11px] border-primary/30">
                              {QUERY_TYPE_LABEL[turn.queryType]}
                            </Badge>
                          )}
                          {turn.citations.length > 0 && (
                            <>
                              <Badge variant="secondary" className="text-[11px]">
                                {GROUNDING_LABEL[turn.grounding]}
                              </Badge>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 px-2 text-xs"
                                onClick={() => setSourcePanel({ citations: turn.citations })}
                              >
                                {t("chat.sources")} ({turn.citations.length})
                              </Button>
                            </>
                          )}
                        </div>
                        <div className="flex items-center gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
                            title="Download as PDF"
                            disabled={downloadingState?.index === index && downloadingState?.type === "pdf"}
                            onClick={() => handleDownload(turn.content, "pdf", index)}
                          >
                            <Download className="mr-1 size-3.5" /> PDF
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
                            title="Download as Word (.docx)"
                            disabled={downloadingState?.index === index && downloadingState?.type === "docx"}
                            onClick={() => handleDownload(turn.content, "docx", index)}
                          >
                            <FileDown className="mr-1 size-3.5" /> Word
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              ))}
              <div ref={bottomRef} />
            </div>
          </ScrollArea>

          {/* Pending file attachments preview */}
          {pendingFiles.length > 0 && (
            <div className="border-t border-border bg-muted/30 px-4 py-2 sm:px-0">
              <div className="flex flex-wrap gap-2">
                {pendingFiles.map((pf, index) => (
                  <div
                    key={index}
                    className="relative flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm"
                  >
                    {pf.preview ? (
                      <img
                        src={pf.preview}
                        alt={pf.file.name}
                        className="size-8 rounded object-cover"
                      />
                    ) : (
                      <FileText className="size-5 text-primary" />
                    )}
                    <span className="max-w-[140px] truncate text-xs">{pf.file.name}</span>
                    <button
                      type="button"
                      onClick={() => removePendingFile(index)}
                      className="ml-1 rounded-full p-0.5 hover:bg-destructive/20"
                    >
                      <X className="size-3.5 text-muted-foreground hover:text-destructive" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="border-t border-border bg-background px-4 py-3 sm:px-0">
            <div className="flex items-end gap-2">
              {/* Hidden file input */}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*,application/pdf,.doc,.docx,.txt"
                multiple
                className="hidden"
                onChange={handleFileSelect}
              />
              {/* Attachment button */}
              <Button
                variant="ghost"
                size="icon"
                className="size-[52px] shrink-0"
                onClick={() => fileInputRef.current?.click()}
                disabled={streaming}
                title="Upload documents (images, PDFs)"
              >
                <Paperclip className="size-5 text-muted-foreground" />
              </Button>
              <Textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void send();
                  }
                }}
                placeholder={
                  pendingFiles.length > 0
                    ? "Add a message about the uploaded file(s), or just send to analyze..."
                    : t("chat.placeholder")
                }
                rows={2}
                className="max-h-40 min-h-[52px] resize-none"
              />
              <Button
                size="icon"
                className="size-[52px] shrink-0"
                disabled={streaming || (!draft.trim() && pendingFiles.length === 0)}
                onClick={() => void send()}
                aria-label={t("chat.send")}
              >
                {streaming ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <SendHorizontal className="size-4" />
                )}
              </Button>
            </div>
            <p className="mt-2 text-[11px] text-muted-foreground">
              📎 Attach documents for analysis · 📄 Ask to generate legal docs · ⚖️ Describe your case for personal advice
            </p>
          </div>
        </section>
      </div>

      <Sheet open={Boolean(sourcePanel)} onOpenChange={(open) => !open && setSourcePanel(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
          <SheetHeader>
            <SheetTitle className="font-serif">{t("chat.sources")}</SheetTitle>
          </SheetHeader>
          <div className="space-y-4 px-4 pb-8">
            {(sourcePanel?.citations ?? []).map((citation) => (
              <article
                key={citation.index}
                className={cn(
                  "rounded-md border border-border p-3",
                  sourcePanel?.focus === citation.index && "border-brass bg-brass/10",
                )}
              >
                <div className="flex items-start gap-2">
                  <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-brass/25 text-[11px] font-semibold text-brass-foreground">
                    {citation.index}
                  </span>
                  <div className="min-w-0">
                    <h3 className="font-serif text-sm font-semibold">
                      {citation.actName}
                      {citation.year ? `, ${citation.year}` : ""}
                    </h3>
                    {citation.section && (
                      <p className="text-xs text-muted-foreground">Section {citation.section}</p>
                    )}
                    <p className="text-xs text-muted-foreground">
                      {citation.origin === "corpus"
                        ? "Local indexed legal database"
                        : citation.origin === "webscrape"
                          ? "Indian Kanoon web source"
                          : "India Code register"}
                    </p>
                  </div>
                </div>
                <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-foreground/80">
                  {citation.excerpt}
                </p>
                {citation.sourceUrl && (
                  <a
                    href={citation.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-2 inline-flex items-center gap-1 text-xs text-primary hover:underline"
                  >
                    Open source <ExternalLink className="size-3" />
                  </a>
                )}
              </article>
            ))}
            {sourcePanel?.citations.length === 0 && (
              <p className="text-sm text-muted-foreground">
                This answer was general guidance with no matching statutory passage.
              </p>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </AppShell>
  );
}
