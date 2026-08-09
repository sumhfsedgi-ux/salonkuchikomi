"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSalon } from "@/lib/supabase/queries";

// Every action below re-resolves "my own salon" and "my own survey" from the
// authenticated session (never a client-supplied id), then scopes every
// mutation's WHERE clause by that survey id as a second, explicit check on
// top of RLS — not just relying on the database policies alone.

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

async function verifyQuestionInSurvey(
  supabase: SupabaseClient,
  questionId: string,
  surveyId: string,
): Promise<boolean> {
  const { data } = await supabase
    .from("questions")
    .select("id")
    .eq("id", questionId)
    .eq("survey_id", surveyId)
    .maybeSingle();
  return !!data;
}

async function verifyOptionAndGetQuestionId(
  supabase: SupabaseClient,
  optionId: string,
  surveyId: string,
): Promise<string | null> {
  const { data: option } = await supabase
    .from("question_options")
    .select("id, question_id")
    .eq("id", optionId)
    .maybeSingle();
  if (!option) return null;
  const ok = await verifyQuestionInSurvey(supabase, option.question_id, surveyId);
  return ok ? option.question_id : null;
}

const questionSchema = z.object({
  question_text: z.string().trim().min(1, "質問文を入力してください").max(200),
  question_type: z.enum(["single", "multiple", "text"]),
  required: z.boolean(),
  max_selections: z
    .union([z.string(), z.null()])
    .transform((v) => (v ? Number(v) : null))
    .pipe(z.number().int().min(1).max(10).nullable()),
});

function parseQuestionFormData(formData: FormData) {
  return questionSchema.safeParse({
    question_text: formData.get("question_text"),
    question_type: formData.get("question_type"),
    required: formData.get("required") === "on",
    max_selections: formData.get("max_selections"),
  });
}

export async function addQuestionAction(
  formData: FormData,
): Promise<{ error?: string }> {
  const supabase = await createClient();
  const salon = await getCurrentSalon(supabase);
  if (!salon) return { error: "店舗情報が見つかりません。" };
  const surveyId = await getCurrentSurveyId(supabase, salon.id);
  if (!surveyId) return { error: "アンケートが見つかりません。" };

  const parsed = parseQuestionFormData(formData);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "入力内容をご確認ください。" };
  }

  const { data: existing } = await supabase
    .from("questions")
    .select("sort_order")
    .eq("survey_id", surveyId)
    .order("sort_order", { ascending: false })
    .limit(1);
  const nextSortOrder = (existing?.[0]?.sort_order ?? 0) + 1;

  const { error } = await supabase.from("questions").insert({
    survey_id: surveyId,
    question_text: parsed.data.question_text,
    question_type: parsed.data.question_type,
    required: parsed.data.required,
    max_selections: parsed.data.question_type === "multiple" ? (parsed.data.max_selections ?? 3) : null,
    sort_order: nextSortOrder,
  });
  if (error) {
    console.error("addQuestionAction failed", error);
    return { error: "質問の追加に失敗しました。もう一度お試しください。" };
  }

  revalidatePath("/admin/survey");
  return {};
}

export async function updateQuestionAction(
  questionId: string,
  formData: FormData,
): Promise<{ error?: string }> {
  const supabase = await createClient();
  const salon = await getCurrentSalon(supabase);
  if (!salon) return { error: "店舗情報が見つかりません。" };
  const surveyId = await getCurrentSurveyId(supabase, salon.id);
  if (!surveyId) return { error: "アンケートが見つかりません。" };

  const parsed = parseQuestionFormData(formData);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "入力内容をご確認ください。" };
  }

  const { error } = await supabase
    .from("questions")
    .update({
      question_text: parsed.data.question_text,
      question_type: parsed.data.question_type,
      required: parsed.data.required,
      max_selections: parsed.data.question_type === "multiple" ? (parsed.data.max_selections ?? 3) : null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", questionId)
    .eq("survey_id", surveyId);
  if (error) {
    console.error("updateQuestionAction failed", error);
    return { error: "質問の更新に失敗しました。もう一度お試しください。" };
  }

  revalidatePath("/admin/survey");
  return {};
}

export async function deleteQuestionAction(
  questionId: string,
): Promise<{ error?: string }> {
  const supabase = await createClient();
  const salon = await getCurrentSalon(supabase);
  if (!salon) return { error: "店舗情報が見つかりません。" };
  const surveyId = await getCurrentSurveyId(supabase, salon.id);
  if (!surveyId) return { error: "アンケートが見つかりません。" };

  const { error } = await supabase
    .from("questions")
    .delete()
    .eq("id", questionId)
    .eq("survey_id", surveyId);
  if (error) {
    console.error("deleteQuestionAction failed", error);
    return { error: "質問の削除に失敗しました。もう一度お試しください。" };
  }

  revalidatePath("/admin/survey");
  return {};
}

export async function reorderQuestionAction(
  questionId: string,
  direction: "up" | "down",
): Promise<{ error?: string }> {
  const supabase = await createClient();
  const salon = await getCurrentSalon(supabase);
  if (!salon) return { error: "店舗情報が見つかりません。" };
  const surveyId = await getCurrentSurveyId(supabase, salon.id);
  if (!surveyId) return { error: "アンケートが見つかりません。" };

  const { data: questions } = await supabase
    .from("questions")
    .select("id, sort_order")
    .eq("survey_id", surveyId)
    .order("sort_order");
  if (!questions) return { error: "質問の取得に失敗しました。" };

  const index = questions.findIndex((q) => q.id === questionId);
  if (index === -1) return { error: "質問が見つかりません。" };
  const swapIndex = direction === "up" ? index - 1 : index + 1;
  if (swapIndex < 0 || swapIndex >= questions.length) return {};

  const a = questions[index];
  const b = questions[swapIndex];
  await supabase.from("questions").update({ sort_order: b.sort_order }).eq("id", a.id);
  await supabase.from("questions").update({ sort_order: a.sort_order }).eq("id", b.id);

  revalidatePath("/admin/survey");
  return {};
}

export async function addOptionAction(
  questionId: string,
  formData: FormData,
): Promise<{ error?: string }> {
  const supabase = await createClient();
  const salon = await getCurrentSalon(supabase);
  if (!salon) return { error: "店舗情報が見つかりません。" };
  const surveyId = await getCurrentSurveyId(supabase, salon.id);
  if (!surveyId) return { error: "アンケートが見つかりません。" };
  const ok = await verifyQuestionInSurvey(supabase, questionId, surveyId);
  if (!ok) return { error: "質問が見つかりません。" };

  const optionText = String(formData.get("option_text") ?? "").trim();
  if (!optionText) return { error: "選択肢を入力してください。" };
  if (optionText.length > 100) return { error: "選択肢は100文字以内で入力してください。" };

  const { data: existing } = await supabase
    .from("question_options")
    .select("sort_order")
    .eq("question_id", questionId)
    .order("sort_order", { ascending: false })
    .limit(1);
  const nextSortOrder = (existing?.[0]?.sort_order ?? 0) + 1;

  const { error } = await supabase
    .from("question_options")
    .insert({ question_id: questionId, option_text: optionText, sort_order: nextSortOrder });
  if (error) {
    console.error("addOptionAction failed", error);
    return { error: "選択肢の追加に失敗しました。もう一度お試しください。" };
  }

  revalidatePath("/admin/survey");
  return {};
}

export async function updateOptionAction(
  optionId: string,
  formData: FormData,
): Promise<{ error?: string }> {
  const supabase = await createClient();
  const salon = await getCurrentSalon(supabase);
  if (!salon) return { error: "店舗情報が見つかりません。" };
  const surveyId = await getCurrentSurveyId(supabase, salon.id);
  if (!surveyId) return { error: "アンケートが見つかりません。" };
  const questionId = await verifyOptionAndGetQuestionId(supabase, optionId, surveyId);
  if (!questionId) return { error: "選択肢が見つかりません。" };

  const optionText = String(formData.get("option_text") ?? "").trim();
  if (!optionText) return { error: "選択肢を入力してください。" };
  if (optionText.length > 100) return { error: "選択肢は100文字以内で入力してください。" };

  const { error } = await supabase
    .from("question_options")
    .update({ option_text: optionText, updated_at: new Date().toISOString() })
    .eq("id", optionId);
  if (error) {
    console.error("updateOptionAction failed", error);
    return { error: "選択肢の更新に失敗しました。もう一度お試しください。" };
  }

  revalidatePath("/admin/survey");
  return {};
}

export async function deleteOptionAction(
  optionId: string,
): Promise<{ error?: string }> {
  const supabase = await createClient();
  const salon = await getCurrentSalon(supabase);
  if (!salon) return { error: "店舗情報が見つかりません。" };
  const surveyId = await getCurrentSurveyId(supabase, salon.id);
  if (!surveyId) return { error: "アンケートが見つかりません。" };
  const questionId = await verifyOptionAndGetQuestionId(supabase, optionId, surveyId);
  if (!questionId) return { error: "選択肢が見つかりません。" };

  const { error } = await supabase.from("question_options").delete().eq("id", optionId);
  if (error) {
    console.error("deleteOptionAction failed", error);
    return { error: "選択肢の削除に失敗しました。もう一度お試しください。" };
  }

  revalidatePath("/admin/survey");
  return {};
}

export async function reorderOptionAction(
  optionId: string,
  direction: "up" | "down",
): Promise<{ error?: string }> {
  const supabase = await createClient();
  const salon = await getCurrentSalon(supabase);
  if (!salon) return { error: "店舗情報が見つかりません。" };
  const surveyId = await getCurrentSurveyId(supabase, salon.id);
  if (!surveyId) return { error: "アンケートが見つかりません。" };
  const questionId = await verifyOptionAndGetQuestionId(supabase, optionId, surveyId);
  if (!questionId) return { error: "選択肢が見つかりません。" };

  const { data: options } = await supabase
    .from("question_options")
    .select("id, sort_order")
    .eq("question_id", questionId)
    .order("sort_order");
  if (!options) return { error: "選択肢の取得に失敗しました。" };

  const index = options.findIndex((o) => o.id === optionId);
  if (index === -1) return { error: "選択肢が見つかりません。" };
  const swapIndex = direction === "up" ? index - 1 : index + 1;
  if (swapIndex < 0 || swapIndex >= options.length) return {};

  const a = options[index];
  const b = options[swapIndex];
  await supabase.from("question_options").update({ sort_order: b.sort_order }).eq("id", a.id);
  await supabase.from("question_options").update({ sort_order: a.sort_order }).eq("id", b.id);

  revalidatePath("/admin/survey");
  return {};
}
