// Server-only retrieval: the legal corpus first, the public India Code acts
// service as a fallback when the corpus is not confident.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { embedText } from "./ai.server";
import type { Citation, Grounding } from "./legal";

const INDIA_CODE_URL = "https://indiacode.ecourtsindia.com/api/v1/acts";
const CONFIDENT_SCORE = 0.42;

type CorpusRow = {
  id: string;
  act_name: string;
  act_year: number | null;
  section: string | null;
  chapter: string | null;
  source_url: string | null;
  content: string;
  score: number;
  similarity: number;
};

export type RetrievalResult = {
  citations: Citation[];
  context: string;
  grounding: Grounding;
};

function excerpt(text: string, limit = 900): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > limit ? `${clean.slice(0, limit)}…` : clean;
}

async function searchCorpus(question: string): Promise<CorpusRow[]> {
  const { count } = await supabaseAdmin
    .from("legal_chunks")
    .select("id", { count: "exact", head: true })
    .not("embedding", "is", null);

  if (!count) return [];

  const embedding = await embedText(question);
  const { data, error } = await supabaseAdmin.rpc("match_legal_chunks", {
    query_embedding: embedding as unknown as string,
    query_text: question,
    match_count: 8,
  });

  if (error) {
    console.error("[retrieval] corpus search failed", error);
    return [];
  }
  return (data ?? []) as unknown as CorpusRow[];
}

type IndiaCodeAct = {
  id?: string | number;
  title?: string;
  name?: string;
  act_name?: string;
  year?: string | number;
  act_year?: string | number;
  short_title?: string;
  url?: string;
  link?: string;
  description?: string;
  summary?: string;
};

function actTitle(act: IndiaCodeAct): string {
  return act.title ?? act.name ?? act.act_name ?? act.short_title ?? "Act";
}

async function loadIndiaCodeActs(): Promise<IndiaCodeAct[]> {
  const cacheKey = "acts:all";
  const { data: cached } = await supabaseAdmin
    .from("indiacode_cache")
    .select("payload, fetched_at")
    .eq("cache_key", cacheKey)
    .maybeSingle();

  const fresh =
    cached && Date.now() - new Date(cached.fetched_at).getTime() < 1000 * 60 * 60 * 24;
  if (fresh) return (cached.payload as { acts?: IndiaCodeAct[] }).acts ?? [];

  try {
    const response = await fetch(INDIA_CODE_URL, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      console.error("[retrieval] India Code responded", response.status);
      return (cached?.payload as { acts?: IndiaCodeAct[] })?.acts ?? [];
    }
    const payload = (await response.json()) as unknown;
    const acts = Array.isArray(payload)
      ? (payload as IndiaCodeAct[])
      : (((payload as { data?: IndiaCodeAct[]; acts?: IndiaCodeAct[] }).data ??
          (payload as { acts?: IndiaCodeAct[] }).acts ??
          []) as IndiaCodeAct[]);

    await supabaseAdmin
      .from("indiacode_cache")
      .upsert({ cache_key: cacheKey, payload: { acts }, fetched_at: new Date().toISOString() }, {
        onConflict: "cache_key",
      });

    return acts;
  } catch (error) {
    console.error("[retrieval] India Code unreachable", error);
    return (cached?.payload as { acts?: IndiaCodeAct[] })?.acts ?? [];
  }
}

function keywords(question: string): string[] {
  const stop = new Set([
    "what","which","where","when","how","the","and","for","are","is","of","in","to","a","an",
    "my","me","i","do","does","can","should","about","under","law","laws","legal","india",
    "indian","act","section","please","tell","explain","give","need","help",
  ]);
  return question
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 3 && !stop.has(word))
    .slice(0, 8);
}

async function searchIndiaCode(question: string): Promise<Citation[]> {
  const acts = await loadIndiaCodeActs();
  if (!acts.length) return [];
  const terms = keywords(question);
  if (!terms.length) return [];

  const scored = acts
    .map((act) => {
      const haystack = `${actTitle(act)} ${act.description ?? act.summary ?? ""}`.toLowerCase();
      const hits = terms.filter((term) => haystack.includes(term)).length;
      return { act, hits };
    })
    .filter((entry) => entry.hits > 0)
    .sort((a, b) => b.hits - a.hits)
    .slice(0, 4);

  return scored.map((entry, position) => ({
    index: position + 1,
    actName: actTitle(entry.act),
    section: null,
    year: Number(entry.act.year ?? entry.act.act_year) || null,
    sourceUrl: entry.act.url ?? entry.act.link ?? "https://www.indiacode.nic.in/",
    excerpt: excerpt(
      entry.act.description ??
        entry.act.summary ??
        `${actTitle(entry.act)} — listed in the India Code register of central Acts.`,
      400,
    ),
    origin: "indiacode" as const,
    score: null,
  }));
}

export async function retrieveContext(question: string): Promise<RetrievalResult> {
  const rows = await searchCorpus(question);
  const best = rows[0]?.score ?? 0;

  if (rows.length && best >= CONFIDENT_SCORE) {
    const citations: Citation[] = rows.map((row, position) => ({
      index: position + 1,
      actName: row.act_name,
      section: row.section,
      year: row.act_year,
      sourceUrl: row.source_url,
      excerpt: excerpt(row.content),
      origin: "corpus",
      score: Number(row.score.toFixed(3)),
    }));
    return { citations, context: buildContext(citations), grounding: "corpus" };
  }

  const external = await searchIndiaCode(question);
  if (external.length) {
    const weak: Citation[] = rows.slice(0, 2).map((row, position) => ({
      index: external.length + position + 1,
      actName: row.act_name,
      section: row.section,
      year: row.act_year,
      sourceUrl: row.source_url,
      excerpt: excerpt(row.content),
      origin: "corpus",
      score: Number(row.score.toFixed(3)),
    }));
    const citations = [...external, ...weak];
    return { citations, context: buildContext(citations), grounding: "indiacode" };
  }

  if (rows.length) {
    const citations: Citation[] = rows.slice(0, 4).map((row, position) => ({
      index: position + 1,
      actName: row.act_name,
      section: row.section,
      year: row.act_year,
      sourceUrl: row.source_url,
      excerpt: excerpt(row.content),
      origin: "corpus",
      score: Number(row.score.toFixed(3)),
    }));
    return { citations, context: buildContext(citations), grounding: "none" };
  }

  return { citations: [], context: "", grounding: "none" };
}

function buildContext(citations: Citation[]): string {
  return citations
    .map((citation) => {
      const header = [
        `[${citation.index}]`,
        citation.actName,
        citation.section ? `Section ${citation.section}` : null,
        citation.year ? `(${citation.year})` : null,
        citation.origin === "indiacode" ? "— from the India Code register" : null,
      ]
        .filter(Boolean)
        .join(" ");
      return `${header}\n${citation.excerpt}`;
    })
    .join("\n\n");
}
