import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { Briefcase, Loader2, MessagesSquare, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { AppShell } from "@/components/app-shell";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useSessionId } from "@/hooks/use-session";
import { deleteMatter, listMatters, saveMatter, type Matter } from "@/lib/matters.functions";

export const Route = createFileRoute("/matters")({
  head: () => ({
    meta: [
      { title: "My cases — NyayaSahay" },
      {
        name: "description",
        content:
          "Keep a private file for each matter: what happened, your notes, and consultations linked to that case.",
      },
      { property: "og:title", content: "My cases — NyayaSahay" },
      {
        property: "og:description",
        content: "A private workspace for each of your legal matters.",
      },
    ],
  }),
  component: MattersPage,
});

const EMPTY = { id: null as string | null, title: "", category: "", description: "", notes: "" };

function MattersPage() {
  const sessionId = useSessionId();
  const { t } = useLanguage();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<typeof EMPTY | null>(null);

  const mattersQuery = useQuery({
    queryKey: ["matters", sessionId],
    queryFn: () => listMatters({ data: { sessionId } }),
    enabled: Boolean(sessionId),
  });

  const save = useMutation({
    mutationFn: (values: typeof EMPTY) =>
      saveMatter({
        data: {
          sessionId,
          id: values.id,
          title: values.title.trim(),
          category: values.category.trim() || null,
          description: values.description.trim() || null,
          notes: values.notes.trim() || null,
        },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["matters", sessionId] });
      setForm(null);
      toast.success("Case file saved.");
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "The case file could not be saved."),
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteMatter({ data: { sessionId, id } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["matters", sessionId] }),
    onError: () => toast.error("The case file could not be deleted."),
  });

  const openEdit = (matter: Matter) =>
    setForm({
      id: matter.id,
      title: matter.title,
      category: matter.category ?? "",
      description: matter.description ?? "",
      notes: matter.notes ?? "",
    });

  return (
    <AppShell>
      <div className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-3xl font-semibold">{t("nav.matters")}</h1>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              Keep each matter separate. A consultation linked to a case file starts with your
              facts and notes already in mind.
            </p>
          </div>
          <Button onClick={() => setForm({ ...EMPTY })}>
            <Plus className="size-4" /> {t("matters.new")}
          </Button>
        </div>

        {form && (
          <Card className="mt-6 border-primary/40">
            <CardHeader>
              <CardTitle className="font-serif text-base">
                {form.id ? "Edit case file" : t("matters.new")}
              </CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <Label htmlFor="title">Title</Label>
                  <Input
                    id="title"
                    value={form.title}
                    placeholder="Security deposit not returned"
                    onChange={(event) => setForm({ ...form, title: event.target.value })}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="category">Area of law</Label>
                  <Input
                    id="category"
                    value={form.category}
                    placeholder="Rent / consumer / criminal / family"
                    onChange={(event) => setForm({ ...form, category: event.target.value })}
                  />
                </div>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="description">What happened</Label>
                <Textarea
                  id="description"
                  rows={4}
                  value={form.description}
                  onChange={(event) => setForm({ ...form, description: event.target.value })}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="notes">Your notes</Label>
                <Textarea
                  id="notes"
                  rows={3}
                  value={form.notes}
                  placeholder="Dates, people, documents you hold, next hearing…"
                  onChange={(event) => setForm({ ...form, notes: event.target.value })}
                />
              </div>
              <div className="flex gap-2">
                <Button
                  disabled={!form.title.trim() || save.isPending}
                  onClick={() => save.mutate(form)}
                >
                  {save.isPending && <Loader2 className="size-4 animate-spin" />}
                  {t("common.save")}
                </Button>
                <Button variant="ghost" onClick={() => setForm(null)}>
                  {t("common.cancel")}
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        <div className="mt-8 grid gap-4 md:grid-cols-2">
          {(mattersQuery.data ?? []).map((matter) => (
            <Card key={matter.id}>
              <CardHeader className="flex-row items-start justify-between gap-3">
                <div className="min-w-0">
                  <CardTitle className="truncate font-serif text-base">{matter.title}</CardTitle>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {matter.category || "Uncategorised"} ·{" "}
                    {new Date(matter.createdAt).toLocaleDateString("en-IN")}
                  </p>
                </div>
                <button
                  type="button"
                  aria-label={t("common.delete")}
                  onClick={() => remove.mutate(matter.id)}
                >
                  <Trash2 className="size-4 text-muted-foreground hover:text-destructive" />
                </button>
              </CardHeader>
              <CardContent className="space-y-3">
                {matter.description && (
                  <p className="line-clamp-4 text-sm text-muted-foreground">
                    {matter.description}
                  </p>
                )}
                {matter.notes && (
                  <p className="line-clamp-3 rounded-md bg-muted/50 p-2 text-xs text-muted-foreground">
                    {matter.notes}
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button asChild size="sm">
                    <Link to="/chat" search={{ matter: matter.id }}>
                      <MessagesSquare className="size-4" /> Consult on this case
                    </Link>
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => openEdit(matter)}>
                    Edit
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        {mattersQuery.data?.length === 0 && !form && (
          <div className="mt-10 rounded-lg border border-dashed border-border p-10 text-center">
            <Briefcase className="mx-auto size-8 text-primary/70" />
            <p className="mt-3 text-sm text-muted-foreground">
              No case files yet. Create one to keep your facts, notes and consultations together.
            </p>
          </div>
        )}
      </div>
    </AppShell>
  );
}
