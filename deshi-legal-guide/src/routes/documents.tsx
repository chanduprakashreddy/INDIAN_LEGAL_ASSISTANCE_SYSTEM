import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Download, FileText, Loader2, Sparkles, Upload } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { AppShell, LanguagePicker } from "@/components/app-shell";
import { useLanguage } from "@/components/language-provider";
import { MarkdownText } from "@/components/markdown-text";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useSessionId } from "@/hooks/use-session";
import {
  analyseDocument,
  enhanceDocumentScan,
  generateDocument,
  listDocuments,
  updateGeneratedDocument,
} from "@/lib/documents.functions";
import { DOCUMENT_TYPES } from "@/lib/legal";

export const Route = createFileRoute("/documents")({
  head: () => ({
    meta: [
      { title: "Documents — NyayaSahay" },
      {
        name: "description",
        content:
          "Draft affidavits, legal notices, RTI and bail applications, and get plain-language explanations of documents you have received.",
      },
      { property: "og:title", content: "Documents — NyayaSahay" },
      {
        property: "og:description",
        content: "Guided Indian legal drafting, document explanation and scan repair.",
      },
    ],
  }),
  component: DocumentsPage,
});

function download(name: string, content: string) {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("The file could not be read."));
    reader.readAsDataURL(file);
  });
}

function GenerateTab() {
  const sessionId = useSessionId();
  const { language, t } = useLanguage();
  const [typeId, setTypeId] = useState<string>(DOCUMENT_TYPES[0].id);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [draftText, setDraftText] = useState("");
  const [draftId, setDraftId] = useState<string | null>(null);

  const type = DOCUMENT_TYPES.find((entry) => entry.id === typeId)!;

  const generate = useMutation({
    mutationFn: () =>
      generateDocument({
        data: { sessionId, docType: typeId, language, fields },
      }),
    onSuccess: (result) => {
      setDraftText(result.content);
      setDraftId(result.id);
      toast.success("Draft ready. Review and edit before you use it.");
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Drafting failed."),
  });

  const save = useMutation({
    mutationFn: () =>
      updateGeneratedDocument({ data: { sessionId, id: draftId!, content: draftText } }),
    onSuccess: () => toast.success("Saved."),
    onError: () => toast.error("The draft could not be saved."),
  });

  const missing = type.fields.filter((field) => field.required && !fields[field.name]?.trim());

  return (
    <div className="grid gap-6 lg:grid-cols-[22rem_1fr]">
      <Card>
        <CardHeader>
          <CardTitle className="font-serif text-base">{t("documents.generate")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2">
            <Label>Document type</Label>
            <div className="grid gap-2">
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
                  <span className="mt-0.5 block text-xs text-muted-foreground">{entry.blurb}</span>
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
                      setFields((current) => ({ ...current, [field.name]: event.target.value }))
                    }
                  />
                ) : (
                  <Input
                    id={field.name}
                    value={fields[field.name] ?? ""}
                    onChange={(event) =>
                      setFields((current) => ({ ...current, [field.name]: event.target.value }))
                    }
                  />
                )}
              </div>
            ))}
          </div>

          <Button
            className="w-full"
            disabled={generate.isPending || missing.length > 0 || !sessionId}
            onClick={() => generate.mutate()}
          >
            {generate.isPending ? (
              <>
                <Loader2 className="size-4 animate-spin" /> Drafting…
              </>
            ) : (
              <>Draft {type.name.toLowerCase()}</>
            )}
          </Button>
          {missing.length > 0 && (
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
              <Button variant="outline" size="sm" onClick={() => void save.mutate()}>
                {t("common.save")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => download(`${type.name}.txt`, draftText)}
              >
                <Download className="size-4" /> {t("common.download")}
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
                Choose a document type, fill in what you know, and a draft will appear here for you
                to edit. Anything left blank is marked in square brackets.
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function ExplainTab() {
  const sessionId = useSessionId();
  const { language, t } = useLanguage();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);

  const documentsQuery = useQuery({
    queryKey: ["documents", sessionId],
    queryFn: () => listDocuments({ data: { sessionId } }),
    enabled: Boolean(sessionId),
  });

  const enhance = useMutation({
    mutationFn: (documentId: string) =>
      enhanceDocumentScan({ data: { sessionId, documentId } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["documents", sessionId] });
      toast.success("Enhanced copy ready.");
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Enhancement failed."),
  });

  const onFile = async (file: File | undefined) => {
    if (!file || !sessionId) return;
    setPending(true);
    try {
      const dataUrl = await readAsDataUrl(file);
      await analyseDocument({
        data: {
          sessionId,
          fileName: file.name,
          mimeType: file.type || "application/octet-stream",
          base64: dataUrl,
          language,
        },
      });
      await queryClient.invalidateQueries({ queryKey: ["documents", sessionId] });
      toast.success("Document explained.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The document could not be read.");
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="font-serif text-base">{t("documents.explain")}</CardTitle>
        </CardHeader>
        <CardContent>
          <label className="flex cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-border bg-muted/30 px-6 py-10 text-center transition-colors hover:bg-muted/60">
            <input
              type="file"
              accept="image/*,application/pdf"
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
              {pending ? "Reading your document…" : "Upload a notice, order, agreement or FIR"}
            </span>
            <span className="mt-1 text-xs text-muted-foreground">
              PDF or photo, up to 20 MB. Never upload Aadhaar numbers or bank credentials.
            </span>
          </label>
        </CardContent>
      </Card>

      <div className="space-y-4">
        {(documentsQuery.data ?? []).map((document) => (
          <Card key={document.id}>
            <CardHeader className="flex-row items-start justify-between gap-3">
              <div className="min-w-0">
                <CardTitle className="truncate font-serif text-base">{document.title}</CardTitle>
                <p className="mt-1 text-xs text-muted-foreground">
                  {document.analysis?.documentType ?? "Document"} ·{" "}
                  {new Date(document.createdAt).toLocaleString("en-IN")}
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap gap-2">
                {document.fileUrl && (
                  <Button variant="outline" size="sm" asChild>
                    <a href={document.fileUrl} target="_blank" rel="noreferrer">
                      Original
                    </a>
                  </Button>
                )}
                {document.enhancedUrl ? (
                  <Button variant="outline" size="sm" asChild>
                    <a href={document.enhancedUrl} target="_blank" rel="noreferrer">
                      Enhanced
                    </a>
                  </Button>
                ) : (
                  !document.mimeType?.includes("pdf") && (
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={enhance.isPending}
                      onClick={() => enhance.mutate(document.id)}
                    >
                      {enhance.isPending ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <Sparkles className="size-4" />
                      )}
                      {t("documents.enhance")}
                    </Button>
                  )
                )}
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
              {document.analysis?.quality && (
                <Badge variant="secondary" className="text-[11px]">
                  Scan quality: {document.analysis.quality}
                </Badge>
              )}
              {document.cleanedText && (
                <details className="rounded-md border border-border p-3">
                  <summary className="cursor-pointer text-sm font-medium">
                    Typed transcription
                  </summary>
                  <pre className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-foreground/80">
                    {document.cleanedText}
                  </pre>
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-3"
                    onClick={() => download(`${document.title}.txt`, document.cleanedText!)}
                  >
                    <Download className="size-4" /> {t("common.download")}
                  </Button>
                </details>
              )}
            </CardContent>
          </Card>
        ))}
        {documentsQuery.data?.length === 0 && (
          <p className="text-sm text-muted-foreground">
            Documents you upload will be explained here.
          </p>
        )}
      </div>
    </div>
  );
}

function DocumentsPage() {
  const { t } = useLanguage();

  return (
    <AppShell>
      <div className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-3xl font-semibold">{t("nav.documents")}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{t("disclaimer.short")}</p>
          </div>
          <LanguagePicker />
        </div>

        <Tabs defaultValue="generate" className="mt-8">
          <TabsList>
            <TabsTrigger value="generate">{t("documents.generate")}</TabsTrigger>
            <TabsTrigger value="explain">{t("documents.explain")}</TabsTrigger>
          </TabsList>
          <TabsContent value="generate" className="mt-6">
            <GenerateTab />
          </TabsContent>
          <TabsContent value="explain" className="mt-6">
            <ExplainTab />
          </TabsContent>
        </Tabs>
      </div>
    </AppShell>
  );
}
