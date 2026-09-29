import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { supabaseAdmin } from "@/integrations/supabase/client.server";

const ChunkInput = z.object({
  externalId: z.string().max(200).nullable().optional(),
  actName: z.string().min(1).max(400),
  actYear: z.number().int().nullable().optional(),
  section: z.string().max(120).nullable().optional(),
  chapter: z.string().max(200).nullable().optional(),
  sourceUrl: z.string().max(1000).nullable().optional(),
  content: z.string().min(20).max(20000),
  metadata: z.record(z.string(), z.unknown()).optional(),
  embedding: z.array(z.number()).optional(),
});

export type CorpusChunkInput = z.infer<typeof ChunkInput>;

export const corpusStats = createServerFn({ method: "GET" }).handler(async () => {
  const [{ count: total }, { count: embedded }, { data: acts }] = await Promise.all([
    supabaseAdmin.from("legal_chunks").select("id", { count: "exact", head: true }),
    supabaseAdmin
      .from("legal_chunks")
      .select("id", { count: "exact", head: true })
      .not("embedding", "is", null),
    supabaseAdmin.from("legal_chunks").select("act_name").limit(1000),
  ]);

  const actNames = Array.from(new Set((acts ?? []).map((row) => row.act_name))).sort();
  return {
    total: total ?? 0,
    embedded: embedded ?? 0,
    acts: actNames.slice(0, 200),
    actCount: actNames.length,
  };
});

/**
 * Imports a batch of chunks. Vectors supplied by the caller are stored only when
 * they match the app's embedding size; otherwise the chunk text is embedded here
 * so questions and passages are always comparable.
 */
export const importCorpusChunks = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ chunks: z.array(ChunkInput).min(1).max(40) }).parse(input),
  )
  .handler(async ({ data }) => {
    const { embedTexts, EMBEDDING_MODEL } = await import("./ai.server");
    const EXPECTED_DIMENSIONS = 3072;

    const needsEmbedding = data.chunks.filter(
      (chunk) => !chunk.embedding || chunk.embedding.length !== EXPECTED_DIMENSIONS,
    );

    const generated = needsEmbedding.length
      ? await embedTexts(
          needsEmbedding.map((chunk) =>
            `${chunk.actName}${chunk.section ? ` Section ${chunk.section}` : ""}\n${chunk.content}`.slice(
              0,
              8000,
            ),
          ),
        )
      : [];

    const generatedByIndex = new Map<number, number[]>();
    needsEmbedding.forEach((chunk, position) => {
      const vector = generated[position];
      if (vector) generatedByIndex.set(data.chunks.indexOf(chunk), vector);
    });

    const rows = data.chunks.map((chunk, index) => {
      const supplied =
        chunk.embedding && chunk.embedding.length === EXPECTED_DIMENSIONS ? chunk.embedding : null;
      const embedding = supplied ?? generatedByIndex.get(index) ?? null;
      return {
        external_id: chunk.externalId ?? null,
        act_name: chunk.actName,
        act_year: chunk.actYear ?? null,
        section: chunk.section ?? null,
        chapter: chunk.chapter ?? null,
        source_url: chunk.sourceUrl ?? null,
        content: chunk.content,
        metadata: JSON.parse(JSON.stringify(chunk.metadata ?? {})) as Record<string, never>,
        embedding: embedding ? JSON.stringify(embedding) : null,
        embedding_model: supplied ? "supplied" : EMBEDDING_MODEL,
      };
    });

    const withIds = rows.filter((row) => row.external_id);
    const withoutIds = rows.filter((row) => !row.external_id);

    if (withIds.length) {
      const { error } = await supabaseAdmin
        .from("legal_chunks")
        .upsert(withIds as never, { onConflict: "external_id" });
      if (error) {
        console.error("[corpus] upsert failed", error);
        throw new Error("Some chunks could not be imported.");
      }
    }
    if (withoutIds.length) {
      const { error } = await supabaseAdmin.from("legal_chunks").insert(withoutIds as never);
      if (error) {
        console.error("[corpus] insert failed", error);
        throw new Error("Some chunks could not be imported.");
      }
    }

    return { imported: rows.length };
  });

export const searchCorpusChunks = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ query: z.string().min(2).max(500) }).parse(input),
  )
  .handler(async ({ data }) => {
    const { retrieveContext } = await import("./retrieval.server");
    const result = await retrieveContext(data.query);
    return { citations: result.citations, grounding: result.grounding };
  });
