import { Link, createFileRoute } from "@tanstack/react-router";
import {
  BookOpen,
  FileSignature,
  Languages,
  MessagesSquare,
  ScanLine,
  ShieldCheck,
  Sparkles,
} from "lucide-react";

import { AppShell } from "@/components/app-shell";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { LANGUAGES } from "@/lib/i18n";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "NyayaSahay — personal legal help for Indian law" },
      {
        name: "description",
        content:
          "Ask any question about Indian law and get answers cited to the Acts, draft affidavits and notices, and understand your documents in 12 Indian languages.",
      },
      { property: "og:title", content: "NyayaSahay — personal legal help for Indian law" },
      {
        property: "og:description",
        content:
          "Cited answers from the Constitution and Indian Acts, document drafting, and plain-language explanations of your papers.",
      },
    ],
  }),
  component: Home,
});

function Home() {
  const { t } = useLanguage();

  const features = [
    {
      icon: MessagesSquare,
      title: "Continuous consultation",
      body: "Describe your situation once and keep talking. Every answer quotes the Act and section it comes from, so you can verify it.",
    },
    {
      icon: FileSignature,
      title: "Document drafting",
      body: "Affidavits, legal notices, RTI applications, bail applications, rent agreements, complaints and powers of attorney — guided and ready to print.",
    },
    {
      icon: ScanLine,
      title: "Understand your papers",
      body: "Upload a summons, notice, agreement or order and get a plain-language breakdown with parties, obligations, dates and risks.",
    },
    {
      icon: Sparkles,
      title: "Repair poor scans",
      body: "Faint, skewed or creased photographs of documents are restored into a clean, legible page and a typed transcript.",
    },
    {
      icon: BookOpen,
      title: "Grounded in the statutes",
      body: "Answers come from an indexed corpus of the Constitution and central Acts, with the India Code register as a fallback when the corpus is thin.",
    },
    {
      icon: Languages,
      title: `${LANGUAGES.length} Indian languages`,
      body: "Ask and read in Hindi, Telugu, Tamil, Kannada, Bengali, Marathi, Malayalam, Gujarati, Urdu, Punjabi, Odia or English.",
    },
  ];

  return (
    <AppShell>
      <section
        className="relative border-b border-border overflow-hidden"
        style={{
          backgroundImage: "url('/hero-bg.jpg')",
          backgroundSize: "cover",
          backgroundPosition: "center",
          backgroundRepeat: "no-repeat",
        }}
      >
        {/* Dark overlay for readability */}
        <div className="absolute inset-0 bg-gradient-to-r from-background/95 via-background/85 to-background/70" />
        <div className="relative mx-auto w-full max-w-7xl px-4 py-16 sm:px-6 sm:py-24">
          <div className="max-w-3xl">
            <p className="inline-flex items-center gap-2 rounded-full border border-brass/40 bg-brass/15 px-3 py-1 text-xs font-medium text-brass-foreground">
              <ShieldCheck className="size-3.5" />
              Grounded in Indian statutes, with citations
            </p>
            <h1 className="mt-6 text-4xl font-semibold leading-tight sm:text-6xl">
              Legal help for Indian law, in the language you think in.
            </h1>
            <p className="mt-5 text-base leading-relaxed text-muted-foreground sm:text-lg">
              {t("app.tagline")}. Ask about a section or your own case, draft the paperwork you
              need, and understand the documents you have been served.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Button asChild size="lg">
                <Link to="/chat">{t("cta.start")}</Link>
              </Button>
              <Button asChild size="lg" variant="outline">
                <Link to="/documents">{t("cta.documents")}</Link>
              </Button>
            </div>
          </div>
        </div>
      </section>

      <section className="mx-auto w-full max-w-7xl px-4 py-14 sm:px-6">
        <h2 className="text-2xl font-semibold sm:text-3xl">What you can do here</h2>
        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {features.map((feature) => (
            <Card key={feature.title} className="h-full border-border/70">
              <CardHeader className="pb-3">
                <span className="flex size-10 items-center justify-center rounded-md bg-primary/10 text-primary">
                  <feature.icon className="size-5" />
                </span>
                <CardTitle className="mt-3 font-serif text-lg">{feature.title}</CardTitle>
              </CardHeader>
              <CardContent className="text-sm leading-relaxed text-muted-foreground">
                {feature.body}
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      <section className="border-t border-border bg-muted/40">
        <div className="mx-auto w-full max-w-7xl px-4 py-12 sm:px-6">
          <div className="rounded-lg border border-brass/40 bg-brass/10 p-6">
            <h2 className="font-serif text-lg font-semibold">Please read this first</h2>
            <p className="mt-2 max-w-4xl text-sm leading-relaxed text-foreground/80">
              NyayaSahay gives informational guidance based on Indian statutes. It is not a
              substitute for advice from a licensed advocate, and it cannot appear for you,
              certify a document, or guarantee an outcome. Verify every section and deadline
              before you rely on it, and consult an advocate for anything contested, urgent, or
              involving your liberty or livelihood. Never share Aadhaar numbers, passwords or
              bank credentials here.
            </p>
          </div>
        </div>
      </section>
    </AppShell>
  );
}
