import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { supabaseAdmin } from "@/integrations/supabase/client.server";

export type Matter = {
  id: string;
  title: string;
  category: string | null;
  description: string | null;
  notes: string | null;
  createdAt: string;
};

const SessionInput = z.object({ sessionId: z.string().min(1) });

export const listMatters = createServerFn({ method: "GET" })
  .inputValidator((input: unknown) => SessionInput.parse(input))
  .handler(async ({ data }): Promise<Matter[]> => {
    const { data: rows, error } = await supabaseAdmin
      .from("matters")
      .select("id, title, category, description, notes, created_at")
      .eq("session_id", data.sessionId)
      .order("created_at", { ascending: false });
    if (error) throw new Error("Could not load your case files.");
    return (rows ?? []).map((row) => ({
      id: row.id,
      title: row.title,
      category: row.category,
      description: row.description,
      notes: row.notes,
      createdAt: row.created_at,
    }));
  });

export const saveMatter = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    SessionInput.extend({
      id: z.string().uuid().nullable().optional(),
      title: z.string().min(1).max(200),
      category: z.string().max(80).nullable().optional(),
      description: z.string().max(6000).nullable().optional(),
      notes: z.string().max(12000).nullable().optional(),
    }).parse(input),
  )
  .handler(async ({ data }) => {
    const payload = {
      session_id: data.sessionId,
      title: data.title,
      category: data.category ?? null,
      description: data.description ?? null,
      notes: data.notes ?? null,
      updated_at: new Date().toISOString(),
    };

    if (data.id) {
      const { error } = await supabaseAdmin
        .from("matters")
        .update(payload)
        .eq("id", data.id)
        .eq("session_id", data.sessionId);
      if (error) throw new Error("Could not save the case file.");
      return { id: data.id };
    }

    const { data: row, error } = await supabaseAdmin
      .from("matters")
      .insert(payload)
      .select("id")
      .single();
    if (error || !row) throw new Error("Could not create the case file.");
    return { id: row.id };
  });

export const deleteMatter = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    SessionInput.extend({ id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }) => {
    await supabaseAdmin
      .from("matters")
      .delete()
      .eq("id", data.id)
      .eq("session_id", data.sessionId);
    return { ok: true };
  });
