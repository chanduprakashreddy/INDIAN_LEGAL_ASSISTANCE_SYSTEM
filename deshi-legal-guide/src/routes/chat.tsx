import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  BookMarked,
  ExternalLink,
  Loader2,
  Plus,
  SendHorizontal,
  Trash2,
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
          "Ask questions about Indian law and your own case, and get answers cited to the exact Act and section.",
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
};

const GROUNDING_LABEL: Record<Grounding, string> = {
  corpus: "From indexed Acts",
  indiacode: "From the India Code register",
  webscrape: "From legal websites",
  none: "General guidance",
};

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
  const bottomRef = useRef<HTMLDivElement>(null);

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

  const send = useCallback(async () => {
    const message = draft.trim();
    if (!message || streaming || !sessionId) return;

    setDraft("");
    setStreaming(true);
    setLive((current) => [
      ...current,
      { role: "user", content: message, citations: [], grounding: "none" },
      { role: "assistant", content: "", citations: [], grounding: "none" },
    ]);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          threadId: threadParam,
          matterId: matterParam,
          message,
          language,
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
    }
  }, [draft, language, matterParam, navigate, queryClient, sessionId, streaming, threadParam]);

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
                    {turn.role === "assistant" && turn.content === "" && streaming ? (
                      <p className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Loader2 className="size-4 animate-spin" />
                        {t("chat.thinking")}
                      </p>
                    ) : (
                      <MarkdownText
                        content={turn.content}
                        onCitation={(citationIndex) =>
                          setSourcePanel({ citations: turn.citations, focus: citationIndex })
                        }
                      />
                    )}

                    {turn.role === "assistant" && turn.citations.length > 0 && (
                      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
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
                      </div>
                    )}
                  </div>
                </div>
              ))}
              <div ref={bottomRef} />
            </div>
          </ScrollArea>

          <div className="border-t border-border bg-background px-4 py-3 sm:px-0">
            <div className="flex items-end gap-2">
              <Textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void send();
                  }
                }}
                placeholder={t("chat.placeholder")}
                rows={2}
                className="max-h-40 min-h-[52px] resize-none"
              />
              <Button
                size="icon"
                className="size-[52px] shrink-0"
                disabled={streaming || !draft.trim()}
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
            <p className="mt-2 text-[11px] text-muted-foreground">{t("disclaimer.short")}</p>
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
