import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Database, Loader2, Search, Upload } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { AppShell } from "@/components/app-shell";
import { useLanguage } from "@/components/language-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import {
  corpusStats,
  importCorpusChunks,
  searchCorpusChunks,
  type CorpusChunkInput,
} from "@/lib/corpus.functions";
import type { Citation } from "@/lib/legal";

export const Route = createFileRoute("/library")({
  head: () => ({
    meta: [
      { title: "Law library — NyayaSahay" },
      {
        name: "description",
        content:
          "Search the indexed Constitution and Indian Acts behind every answer, and add your own chunked legal corpus.",
      },
      { property: "og:title", content: "Law library — NyayaSahay" },
      {
        property: "og:description",
        content: "Search the statutory passages that ground NyayaSahay's answers.",
      },
    ],
  }),
  component: LibraryPage,
});

type RawChunk = Record<string, unknown>;

function pickString(row: RawChunk, keys: string[]): string | null {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number") return String(value);
  }
  return null;
}

/** Accepts common chunk shapes (JSON array, JSONL, {chunks:[...]}) and normalises them. */
function normaliseChunks(text: string): CorpusChunkInput[] {
  const rows: RawChunk[] = [];
  const trimmed = text.trim();

  const pushAny = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(pushAny);
    else if (value && typeof value === "object") {
      const record = value as RawChunk;
      if (Array.isArray(record["chunks"])) pushAny(record["chunks"]);
      else if (Array.isArray(record["data"])) pushAny(record["data"]);
      else rows.push(record);
    }
  };

  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      pushAny(JSON.parse(trimmed));
    } catch {
      trimmed.split("\n").forEach((line) => {
        if (!line.trim()) return;
        try {
          pushAny(JSON.parse(line));
        } catch {
          /* skip malformed line */
        }
      });
    }
  } else {
    trimmed.split("\n").forEach((line) => {
      if (!line.trim()) return;
      try {
        pushAny(JSON.parse(line));
      } catch {
        /* skip malformed line */
      }
    });
  }

  const chunks: CorpusChunkInput[] = [];
  rows.forEach((row) => {
    const metadata = (row["metadata"] ?? row["meta"] ?? {}) as RawChunk;
    const content = pickString(row, ["content", "text", "chunk", "page_content", "body"]);
    if (!content || content.length < 20) return;

    const yearRaw = pickString(row, ["actYear", "act_year", "year"]) ?? pickString(metadata, ["actYear", "act_year", "year"]);
    const year = yearRaw ? Number(yearRaw.match(/\d{4}/)?.[0]) : NaN;
    const embedding = Array.isArray(row["embedding"])
      ? (row["embedding"] as unknown[]).filter((value): value is number => typeof value === "number")
      : undefined;

    chunks.push({
      externalId:
        pickString(row, ["externalId", "external_id", "id", "chunk_id"]) ?? undefined,
      actName:
        pickString(row, ["actName", "act_name", "act", "title", "source"]) ??
        pickString(metadata, ["actName", "act_name", "act", "title", "source"]) ??
        "Unlabelled source",
      actYear: Number.isFinite(year) ? year : null,
      section:
        pickString(row, ["section", "section_number", "sec"]) ??
        pickString(metadata, ["section", "section_number", "sec"]),
      chapter:
        pickString(row, ["chapter", "part"]) ?? pickString(metadata, ["chapter", "part"]),
      sourceUrl:
        pickString(row, ["sourceUrl", "source_url", "url"]) ??
        pickString(metadata, ["sourceUrl", "source_url", "url"]),
      content: content.slice(0, 20000),
      metadata: metadata as Record<string, unknown>,
      embedding: embedding && embedding.length ? embedding : undefined,
    });
  });

  return chunks;
}

function ImportPanel() {
  const queryClient = useQueryClient();
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  const onFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    let all: CorpusChunkInput[] = [];
    for (const file of Array.from(files)) {
      all = all.concat(normaliseChunks(await file.text()));
    }
    if (!all.length) {
      toast.error("No usable chunks were found in those files.");
      return;
    }

    setProgress({ done: 0, total: all.length });
    let imported = 0;
    try {
      for (let index = 0; index < all.length; index += 20) {
        const batch = all.slice(index, index + 20);
        const result = await importCorpusChunks({ data: { chunks: batch } });
        imported += result.imported;
        setProgress({ done: Math.min(index + 20, all.length), total: all.length });
      }
      toast.success(`Imported ${imported} passages into the law library.`);
      await queryClient.invalidateQueries({ queryKey: ["corpus-stats"] });
    } catch (error) {
      toast.error(
        error instanceof Error
          ? `${error.message} (${imported} imported before it stopped)`
          : "The import stopped early.",
      );
    } finally {
      setProgress(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="font-serif text-base">Add your chunked corpus</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <label className="flex cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-border bg-muted/30 px-6 py-8 text-center transition-colors hover:bg-muted/60">
          <input
            type="file"
            multiple
            accept=".json,.jsonl,.ndjson,.txt"
            className="hidden"
            disabled={Boolean(progress)}
            onChange={(event) => void onFiles(event.target.files)}
          />
          {progress ? (
            <Loader2 className="size-6 animate-spin text-primary" />
          ) : (
            <Upload className="size-6 text-primary" />
          )}
          <span className="mt-3 text-sm font-medium">
            {progress ? "Importing…" : "Select your JSON or JSONL chunk files"}
          </span>
          <span className="mt-1 text-xs text-muted-foreground">
            Each record needs the passage text; Act name, section, chapter, source URL and your own
            vectors are used when present.
          </span>
        </label>
        {progress && (
          <div className="space-y-1">
            <Progress value={(progress.done / progress.total) * 100} />
            <p className="text-xs text-muted-foreground">
              {progress.done} of {progress.total} passages
            </p>
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          Passages without a 3072-dimension vector are embedded here automatically, so your
          questions and the corpus always use the same vector space.
        </p>
      </CardContent>
    </Card>
  );
}

function LibraryPage() {
  const { t } = useLanguage();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Citation[] | null>(null);

  const statsQuery = useQuery({
    queryKey: ["corpus-stats"],
    queryFn: () => corpusStats(),
  });

  const search = useMutation({
    mutationFn: () => searchCorpusChunks({ data: { query: query.trim() } }),
    onSuccess: (result) => setResults(result.citations as Citation[]),
    onError: (error) => toast.error(error instanceof Error ? error.message : "Search failed."),
  });

  return (
    <AppShell>
      <div className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6">
        <h1 className="text-3xl font-semibold">{t("library.title")}</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          Every answer is drawn from these indexed passages. Search them directly, or add more of
          your own chunked Acts.
        </p>

        <div className="mt-8 grid gap-6 lg:grid-cols-[1fr_22rem]">
          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="font-serif text-base">Search the statutes</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <form
                  className="flex gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (query.trim().length > 1) search.mutate();
                  }}
                >
                  <Input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Maintenance of parents, anticipatory bail, tenant eviction notice…"
                  />
                  <Button type="submit" disabled={search.isPending || query.trim().length < 2}>
                    {search.isPending ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Search className="size-4" />
                    )}
                  </Button>
                </form>

                <div className="space-y-3">
                  {(results ?? []).map((citation) => (
                    <article key={citation.index} className="rounded-md border border-border p-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="font-serif text-sm font-semibold">
                          {citation.actName}
                          {citation.year ? `, ${citation.year}` : ""}
                        </h2>
                        {citation.section && (
                          <Badge variant="secondary" className="text-[11px]">
                            Section {citation.section}
                          </Badge>
                        )}
                        <Badge variant="outline" className="text-[11px]">
                          {citation.origin === "corpus" ? "Indexed corpus" : "India Code"}
                        </Badge>
                      </div>
                      <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-foreground/80">
                        {citation.excerpt}
                      </p>
                      {citation.sourceUrl && (
                        <a
                          href={citation.sourceUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="mt-2 inline-block text-xs text-primary hover:underline"
                        >
                          Open source
                        </a>
                      )}
                    </article>
                  ))}
                  {results?.length === 0 && (
                    <p className="text-sm text-muted-foreground">
                      Nothing matched. Try different words, or import more of your corpus.
                    </p>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>

          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="font-serif text-base">What is indexed</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                {statsQuery.isLoading ? (
                  <p className="text-muted-foreground">{t("common.loading")}</p>
                ) : (
                  <>
                    <div className="flex items-center gap-2">
                      <Database className="size-4 text-primary" />
                      <span className="font-medium">
                        {statsQuery.data?.total.toLocaleString("en-IN") ?? 0} passages
                      </span>
                      <span className="text-xs text-muted-foreground">
                        ({statsQuery.data?.embedded.toLocaleString("en-IN") ?? 0} searchable)
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {statsQuery.data?.actCount ?? 0} distinct sources
                    </p>
                    <div className="flex flex-wrap gap-1">
                      {(statsQuery.data?.acts ?? []).slice(0, 24).map((act) => (
                        <Badge key={act} variant="secondary" className="text-[11px] font-normal">
                          {act}
                        </Badge>
                      ))}
                    </div>
                    {statsQuery.data?.total === 0 && (
                      <p className="text-xs text-muted-foreground">
                        The library is empty. Import your chunked Acts below — until then answers
                        fall back to the India Code register and general guidance.
                      </p>
                    )}
                  </>
                )}
              </CardContent>
            </Card>

            <ImportPanel />
          </div>
        </div>
      </div>
    </AppShell>
  );
}
