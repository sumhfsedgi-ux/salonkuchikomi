// 比較用: 変更前(master 7b74621)の loadActiveSurvey をそのまま写したもの。本番のコードからは使わない。
// 新しい読み取り(lib/reviewGeneration/validateAnswers.ts)と結果が同じかを確かめるためだけに置く。

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ActiveSurvey } from "@/lib/reviewGeneration/validateAnswers";

interface QuestionRow {
  id: string;
  question_text: string;
  question_type: "single" | "multiple" | "text";
  max_selections: number | null;
}

interface OptionRow {
  question_id: string;
  option_text: string;
}

/**
 * 店舗の有効なアンケートを読む(anon で読める範囲: salon_public ビューと公開中のアンケート)。
 * 店舗かアンケートが無ければ null。DB のエラーは投げる。
 */
export async function legacyLoadActiveSurvey(supabase: SupabaseClient, salonId: string): Promise<ActiveSurvey | null> {
  const { data: salon, error: salonError } = await supabase
    .from("salon_public")
    .select("id, name, business_type, description")
    .eq("id", salonId)
    .maybeSingle();
  if (salonError) throw salonError;
  if (!salon) return null;

  const { data: survey, error: surveyError } = await supabase
    .from("surveys")
    .select("id")
    .eq("salon_id", salonId)
    .eq("is_active", true)
    .maybeSingle();
  if (surveyError) throw surveyError;
  if (!survey) return null;

  const { data: questionRows, error: questionError } = await supabase
    .from("questions")
    .select("id, question_text, question_type, max_selections")
    .eq("survey_id", survey.id)
    .order("sort_order");
  if (questionError) throw questionError;
  const questions = (questionRows ?? []) as QuestionRow[];

  let options: OptionRow[] = [];
  if (questions.length > 0) {
    const { data: optionRows, error: optionError } = await supabase
      .from("question_options")
      .select("question_id, option_text")
      .in(
        "question_id",
        questions.map((q) => q.id),
      )
      .order("sort_order");
    if (optionError) throw optionError;
    options = (optionRows ?? []) as OptionRow[];
  }

  return {
    salonId: salon.id as string,
    salonName: salon.name as string,
    businessType: (salon.business_type as string | null) ?? null,
    description: (salon.description as string | null) ?? null,
    questions: questions.map((q) => ({
      id: q.id,
      text: q.question_text,
      type: q.question_type,
      options: options.filter((o) => o.question_id === q.id).map((o) => o.option_text),
      maxSelections: q.max_selections,
    })),
  };
}

