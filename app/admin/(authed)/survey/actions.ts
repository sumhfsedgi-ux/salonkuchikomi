"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSalon } from "@/lib/supabase/queries";

// Every action below re-resolves "my own salon" and "my own survey" from the
// authenticated session (never a client-supplied id), then scopes every
// mutation by that survey id as a second, explicit check on top of RLS — not
// just relying on the database policies alone.

async function getCurrentSurveyId(
  supabase: SupabaseClient,
  salonId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from("surveys")
    .select("id")
    .eq("salon_id", salonId)
    .eq("is_active", true)
    .maybeSingle();
  return data?.id ?? null;
}

export async function restartSurveyAction(
  templateId: string | null,
): Promise<{ error?: string }> {
  const supabase = await createClient();
  const salon = await getCurrentSalon(supabase);
  if (!salon) return { error: "店舗情報が見つかりません。" };

  const { error } = await supabase.rpc("restart_survey_from_template", {
    p_salon_id: salon.id,
    p_template_id: templateId,
  });

  if (error) {
    console.error("restartSurveyAction failed", error);
    return { error: "アンケートの作り直しに失敗しました。もう一度お試しください。" };
  }

  revalidatePath("/admin");
  revalidatePath("/admin/survey");
  return {};
}

const saveOptionSchema = z.object({
  option_text: z.string().trim().min(1, "選択肢を入力してください").max(100),
});

const saveQuestionSchema = z
  .object({
    question_text: z.string().trim().min(1, "質問文を入力してください").max(200),
    question_type: z.enum(["single", "multiple", "text"]),
    required: z.boolean(),
    max_selections: z.number().int().min(1).max(10).nullable(),
    options: z.array(saveOptionSchema).max(20),
  })
  .refine((q) => q.question_type === "text" || q.options.length > 0, {
    message: "選択肢を1つ以上追加してください。",
  });

const saveSurveySchema = z.array(saveQuestionSchema).max(50);

export type SaveSurveyQuestionInput = z.input<typeof saveQuestionSchema>;

// Replaces the whole question/option tree for the owner's active survey in
// a single call (see supabase/migrations/0007_save_survey_questions.sql).
// The question editor keeps every add/delete/reorder/edit as local-only
// state and only calls this once, when the owner presses "変更を保存" --
// each of those interactions used to be its own round trip to the database.
export async function saveSurveyAction(
  questions: SaveSurveyQuestionInput[],
): Promise<{ error?: string }> {
  const supabase = await createClient();
  const salon = await getCurrentSalon(supabase);
  if (!salon) return { error: "店舗情報が見つかりません。" };
  const surveyId = await getCurrentSurveyId(supabase, salon.id);
  if (!surveyId) return { error: "アンケートが見つかりません。" };

  const parsed = saveSurveySchema.safeParse(questions);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "入力内容をご確認ください。" };
  }

  const payload = parsed.data.map((q) => ({
    question_text: q.question_text,
    question_type: q.question_type,
    required: q.required,
    max_selections: q.question_type === "multiple" ? (q.max_selections ?? 3) : null,
    options: q.question_type === "text" ? [] : q.options,
  }));

  const { error } = await supabase.rpc("save_survey_questions", {
    p_survey_id: surveyId,
    p_questions: payload,
  });

  if (error) {
    console.error("saveSurveyAction failed", error);
    return { error: "保存に失敗しました。もう一度お試しください。" };
  }

  revalidatePath("/admin/survey");
  return {};
}
